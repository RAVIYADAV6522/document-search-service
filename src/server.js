import http from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { URL, fileURLToPath } from 'node:url';
import { createPool } from './db.js';
import {
  listDocuments,
  ownerExists,
  recentDocumentsForOwner,
  tagStats,
  documentsWithAllTags,
  inactiveOwners,
  searchFullText,
  searchSemantic,
} from './repository.js';
import { buildIndex, rankDocuments } from './ranker.js';
import { createGemini } from './gemini.js';
import { embed, toPgVector } from './embeddings.js';
import { reciprocalRankFusion } from './hybrid.js';
import { createRateLimiter } from './rate-limit.js';
import { answerQuestion, ASK_SOURCES } from './ask.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const MAX_TAGS = 10;
const ENGINES = ['cosine', 'sql', 'semantic', 'hybrid'];
const AI_ENGINES = new Set(['semantic', 'hybrid']);
const MAX_QUERY_LENGTH = 500;
// Semantic and hybrid rank the closest CANDIDATES documents and page within
// them: every document is "similar" to some degree, so there is no natural
// total the way there is for keyword matches.
const CANDIDATES = 100;
const MAX_BODY_BYTES = 4096;
const QUERY_CACHE_SIZE = 500;
const SHUTDOWN_TIMEOUT_MS = 10_000;

// The search page. A fixed map from URL to file, read once at startup, so a
// request path is never turned into a filesystem path.
const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const STATIC_FILES = new Map(
  [
    ['/', 'index.html', 'text/html; charset=utf-8'],
    ['/app.js', 'app.js', 'text/javascript; charset=utf-8'],
    ['/styles.css', 'styles.css', 'text/css; charset=utf-8'],
  ].map(([path, file, type]) => [path, { body: readFileSync(join(PUBLIC_DIR, file)), type }]),
);
// The page only loads its own scripts and styles and calls its own API.
const PAGE_CSP =
  "default-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

function sendJson(res, statusCode, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    // Read-only public API: any site may call it, and browsers shouldn't
    // try to reinterpret the JSON as something else.
    'Access-Control-Allow-Origin': '*',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(payload);
}

function sendStatic(res, { body, type }) {
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': body.length,
    'Content-Security-Policy': PAGE_CSP,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-cache',
  });
  res.end(body);
}

// Reads a small JSON request body, rejecting anything larger than limit.
async function readJson(req, limit = MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'request body too large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'request body must be JSON');
  }
}

// The client's address. Render's proxy puts it first in X-Forwarded-For.
function clientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
}

// Thrown for bad input found deep in a handler, so the error handler can
// answer with that status instead of a 500.
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Reads PORT, rejecting anything that isn't a valid port number instead of
// silently listening somewhere unexpected (Number('abc') is NaN).
export function readPort(raw = process.env.PORT) {
  if (raw === undefined || raw === '') return 3000;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`PORT must be an integer between 0 and 65535, got "${raw}"`);
  }
  return port;
}

// Parses limit/offset query params into non-negative integers, falling back
// to defaults for anything missing or non-numeric rather than rejecting the
// request, and clamping limit to MAX_LIMIT so a caller can't force an
// unbounded response (e.g. limit=10000). See NOTES.md for the reasoning.
function parsePagination(searchParams) {
  let limit = Number.parseInt(searchParams.get('limit'), 10);
  if (!Number.isInteger(limit) || limit <= 0) limit = DEFAULT_LIMIT;
  limit = Math.min(limit, MAX_LIMIT);

  let offset = Number.parseInt(searchParams.get('offset'), 10);
  if (!Number.isInteger(offset) || offset < 0) offset = 0;

  return { limit, offset };
}

// Splits ?tags=finance,q4 into a de-duplicated, lowercased list. Duplicates
// are removed because documentsWithAllTags matches on the tag count.
function parseTags(raw) {
  if (!raw) return [];
  return [...new Set(raw.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean))];
}

// Takes its dependencies rather than creating them, so tests can construct a
// server around a small fixture index (and, for the SQL routes, a test
// database) without touching the real one.
//   index: built by buildIndex(), used by /search
//   db:    a pg Pool (or anything with .query), used by the SQL routes
//   embedder: turns texts into vectors (embeddings.js), for semantic search
//   ai:    a Gemini client (gemini.js) for /ask, or null to turn /ask off
//   limits: per-client rate limits for the AI routes
//   log:   called once per request with a summary object
export function createServer({
  index,
  db,
  embedder = embed,
  ai = null,
  limits = { searchPerMinute: 30, askPerMinute: 5, aiPerDay: 1500 },
  log = () => {},
}) {
  const searchLimiter = createRateLimiter({ limit: limits.searchPerMinute, windowMs: 60_000 });
  const askLimiter = createRateLimiter({ limit: limits.askPerMinute, windowMs: 60_000 });
  // One shared bucket: the whole server's Gemini calls per day, so the
  // free quota can't be spent by many clients at once.
  const dailyLimiter = createRateLimiter({ limit: limits.aiPerDay, windowMs: 86_400_000 });

  // Repeated queries (the suggestion chips, compare mode, paging) reuse the
  // query's embedding instead of running the model again.
  const queryVectors = new Map();
  async function embedQuery(q) {
    const key = q.trim().toLowerCase();
    if (queryVectors.has(key)) return queryVectors.get(key);
    const [values] = await embedder([key]);
    const vector = toPgVector(values);
    if (queryVectors.size >= QUERY_CACHE_SIZE) queryVectors.delete(queryVectors.keys().next().value);
    queryVectors.set(key, vector);
    return vector;
  }

  // Keyword matches and meaning matches, fused by rank (hybrid.js).
  async function hybridSearch(q) {
    const [keyword, semantic] = await Promise.all([
      searchFullText(db, q, { limit: CANDIDATES, offset: 0 }),
      searchSemantic(db, await embedQuery(q), { candidates: CANDIDATES }),
    ]);
    return reciprocalRankFusion([keyword.results, semantic]);
  }

  async function handle(req, res, url) {
    const path = url.pathname;

    if (req.method === 'POST') {
      if (path !== '/ask') {
        return sendJson(res, 405, { error: 'method not allowed' }, { Allow: 'GET, HEAD' });
      }
      return handleAsk(req, res);
    }

    const file = STATIC_FILES.get(path);
    if (file) return sendStatic(res, file);

    // Used by the host's health check: healthy only if the database answers.
    if (path === '/healthz') {
      try {
        await db.query('SELECT 1');
      } catch {
        return sendJson(res, 503, { status: 'error', database: 'unreachable' });
      }
      return sendJson(res, 200, {
        status: 'ok',
        database: 'ok',
        documents: index.length,
        commit: process.env.RENDER_GIT_COMMIT ?? null,
      });
    }

    if (path === '/search') {
      const q = url.searchParams.get('q');
      if (!q || !q.trim()) {
        return sendJson(res, 400, { error: 'query parameter "q" is required' });
      }
      if (q.length > MAX_QUERY_LENGTH) {
        return sendJson(res, 400, { error: `query must be at most ${MAX_QUERY_LENGTH} characters` });
      }
      const engine = url.searchParams.get('engine') ?? 'cosine';
      if (!ENGINES.includes(engine)) {
        return sendJson(res, 400, { error: `engine must be one of: ${ENGINES.join(', ')}` });
      }
      const { limit, offset } = parsePagination(url.searchParams);
      if (AI_ENGINES.has(engine)) {
        if (!searchLimiter(clientIp(req))) {
          return sendJson(res, 429, { error: 'too many semantic searches, wait a minute' }, { 'Retry-After': '60' });
        }
      }

      // cosine: the from-scratch in-memory ranker (ranker.js).
      // sql: Postgres full-text search (repository.js, migration 002).
      let total;
      let results;
      if (engine === 'sql') {
        ({ total, results } = await searchFullText(db, q, { limit, offset }));
      } else if (AI_ENGINES.has(engine)) {
        // semantic: nearest embeddings in pgvector (repository.js, migration 003).
        // hybrid: sql and semantic merged with Reciprocal Rank Fusion.
        const ranked =
          engine === 'semantic'
            ? await searchSemantic(db, await embedQuery(q), { candidates: CANDIDATES })
            : await hybridSearch(q);
        total = ranked.length;
        results = ranked.slice(offset, offset + limit);
      } else {
        const allMatches = rankDocuments(q, index);
        total = allMatches.length;
        results = allMatches.slice(offset, offset + limit);
      }
      return sendJson(res, 200, { query: q, engine, total, limit, offset, results });
    }

    if (path === '/owners/inactive') {
      return sendJson(res, 200, { results: await inactiveOwners(db) });
    }

    const ownerDocs = path.match(/^\/owners\/([^/]+)\/documents$/);
    if (ownerDocs) {
      let ownerId;
      try {
        ownerId = decodeURIComponent(ownerDocs[1]);
      } catch {
        throw new HttpError(400, 'malformed owner id');
      }
      if (!(await ownerExists(db, ownerId))) {
        return sendJson(res, 404, { error: `owner "${ownerId}" not found` });
      }
      return sendJson(res, 200, { owner: ownerId, results: await recentDocumentsForOwner(db, ownerId) });
    }

    if (path === '/tags/stats') {
      return sendJson(res, 200, { results: await tagStats(db) });
    }

    if (path === '/documents') {
      const tags = parseTags(url.searchParams.get('tags'));
      if (tags.length === 0) {
        return sendJson(res, 400, { error: 'query parameter "tags" is required, e.g. ?tags=finance,q4' });
      }
      if (tags.length > MAX_TAGS) {
        return sendJson(res, 400, { error: `at most ${MAX_TAGS} tags are allowed` });
      }
      const { limit, offset } = parsePagination(url.searchParams);
      const { total, results } = await documentsWithAllTags(db, tags, { limit, offset });
      return sendJson(res, 200, { tags, total, limit, offset, results });
    }

    return sendJson(res, 404, { error: 'not found' });
  }

  // POST /ask {"question": "..."}: retrieval-augmented generation (ask.js).
  // The top hybrid results are the only context the model gets.
  async function handleAsk(req, res) {
    if (!ai) return sendJson(res, 503, { error: 'AI answers are not configured on this server' });
    const { question } = await readJson(req);
    if (typeof question !== 'string' || !question.trim()) {
      return sendJson(res, 400, { error: '"question" is required' });
    }
    if (question.length > MAX_QUERY_LENGTH) {
      return sendJson(res, 400, { error: `question must be at most ${MAX_QUERY_LENGTH} characters` });
    }
    if (!askLimiter(clientIp(req))) {
      return sendJson(res, 429, { error: 'too many questions, wait a minute' }, { 'Retry-After': '60' });
    }
    const sources = (await hybridSearch(question)).slice(0, ASK_SOURCES);
    if (!dailyLimiter('global')) throw new HttpError(503, 'daily AI quota reached, try again tomorrow');
    const { answer, model, cited } = await answerQuestion(ai, question, sources);
    return sendJson(res, 200, { question, answer, cited, model, sources });
  }

  return http.createServer((req, res) => {
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      log({
        method: req.method,
        path: req.url,
        status: res.statusCode,
        ms: Number((process.hrtime.bigint() - started) / 1_000_000n),
      });
    });

    // A fixed base rather than the Host header: only the path and query
    // matter, and a malformed Host would otherwise make new URL() throw.
    const url = new URL(req.url, 'http://localhost');
    // HEAD is answered like GET (Node drops the body); uptime monitors use it.
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'POST') {
      sendJson(res, 405, { error: 'method not allowed' }, { Allow: 'GET, HEAD' });
      return;
    }
    handle(req, res, url).catch((err) => {
      if (res.headersSent) return;
      if (err instanceof HttpError) {
        sendJson(res, err.status, { error: err.message });
        return;
      }
      // Gemini being down or rate limited is reported as such, not as our bug.
      if (err.name === 'GeminiError' || err.name === 'TimeoutError') {
        console.error(JSON.stringify({ level: 'error', path: url.pathname, error: `gemini: ${err.message}` }));
        sendJson(res, 503, { error: 'the AI service is busy, please try again in a moment' });
        return;
      }
      // Log the real error, but never send database details to the client.
      console.error(JSON.stringify({ level: 'error', path: url.pathname, error: err.message }));
      sendJson(res, 500, { error: 'internal server error' });
    });
  });
}

async function main() {
  const port = readPort();
  const pool = createPool();
  const index = buildIndex(await listDocuments(pool));
  const ai = createGemini();
  if (!ai) console.log('GEMINI_API_KEY not set: /ask is disabled');
  const server = createServer({
    index,
    db: pool,
    ai,
    log: (entry) => console.log(JSON.stringify(entry)),
  });
  server.listen(port, () => {
    console.log(`document search service listening on port ${port} (${index.length} documents)`);
    // Load the embedding model now rather than on the first semantic query.
    embed(['warm up']).catch((err) => console.error(`embedding model failed to load: ${err.message}`));
  });

  // The host sends SIGTERM before replacing an instance: stop accepting new
  // connections, let in-flight requests finish, then close the pool. If that
  // takes too long, exit anyway rather than hang the deploy.
  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received, shutting down`);
    setTimeout(() => {
      console.error('shutdown timed out, exiting');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS).unref();
    server.close(async () => {
      await pool.end();
      process.exit(0);
    });
    server.closeIdleConnections();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`failed to start: ${err.message || err.code || err}`);
    process.exit(1);
  });
}
