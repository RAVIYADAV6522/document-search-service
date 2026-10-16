// Tests for semantic search, hybrid search and /ask. The embedding model is
// replaced by a hashed bag of words, so similar texts get similar vectors
// without loading the model, and Gemini by a fake that records its prompts. The route tests
// need PostgreSQL with pgvector and are skipped when DATABASE_URL isn't set.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { migrate } from '../scripts/migrate.js';
import { seed } from '../scripts/seed.js';
import { createServer } from '../src/server.js';
import { buildIndex } from '../src/ranker.js';
import { listDocuments, saveEmbeddings } from '../src/repository.js';
import { EMBEDDING_DIMENSIONS, toPgVector } from '../src/embeddings.js';
import { createGemini } from '../src/gemini.js';
import { reciprocalRankFusion } from '../src/hybrid.js';
import { createRateLimiter } from '../src/rate-limit.js';
import { buildPrompt, citedIds } from '../src/ask.js';

function fakeEmbedding(text) {
  const v = new Array(EMBEDDING_DIMENSIONS).fill(0);
  for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let h = 0;
    for (const c of word) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    v[h % EMBEDDING_DIMENSIONS] += 1;
  }
  v[0] += 0.01; // never all zeros: cosine distance is undefined for a zero vector
  return v;
}

function fakeEmbedder() {
  const fn = async (texts) => {
    fn.calls += 1;
    return texts.map(fakeEmbedding);
  };
  fn.calls = 0;
  return fn;
}

function fakeAi({ answer = 'The latency spike came from the cache [doc-2].' } = {}) {
  const calls = { generate: [] };
  return {
    calls,
    generate: async (req) => {
      calls.generate.push(req);
      return { text: answer, model: 'fake-model' };
    },
  };
}

// ---- unit tests ----

test('reciprocalRankFusion ranks documents found by both engines first', () => {
  const fused = reciprocalRankFusion([
    [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    [{ id: 'c' }, { id: 'b' }, { id: 'd' }],
  ]);
  // c (ranks 3 and 1) edges out b (ranks 2 and 2): 1/63 + 1/61 > 2/62.
  assert.deepEqual(fused.map((d) => d.id), ['c', 'b', 'a', 'd']);
  assert.ok(Math.abs(fused[0].score - (1 / 63 + 1 / 61)) < 1e-12);
});

test('citedIds keeps only ids that were given as sources, in order, once each', () => {
  const docs = [{ id: 'doc-1' }, { id: 'doc-2' }];
  assert.deepEqual(citedIds('A [doc-2]. B [doc-1, doc-2]. C [doc-999].', docs), ['doc-2', 'doc-1']);
});

test('buildPrompt labels every source with its id', () => {
  const prompt = buildPrompt('why?', [{ id: 'doc-7', title: 'T', body: 'B', tags: ['x'] }]);
  assert.match(prompt, /\[doc-7\] T/);
  assert.match(prompt, /Question: why\?/);
});

test('the rate limiter allows `limit` requests per window, per key', () => {
  let t = 0;
  const allow = createRateLimiter({ limit: 2, windowMs: 1000, now: () => t });
  assert.equal(allow('ip1'), true);
  assert.equal(allow('ip1'), true);
  assert.equal(allow('ip1'), false);
  assert.equal(allow('ip2'), true);
  t = 1000;
  assert.equal(allow('ip1'), true);
});

// ---- routes, against a real database ----

const skip = process.env.DATABASE_URL ? false : 'DATABASE_URL not set';
const schema = `test_ai_${process.pid}_${Date.now()}`;
const owners = [{ id: 'own-1', name: 'One', email: 'one@example.com' }];
const documents = [
  { id: 'doc-1', title: 'Q4 Budget Review', body: 'finance budget spend and variance', tags: ['finance'] },
  { id: 'doc-2', title: 'Checkout Postmortem', body: 'latency spike caused by cache eviction in checkout', tags: ['incident'] },
  { id: 'doc-3', title: 'Hiring Plan', body: 'backend engineer roles for the platform team', tags: ['hiring'] },
].map((d, i) => ({ ...d, owner: 'own-1', created: `2025-0${i + 1}-01T00:00:00Z` }));

let pool;
const servers = [];

async function start(opts) {
  const srv = createServer({ index: buildIndex(await listDocuments(pool)), db: pool, embedder: fakeEmbedder(), ...opts });
  await new Promise((resolve) => srv.listen(0, resolve));
  servers.push(srv);
  return `http://localhost:${srv.address().port}`;
}

const ask = (base, body) =>
  fetch(`${base}/ask`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

before(async () => {
  if (skip) return;
  const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, options: `-c search_path=${schema},public` });
  await migrate(pool);
  await seed(pool, { owners, documents });
  await saveEmbeddings(
    pool,
    documents.map((d) => d.id),
    documents.map((d) => toPgVector(fakeEmbedding(`${d.title}\n${d.body}`))),
  );
});

after(async () => {
  if (skip) return;
  for (const srv of servers) srv.close();
  await pool.query(`DROP SCHEMA ${schema} CASCADE`);
  await pool.end();
});

test('engine=semantic ranks the closest document first, with a similarity score', { skip }, async () => {
  const base = await start({ ai: fakeAi() });
  const body = await (await fetch(`${base}/search?q=checkout%20latency&engine=semantic`)).json();
  assert.equal(body.results[0].id, 'doc-2');
  assert.ok(body.results[0].score > body.results[1].score);
  assert.equal(body.total, 3);
});

test('engine=hybrid fuses keyword and semantic results', { skip }, async () => {
  const base = await start({ ai: fakeAi() });
  const body = await (await fetch(`${base}/search?q=budget&engine=hybrid&limit=2`)).json();
  assert.equal(body.engine, 'hybrid');
  assert.equal(body.results[0].id, 'doc-1');
  assert.equal(body.results.length, 2);
});

test('a repeated query reuses its cached embedding', { skip }, async () => {
  const embedder = fakeEmbedder();
  const base = await start({ embedder });
  await fetch(`${base}/search?q=budget&engine=semantic`);
  await fetch(`${base}/search?q=Budget&engine=semantic&offset=10`);
  assert.equal(embedder.calls, 1);
});

test('without a Gemini key, semantic search still works but /ask returns 503', { skip }, async () => {
  const base = await start({ ai: null });
  assert.equal((await fetch(`${base}/search?q=budget&engine=semantic`)).status, 200);
  assert.equal((await ask(base, { question: 'hi' })).status, 503);
});

test('POST /ask answers from the top documents and returns its sources', { skip }, async () => {
  const ai = fakeAi();
  const base = await start({ ai });
  const res = await ask(base, { question: 'What caused the checkout latency spike?' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.match(body.answer, /cache/);
  assert.deepEqual(body.cited, ['doc-2']);
  assert.equal(body.model, 'fake-model');
  assert.equal(body.sources[0].id, 'doc-2');
  assert.match(ai.calls.generate[0].prompt, /\[doc-2\] Checkout Postmortem/);
});

test('POST /ask validates the question', { skip }, async () => {
  const base = await start({ ai: fakeAi() });
  assert.equal((await ask(base, {})).status, 400);
  assert.equal((await ask(base, { question: 'x'.repeat(501) })).status, 400);
  const bad = await fetch(`${base}/ask`, { method: 'POST', body: 'not json' });
  assert.equal(bad.status, 400);
});

test('POST /ask is rate limited per client', { skip }, async () => {
  const base = await start({ ai: fakeAi(), limits: { searchPerMinute: 30, askPerMinute: 2, aiPerDay: 100 } });
  assert.equal((await ask(base, { question: 'budget?' })).status, 200);
  assert.equal((await ask(base, { question: 'budget?' })).status, 200);
  const limited = await ask(base, { question: 'budget?' });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '60');
});

test('a Gemini failure returns 503 without leaking its details', { skip }, async () => {
  const ai = fakeAi();
  ai.generate = async () => {
    const err = new Error('quota exceeded for project 12345');
    err.name = 'GeminiError';
    throw err;
  };
  const base = await start({ ai });
  const res = await ask(base, { question: 'budget?' });
  assert.equal(res.status, 503);
  assert.ok(!(await res.text()).includes('12345'));
});

test('generate falls back to the next model when one is overloaded', async () => {
  const tried = [];
  const fetchImpl = async (url) => {
    const model = url.match(/models\/([^:]+):/)[1];
    tried.push(model);
    if (model === 'busy') return new Response(JSON.stringify({ error: { message: 'overloaded' } }), { status: 503 });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }));
  };
  const gemini = createGemini({ apiKey: 'k', chatModels: ['busy', 'free'], fetchImpl });
  assert.deepEqual(await gemini.generate({ system: 's', prompt: 'p' }), { text: 'ok', model: 'free' });
  assert.deepEqual(tried, ['busy', 'free']);
});

test('POST is only accepted on /ask', { skip }, async () => {
  const base = await start({ ai: fakeAi() });
  assert.equal((await fetch(`${base}/search?q=x`, { method: 'POST' })).status, 405);
});
