# Notes

Assumptions and design decisions, recorded as they're made.

## Assumption: `documents.json` was not provided

The brief refers to a provided `documents.json` (28 sample documents), but it was not
attached to the email containing the brief. Rather than block on that, I authored my own
`documents.json` matching the shape described in the brief:

- `owners`: `{ id, name, email }`
- `documents`: `{ id, title, body, owner, tags: string[], created: ISO 8601 timestamp }`

It contains 28 documents across 5 owners, deliberately including:
- one owner (`own-5`) with zero documents, to exercise query 4 (owners who never created a
  document)
- 3 documents tagged with both `finance` and `q4`, plus decoys tagged with only one of the
  two, to exercise query 3 (both, not either)
- one owner (`own-1`) with more than 10 documents spanning a wide date range, to exercise
  query 1 (10 most recent for one owner)
- varied, topically-clustered titles/bodies (search/ranking, finance, security, product,
  onboarding, sales) so Part B's cosine-similarity ranking has meaningful signal to rank
  against, rather than near-random bag-of-words overlap

<!-- Further assumptions and the required Part B / Part C / Part D answers go here as
     those parts are implemented. -->
