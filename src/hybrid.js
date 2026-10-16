// Reciprocal Rank Fusion: merges ranked lists from different engines into
// one. Each document scores 1 / (k + rank) in every list it appears in, and
// the scores are summed. It only uses positions, never the raw scores, which
// is what makes it work across engines whose scores aren't comparable
// (ts_rank vs cosine similarity). k = 60 is the value from the original
// paper (Cormack et al., 2009); it stops the very top ranks from dominating.
export function reciprocalRankFusion(lists, k = 60) {
  const fused = new Map();
  for (const list of lists) {
    list.forEach((doc, i) => {
      const entry = fused.get(doc.id) ?? { doc, score: 0 };
      entry.score += 1 / (k + i + 1);
      fused.set(doc.id, entry);
    });
  }
  return [...fused.values()]
    .sort((a, b) => b.score - a.score)
    .map(({ doc, score }) => ({ ...doc, score }));
}
