import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';
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

const server = createServer(buildIndex(fixtures));
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
