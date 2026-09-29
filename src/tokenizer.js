// Splits text into lowercase word tokens. Anything that isn't a letter or
// digit is treated as a separator, so punctuation, quotes, and whitespace
// all split tokens without needing a library.
export function tokenize(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}
