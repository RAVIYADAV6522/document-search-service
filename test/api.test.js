// End-to-end tests for the SQL-backed routes, run against a real
// PostgreSQL. Each run migrates and seeds a throwaway schema (dropped
// afterwards), so it never touches the data in the configured database.
// Skipped when DATABASE_URL isn't set.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { migrate } from '../scripts/migrate.js';
import { seed } from '../scripts/seed.js';
import { createServer } from '../src/server.js';
import { buildIndex } from '../src/ranker.js';
import { listDocuments } from '../src/repository.js';

const skip = process.env.DATABASE_URL ? false : 'DATABASE_URL not set';
const schema = `test_${process.pid}_${Date.now()}`;

// own-1 has 12 documents (one more than the 10 the owner route returns),
// own-3 has none. doc-01 and doc-02 carry both finance and q4.
const owners = [
  { id: 'own-1', name: 'One', email: 'one@example.com' },
  { id: 'own-2', name: 'Two', email: 'two@example.com' },
  { id: 'own-3', name: 'Three', email: 'three@example.com' },
];
const documents = [
  { id: 'doc-01', title: 'Q4 Budget', body: 'finance budget', owner: 'own-2', tags: ['finance', 'q4'], created: '2025-12-01T00:00:00Z' },
  { id: 'doc-02', title: 'Q4 Forecast', body: 'finance forecast', owner: 'own-1', tags: ['finance', 'q4', 'forecast'], created: '2025-11-01T00:00:00Z' },
  { id: 'doc-03', title: 'Q3 Budget', body: 'finance budget', owner: 'own-1', tags: ['finance', 'q3'], created: '2025-08-01T00:00:00Z' },
  ...Array.from({ length: 10 }, (_, i) => ({
    id: `doc-${String(i + 10)}`,
    title: `Engineering note ${i}`,
    body: 'search ranking notes',
    owner: 'own-1',
    tags: ['engineering'],
    created: `2024-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
  })),
];

let pool;
let server;
let base;

before(async () => {
  if (skip) return;
  const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();

  // public stays on the path for extension types (pgvector's vector).
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, options: `-c search_path=${schema},public` });
  await migrate(pool);
  await seed(pool, { owners, documents });

  server = createServer({ index: buildIndex(await listDocuments(pool)), db: pool });
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://localhost:${server.address().port}`;
});

after(async () => {
  if (skip) return;
  server.close();
  await pool.query(`DROP SCHEMA ${schema} CASCADE`);
  await pool.end();
});

const get = async (path) => {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: await res.json() };
};

test('GET /owners/:id/documents returns the 10 most recent, newest first', { skip }, async () => {
  const { status, body } = await get('/owners/own-1/documents');
  assert.equal(status, 200);
  assert.equal(body.results.length, 10);
  assert.equal(body.results[0].id, 'doc-02');
  assert.equal(body.results[1].id, 'doc-03');
  assert.ok(body.results.every((d) => d.owner === 'own-1'));
  assert.ok(!body.results.some((d) => d.id === 'doc-10'), 'oldest document should be cut off');
});

test('GET /owners/:id/documents for an unknown owner returns 404', { skip }, async () => {
  const { status } = await get('/owners/own-404/documents');
  assert.equal(status, 404);
});

test('GET /owners/:id/documents for an owner with no documents returns an empty list', { skip }, async () => {
  const { status, body } = await get('/owners/own-3/documents');
  assert.equal(status, 200);
  assert.deepEqual(body.results, []);
});

test('GET /tags/stats counts documents per tag, most common first', { skip }, async () => {
  const { status, body } = await get('/tags/stats');
  assert.equal(status, 200);
  assert.deepEqual(body.results.slice(0, 3), [
    { tag: 'engineering', document_count: 10 },
    { tag: 'finance', document_count: 3 },
    { tag: 'q4', document_count: 2 },
  ]);
});

test('GET /documents?tags= returns only documents with every tag', { skip }, async () => {
  const { status, body } = await get('/documents?tags=finance,q4');
  assert.equal(status, 200);
  assert.deepEqual(body.results.map((d) => d.id), ['doc-01', 'doc-02']);
  assert.equal(body.total, 2);
});

test('GET /documents?tags= ignores duplicate tags and casing', { skip }, async () => {
  const { body } = await get('/documents?tags=Finance,q4,finance');
  assert.deepEqual(body.tags, ['finance', 'q4']);
  assert.deepEqual(body.results.map((d) => d.id), ['doc-01', 'doc-02']);
});

test('GET /documents?tags= with an unknown tag matches nothing', { skip }, async () => {
  const { body } = await get('/documents?tags=finance,nope');
  assert.deepEqual(body.results, []);
});

test('GET /documents without tags returns 400', { skip }, async () => {
  const { status } = await get('/documents');
  assert.equal(status, 400);
});

test('GET /owners/inactive lists owners with no documents', { skip }, async () => {
  const { status, body } = await get('/owners/inactive');
  assert.equal(status, 200);
  assert.deepEqual(body.results, [{ id: 'own-3', name: 'Three', email: 'three@example.com' }]);
});

test('GET /search reads documents loaded from the database', { skip }, async () => {
  const { status, body } = await get('/search?q=forecast');
  assert.equal(status, 200);
  assert.equal(body.results[0].id, 'doc-02');
});

test('GET /search?engine=sql matches different forms of a word (stemming)', { skip }, async () => {
  // Documents say "budget" and "forecast"; the query says "budgets" and "forecasting".
  const { status, body } = await get('/search?q=budgets&engine=sql');
  assert.equal(status, 200);
  assert.equal(body.engine, 'sql');
  assert.deepEqual(body.results.map((d) => d.id).sort(), ['doc-01', 'doc-03']);
  const forecast = await get('/search?q=forecasting&engine=sql');
  assert.deepEqual(forecast.body.results.map((d) => d.id), ['doc-02']);
});

test('GET /search?engine=sql ranks title matches above body-only matches', { skip }, async () => {
  // "engineering" is in the title of doc-10..19 but in no body; "ranking"
  // is only in their body. A title hit should outrank a body hit.
  const title = await get('/search?q=engineering&engine=sql');
  const bodyOnly = await get('/search?q=ranking&engine=sql');
  assert.ok(title.body.results[0].score > bodyOnly.body.results[0].score);
});

test('GET /search?engine=sql paginates and reports the full total', { skip }, async () => {
  const { body } = await get('/search?q=engineering&engine=sql&limit=3&offset=9');
  assert.equal(body.total, 10);
  assert.equal(body.results.length, 1);
});

test('GET /search?engine=sql with only stop words matches nothing instead of erroring', { skip }, async () => {
  const { status, body } = await get('/search?q=the&engine=sql');
  assert.equal(status, 200);
  assert.equal(body.total, 0);
});

test('full-text search is answered by the GIN index', { skip }, async () => {
  // With a dozen rows the planner rightly prefers a sequential scan, so
  // turn that off to check the index *can* serve the query.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL enable_seqscan = off');
    const { rows } = await client.query(
      `EXPLAIN SELECT id FROM documents WHERE search_vector @@ websearch_to_tsquery('english', 'budget')`,
    );
    await client.query('ROLLBACK');
    assert.match(rows.map((r) => r['QUERY PLAN']).join('\n'), /idx_documents_search/);
  } finally {
    client.release();
  }
});

test('GET /documents?tags= paginates and reports the full total', { skip }, async () => {
  const first = await get('/documents?tags=engineering&limit=4');
  assert.equal(first.body.total, 10);
  assert.equal(first.body.results.length, 4);
  const last = await get('/documents?tags=engineering&limit=4&offset=8');
  assert.equal(last.body.total, 10);
  assert.equal(last.body.results.length, 2);
  const ids = [...first.body.results, ...last.body.results].map((d) => d.id);
  assert.equal(new Set(ids).size, ids.length, 'pages must not overlap');
});
