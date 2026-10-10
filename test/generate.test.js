import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandDataset, generateDocuments } from '../scripts/generate.js';
import { loadDataset } from '../src/loader.js';

const base = await loadDataset();

test('expandDataset reaches the requested total and keeps the hand-written documents', () => {
  const data = expandDataset(base, 500);
  assert.equal(data.documents.length, 500);
  assert.deepEqual(data.documents.slice(0, base.documents.length), base.documents);
});

test('generated ids are unique and never collide with the hand-written ones', () => {
  const ids = expandDataset(base, 2000).documents.map((d) => d.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('generation is deterministic, so re-seeding is idempotent', () => {
  assert.deepEqual(generateDocuments(50, ['own-1', 'own-2']), generateDocuments(50, ['own-1', 'own-2']));
});

test('every generated document references a known owner, and own-5 stays without documents', () => {
  const data = expandDataset(base, 2000);
  const owners = new Set(data.owners.map((o) => o.id));
  assert.ok(data.documents.every((d) => owners.has(d.owner)));
  assert.ok(!data.documents.some((d) => d.owner === 'own-5'));
  assert.equal(new Set(data.owners.map((o) => o.email)).size, data.owners.length, 'emails must be unique');
});

test('generated documents have a title, body, tags and a valid date in range', () => {
  for (const d of generateDocuments(300, ['own-1'])) {
    assert.ok(d.title && d.body && d.tags.length > 0, d.id);
    const t = Date.parse(d.created);
    assert.ok(t >= Date.parse('2024-01-01') && t < Date.parse('2026-10-01'), d.created);
  }
});

test('asking for no more than the base returns the base unchanged', () => {
  assert.equal(expandDataset(base, 0), base);
  assert.equal(expandDataset(base, 10), base);
});
