# AI Usage

## Tools used

Claude Code was used throughout the assignment for design discussion and implementation across Parts A–D: PostgreSQL schema and query design (Part A), the tokenizer/vectorizer/cosine similarity/ranker (Part B), the HTTP API (Part C), and the test suite (Part D).

I reviewed Claude's proposed architecture and implementation, made the final decisions on the design and assumptions, and reviewed and ran the code after each part before committing it myself. In particular, I reviewed the trade-offs around the normalized tag schema (`tags` + `document_tags`) and the required query patterns before accepting the design.

## Something I corrected

The first version of the "identical vectors" similarity test used strict equality:

```js
test('cosineSimilarity of identical vectors is 1', () => {
  const v = new Map([['search', 2], ['ranking', 1]]);
  assert.equal(cosineSimilarity(v, v), 1);
});
```

Running the suite showed that `cosineSimilarity(v, v)` returned `0.9999999999999998`, rather than exactly `1`, because the magnitude calculation uses `Math.sqrt` and floating-point arithmetic introduces rounding.

I changed the assertion to use a tolerance:

```js
assert.ok(Math.abs(cosineSimilarity(v, v) - 1) < 1e-9);
```

This was a correctness issue that would have been easy to miss without actually running the test suite.

## Something it got right that saved real time

Claude generated the synthetic `documents.json` dataset (28 documents, 5 owners) in one pass with the specific properties needed to exercise the required SQL queries and give Part B's ranker meaningful signal.

The dataset included:

* one owner with zero documents, exercising the "owner with no documents" query;
* exactly 3 documents tagged with both `finance` and `q4`, plus documents containing only one of those tags, exercising the distinction between "both" and "either";
* one owner with 12 documents spanning a wide date range, exercising the "10 most recent documents" query;
* topically clustered, realistic-sounding titles and bodies so that cosine-similarity rankings were meaningful rather than effectively random.

I reviewed the generated data and re-verified it with a script for owner counts, tag overlap counts, and unique IDs before using it.
