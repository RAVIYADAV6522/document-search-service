import { tokenize } from './tokenizer.js';

// Builds a sparse bag-of-words vector for a string: a Map from term to how
// many times it appears. Using a Map keyed by term (rather than a dense
// array indexed by a global vocabulary) means two vectors can be compared
// by walking only the terms each one actually contains.
export function vectorize(text) {
  const vector = new Map();
  for (const token of tokenize(text)) {
    vector.set(token, (vector.get(token) ?? 0) + 1);
  }
  return vector;
}
