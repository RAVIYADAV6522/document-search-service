// Dot product of two sparse bag-of-words vectors (Map<term, count>).
// Walking the smaller map and probing the larger one keeps this
// proportional to the size of the smaller vector, not both combined.
export function dotProduct(a, b) {
  const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a];
  let sum = 0;
  for (const [term, count] of smaller) {
    const otherCount = larger.get(term);
    if (otherCount !== undefined) sum += count * otherCount;
  }
  return sum;
}

export function magnitude(vector) {
  let sumOfSquares = 0;
  for (const count of vector.values()) sumOfSquares += count * count;
  return Math.sqrt(sumOfSquares);
}

// Cosine similarity of two bag-of-words vectors, in [0, 1] since term
// counts are non-negative. A zero vector (e.g. an empty query, or a
// document with no recognizable tokens) has magnitude 0: dividing by that
// would be division by zero / produce NaN, so it's treated as no
// similarity instead. See NOTES.md for why skipping the magnitude
// division entirely (using a raw dot product as the score) is wrong.
export function cosineSimilarity(a, b) {
  const magnitudeA = magnitude(a);
  const magnitudeB = magnitude(b);
  if (magnitudeA === 0 || magnitudeB === 0) return 0;
  return dotProduct(a, b) / (magnitudeA * magnitudeB);
}
