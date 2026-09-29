import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dotProduct, magnitude, cosineSimilarity } from '../src/similarity.js';

test('cosineSimilarity of identical vectors is 1', () => {
  const v = new Map([['search', 2], ['ranking', 1]]);
  // Floating-point sqrt/division rounding can land a hair under 1
  // (0.9999999999999998), so compare within a tolerance rather than
  // strict equality.
  assert.ok(Math.abs(cosineSimilarity(v, v) - 1) < 1e-9);
});

test('cosineSimilarity of vectors with no shared terms is 0', () => {
  const a = new Map([['search', 1]]);
  const b = new Map([['finance', 1]]);
  assert.equal(cosineSimilarity(a, b), 0);
});

test('cosineSimilarity returns 0, not NaN, for a zero vector', () => {
  // An empty vector (e.g. an empty query, or a document with no
  // recognizable tokens) has magnitude 0. Dividing by that would be
  // division by zero -- the edge case that would embarrass us in
  // production if a NaN score slipped into a sort or a JSON response.
  const empty = new Map();
  const nonEmpty = new Map([['search', 3]]);
  assert.equal(cosineSimilarity(empty, nonEmpty), 0);
  assert.equal(cosineSimilarity(empty, empty), 0);
  assert.equal(Number.isNaN(cosineSimilarity(empty, nonEmpty)), false);
});

test('cosineSimilarity is proportional, not a raw overlap count', () => {
  // Mirrors the NOTES.md example: a short, focused document should outrank
  // a long, mostly-unrelated one that merely mentions the term more times.
  const query = new Map([['database', 1]]);
  const shortFocused = new Map([['database', 4], ['design', 2], ['guide', 2]]);
  const longUnrelated = new Map([
    ['database', 5],
    ...Array.from({ length: 199 }, (_, i) => [`word${i}`, 1]),
  ]);

  assert.ok(dotProduct(query, longUnrelated) > dotProduct(query, shortFocused));
  assert.ok(cosineSimilarity(query, shortFocused) > cosineSimilarity(query, longUnrelated));
});

test('magnitude of an empty vector is 0', () => {
  assert.equal(magnitude(new Map()), 0);
});

test('dotProduct only counts shared terms', () => {
  const a = new Map([['a', 2], ['b', 3]]);
  const b = new Map([['b', 4], ['c', 5]]);
  assert.equal(dotProduct(a, b), 12);
});
