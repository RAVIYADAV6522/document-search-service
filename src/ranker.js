import { vectorize } from './vectorizer.js';
import { cosineSimilarity } from './similarity.js';

// Precomputes a bag-of-words vector for each document once, so repeated
// searches don't re-tokenize every document on every request.
export function buildIndex(documents) {
  return documents.map((doc) => ({
    ...doc,
    vector: vectorize(`${doc.title}\n${doc.body}`),
  }));
}

// Ranks an already-built index against a query by cosine similarity.
// Only documents with a positive score count as a match.
export function rankDocuments(query, index) {
  const queryVector = vectorize(query);

  const scored = [];
  for (const doc of index) {
    const score = cosineSimilarity(queryVector, doc.vector);
    if (score > 0) {
      const { vector, ...rest } = doc;
      scored.push({ ...rest, score });
    }
  }

  scored.sort((a, b) => b.score - a.score || new Date(b.created) - new Date(a.created));
  return scored;
}
