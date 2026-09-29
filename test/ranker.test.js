import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex, rankDocuments } from '../src/ranker.js';

const fixtures = [
  {
    id: 'doc-a',
    title: 'Search Ranking',
    body: 'search ranking algorithm cosine similarity',
    owner: 'own-1',
    tags: ['engineering'],
    created: '2025-01-01T00:00:00Z',
  },
  {
    id: 'doc-b',
    title: 'Finance Report',
    body: 'quarterly finance budget report',
    owner: 'own-1',
    tags: ['finance'],
    created: '2025-06-01T00:00:00Z',
  },
  {
    id: 'doc-c',
    title: 'Search Infra',
    body: 'search index sharding ranking infra',
    owner: 'own-2',
    tags: ['engineering'],
    created: '2025-03-01T00:00:00Z',
  },
];

test('rankDocuments ranks more relevant documents higher', () => {
  const index = buildIndex(fixtures);
  const results = rankDocuments('search ranking', index);
  assert.deepEqual(results.map((r) => r.id), ['doc-a', 'doc-c']);
  assert.ok(results[0].score > results[1].score);
});

test('rankDocuments excludes documents with no term overlap', () => {
  const index = buildIndex(fixtures);
  const results = rankDocuments('search ranking', index);
  assert.ok(!results.some((r) => r.id === 'doc-b'));
});

test('rankDocuments does not leak the internal vector representation', () => {
  const index = buildIndex(fixtures);
  const [top] = rankDocuments('search', index);
  assert.equal(top.vector, undefined);
});

test('rankDocuments returns nothing for an empty query', () => {
  const index = buildIndex(fixtures);
  assert.deepEqual(rankDocuments('', index), []);
});
