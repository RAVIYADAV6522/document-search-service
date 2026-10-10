import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, readPort } from '../src/server.js';
import { buildIndex } from '../src/ranker.js';

const fixtures = [
  {
    id: 'doc-a',
    title: 'Search Ranking',
    body: 'search ranking algorithm',
    owner: 'own-1',
    tags: ['engineering'],
    created: '2025-01-01T00:00:00Z',
  },
  {
    id: 'doc-b',
    title: 'Finance Report',
    body: 'quarterly finance budget',
    owner: 'own-1',
    tags: ['finance'],
    created: '2025-06-01T00:00:00Z',
  },
];

const server = createServer({ index: buildIndex(fixtures) });
await new Promise((resolve) => server.listen(0, resolve));
const { port } = server.address();
const base = `http://localhost:${port}`;

after(() => server.close());

test('GET /search returns ranked matches with a total count', async () => {
  const res = await fetch(`${base}/search?q=search%20ranking`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.query, 'search ranking');
  assert.equal(body.total, 1);
  assert.equal(body.results.length, 1);
  assert.equal(body.results[0].id, 'doc-a');
});

test('GET /search with a missing q returns 400', async () => {
  const res = await fetch(`${base}/search`);
  assert.equal(res.status, 400);
});

test('GET /search with a non-numeric limit falls back to the default instead of erroring', async () => {
  const res = await fetch(`${base}/search?q=finance&limit=notanumber`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.limit, 20);
});

test('GET /search with limit=10000 is clamped to the maximum page size', async () => {
  const res = await fetch(`${base}/search?q=finance&limit=10000`);
  const body = await res.json();
  assert.equal(body.limit, 100);
});

test('unknown routes return 404', async () => {
  const res = await fetch(`${base}/nope`);
  assert.equal(res.status, 404);
});

test('GET /search defaults to the cosine engine', async () => {
  const res = await fetch(`${base}/search?q=finance`);
  const body = await res.json();
  assert.equal(body.engine, 'cosine');
});

test('GET /search with an unknown engine returns 400', async () => {
  const res = await fetch(`${base}/search?q=finance&engine=elastic`);
  assert.equal(res.status, 400);
});

// Servers around fake databases, for behaviour that doesn't need real SQL.
async function startWith(db) {
  const srv = createServer({ index: buildIndex(fixtures), db });
  await new Promise((resolve) => srv.listen(0, resolve));
  after(() => srv.close());
  return `http://localhost:${srv.address().port}`;
}
const healthyDb = { query: async () => ({ rows: [{}], rowCount: 1 }) };
const brokenDb = {
  query: async () => {
    throw new Error('connection to server at "secret-host.neon.tech" failed');
  },
};

test('GET /healthz returns 200 when the database answers', async () => {
  const res = await fetch(`${await startWith(healthyDb)}/healthz`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.documents, 2);
});

test('GET /healthz returns 503 when the database is down', async () => {
  const res = await fetch(`${await startWith(brokenDb)}/healthz`);
  assert.equal(res.status, 503);
});

test('a database error returns 500 without leaking its details', async () => {
  const res = await fetch(`${await startWith(brokenDb)}/tags/stats`);
  assert.equal(res.status, 500);
  const text = await res.text();
  assert.ok(!text.includes('secret-host'), 'error details must not reach the client');
});

test('non-GET requests return 405 with an Allow header', async () => {
  const res = await fetch(`${base}/search?q=x`, { method: 'POST' });
  assert.equal(res.status, 405);
  assert.equal(res.headers.get('allow'), 'GET');
});

test('responses allow cross-origin reads', async () => {
  const res = await fetch(`${base}/search?q=finance`);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
});

test('GET /search with an overly long query returns 400', async () => {
  const res = await fetch(`${base}/search?q=${'a'.repeat(501)}`);
  assert.equal(res.status, 400);
});

test('a malformed percent-encoded owner id returns 400, not 500', async () => {
  const res = await fetch(`${await startWith(healthyDb)}/owners/%E0%A4/documents`);
  assert.equal(res.status, 400);
});

test('readPort defaults to 3000 and rejects invalid values', () => {
  assert.equal(readPort(undefined), 3000);
  assert.equal(readPort('8080'), 8080);
  assert.throws(() => readPort('abc'), /PORT must be/);
  assert.throws(() => readPort('70000'), /PORT must be/);
});

test('GET / serves the search page with a content security policy', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  assert.match(await res.text(), /<title>Document Search<\/title>/);
});

test('the page script and stylesheet are served with the right types', async () => {
  const js = await fetch(`${base}/app.js`);
  const css = await fetch(`${base}/styles.css`);
  assert.match(js.headers.get('content-type'), /text\/javascript/);
  assert.match(css.headers.get('content-type'), /text\/css/);
});

test('only the listed static files are served, not arbitrary paths', async () => {
  for (const path of ['/index.html', '/../package.json', '/%2e%2e/package.json', '/public/app.js']) {
    const res = await fetch(`${base}${path}`);
    assert.equal(res.status, 404, path);
  }
});
