import http from 'node:http';
import { URL } from 'node:url';
import { createPool } from './db.js';
import { listDocuments } from './repository.js';
import { buildIndex, rankDocuments } from './ranker.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
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

// Takes an already-built ranking index (see ranker.js) rather than loading
// documents itself, so tests can construct a server around a small fixture
// index without touching the filesystem.
export function createServer(index) {
  return http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

    if (req.method !== 'GET' || url.pathname !== '/search') {
      sendJson(res, 404, { error: 'not found' });
      return;
    }

    const q = url.searchParams.get('q');
    if (!q || !q.trim()) {
      sendJson(res, 400, { error: 'query parameter "q" is required' });
      return;
    }

    const { limit, offset } = parsePagination(url.searchParams);
    const allMatches = rankDocuments(q, index);
    const results = allMatches.slice(offset, offset + limit);

    sendJson(res, 200, {
      query: q,
      total: allMatches.length,
      limit,
      offset,
      results,
    });
  });
}

async function main() {
  const pool = createPool();
  const documents = await listDocuments(pool);
  const index = buildIndex(documents);
  const server = createServer(index);
  server.listen(PORT, () => {
    console.log(`document search service listening on port ${PORT}`);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
