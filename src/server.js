import http from 'node:http';
import { URL } from 'node:url';
import { createPool } from './db.js';
import {
  listDocuments,
  ownerExists,
  recentDocumentsForOwner,
  tagStats,
  documentsWithAllTags,
  inactiveOwners,
} from './repository.js';
import { buildIndex, rankDocuments } from './ranker.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const MAX_TAGS = 10;
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
export function createServer({ index, db }) {
  async function handle(req, res, url) {
    const path = url.pathname;

    if (path === '/search') {
      const q = url.searchParams.get('q');
      if (!q || !q.trim()) {
        return sendJson(res, 400, { error: 'query parameter "q" is required' });
      }
      const { limit, offset } = parsePagination(url.searchParams);
      const allMatches = rankDocuments(q, index);
      return sendJson(res, 200, {
        query: q,
        total: allMatches.length,
        limit,
        offset,
        results: allMatches.slice(offset, offset + limit),
      });
    }

    if (path === '/owners/inactive') {
      return sendJson(res, 200, { results: await inactiveOwners(db) });
    }

    const ownerDocs = path.match(/^\/owners\/([^/]+)\/documents$/);
    if (ownerDocs) {
      const ownerId = decodeURIComponent(ownerDocs[1]);
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
      const results = await documentsWithAllTags(db, tags);
      return sendJson(res, 200, { tags, total: results.length, results });
    }

    return sendJson(res, 404, { error: 'not found' });
  }

  return http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    if (req.method !== 'GET') {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    handle(req, res, url).catch((err) => {
      console.error(err);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal server error' });
    });
  });
}

async function main() {
  const pool = createPool();
  const documents = await listDocuments(pool);
  const index = buildIndex(documents);
  const server = createServer({ index, db: pool });
  server.listen(PORT, () => {
    console.log(`document search service listening on port ${PORT}`);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
