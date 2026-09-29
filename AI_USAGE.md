# AI Usage

## Tools used

Claude Code, used throughout for design discussion and implementation across
Parts A-D: schema/query design (Part A), the tokenizer/vectorizer/cosine
similarity/ranker (Part B), the HTTP API (Part C), and the test suite
(Part D). I reviewed and approved the architecture before implementation,
made the call on assumptions (notably the missing `documents.json`, see
NOTES.md), and reviewed/ran the code after each part before committing it
myself.

## Something I corrected

The first version of the "identical vectors" similarity test used strict
equality:

```js
test('cosineSimilarity of identical vectors is 1', () => {
  const v = new Map([['search', 2], ['ranking', 1]]);
  assert.equal(cosineSimilarity(v, v), 1);
});
```

Running the suite failed it: `cosineSimilarity(v, v)` returned
`0.9999999999999998`, not exactly `1`, because computing magnitude via
`Math.sqrt` and then dividing introduces floating-point rounding even when
comparing a vector to itself. I had it switch to a tolerance-based
assertion (`Math.abs(result - 1) < 1e-9`) instead. This is a correctness
issue that would have shipped silently if I'd trusted the test without
running it: a strict-equality float test like that either passes by luck
on a given platform/V8 version or is quietly flaky.

## Something it got right that saved real time

Generating the synthetic `documents.json` (28 documents, 5 owners) in one
pass with the specific properties needed to exercise every required SQL
query and give Part B's ranker real signal: one owner with zero documents
(query 4), exactly 3 documents tagged with both `finance` and `q4` plus
decoys tagged with only one (query 3), one owner with 12 documents spanning
a wide date range (query 1), and topically-clustered, realistic-sounding
titles/bodies so cosine similarity rankings are meaningfully different
rather than near-random. Hand-authoring that with the right edge cases
baked in and then re-verifying it with a script (owner counts, tag overlap
counts, unique IDs) would have taken noticeably longer than reviewing it.
