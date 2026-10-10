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

## Part A: schema design and query 3

Tags are normalized into a `tags` table plus a `document_tags` join table,
rather than a `text[]` column on `documents`. This is what makes query 3
("has both `finance` and `q4`") cheap:

- **The obvious slow way**: store tags as `documents.tags text[]` and filter
  with `tags @> ARRAY['finance', 'q4']`. Without a GIN index, PostgreSQL has
  no way to use a plain B-tree to answer "array contains both of these
  values", so this filter runs as a sequential scan over every document,
  checking array membership row by row. Even with a GIN index on the array,
  a multi-value `@>` containment check is a heavier operation per row than
  a plain equality lookup.
- **The better way** (used in `queries.sql`): join `document_tags` twice,
  once per required tag, each time equating `tag_id` to the id of a known
  tag name. Both joins are servable by the composite index
  `idx_document_tags_tag_document (tag_id, document_id)`, so PostgreSQL
  *can* find "documents tagged finance" and then check membership in
  "documents tagged q4" via indexed lookups, without ever scanning the
  full `documents` table. Cost then scales with how many documents carry
  the rarer of the two tags, not the total document count -- though
  whether the planner actually chooses that plan depends on table size;
  see "Verified, not just asserted" below.

An equivalent `GROUP BY d.id HAVING COUNT(DISTINCT t.name) = 2` formulation
(matching either tag, then filtering to rows that matched both) also uses
the same index and is correctness-equivalent; the double self-join was
preferred because it never materializes rows for documents that only
matched one of the two tags before discarding them.

**Verified, not just asserted.** I ran `migrations/001_init.sql` (originally `schema.sql`) and `queries.sql`
against a real PostgreSQL 16 instance (Docker), seeded with this project's
own `documents.json` converted to rows. All 4 queries returned exactly the
expected results (the 10 most recent for the right owner, correct tag
counts, exactly the 3 finance+q4 documents, and the one zero-document
owner), and all of the schema's constraints actually hold (foreign key,
unique, `ON DELETE CASCADE`). `EXPLAIN` on one run showed query 3 using
`idx_document_tags_tag_document` via a bitmap index scan, confirming the
plan above is real and reachable. Re-running the same query after an
explicit `ANALYZE` on this tiny dataset (77 `document_tags` rows), the
planner instead chose a sequential scan for both queries 2 and 3 --
correct behavior, not a bug: PostgreSQL's cost-based optimizer reasonably
prefers scanning a handful of pages outright over the overhead of an index
lookup at that size. The index is what keeps the query cheap once
`document_tags` is too large to scan outright, not something that changes
the result on a small table.

## Part B: ranking

**Design.** `buildIndex()` tokenizes and vectorizes every document once, up
front; `rankDocuments()` only vectorizes the query and compares it against
those precomputed vectors. Bag-of-words vectors are sparse (`Map<term,
count>`), not dense arrays over a global vocabulary, so comparing two
vectors only touches terms they actually contain.

**Time complexity.** Let `N` = number of documents, `L̄` = average number of
tokens per document, `D̄` = average number of *distinct* terms per document,
`Q` = number of tokens in the query.

- Building the index: `O(N · L̄)` — tokenize and count once per document.
  Done once at startup, not per query.
- Ranking one query: vectorizing the query is `O(Q)`. For each of the `N`
  documents, `cosineSimilarity` does a dot product bounded by
  `O(min(Q, D̄))` and a magnitude sum over `O(D̄)` terms, so scoring every
  document is `O(N · D̄)`. The matches (documents with score > 0, at most
  `N` of them) are then sorted in `O(N log N)` in the worst case. So a
  single search is `O(N · D̄ + N log N)` overall — linear in the number of
  documents, not the full vocabulary size, because sparse vectors mean the
  vocabulary size never appears directly as a multiplicative factor.

**Dividing by the product of magnitudes: what if you skip it?** Skipping
the division and ranking by raw dot product instead means the score is no
longer proportional similarity — it is just "how many overlapping term
occurrences", which rewards long, wordy documents that mention a query
term a few times over short, focused documents that are proportionally
much more about it. Concrete example, query `"database"` (this exact case
is asserted in `test/similarity.test.js`, "cosineSimilarity is
proportional, not a raw overlap count" — these are real, verified numbers,
not hand-waved ones):

- Doc A: a short, focused doc, `{database: 4, design: 2, guide: 2}` (3
  distinct terms). `dot(query, A) = 4`. `cosine(query, A) ≈ 0.816`.
- Doc B: a long, mostly-unrelated doc, `{database: 5, word0: 1, ...,
  word198: 1}` (200 distinct terms). `dot(query, B) = 5`.
  `cosine(query, B) ≈ 0.334`.

Raw dot product ranks B above A (5 > 4) — the long, barely-relevant
document wins. Cosine similarity correctly ranks A above B (0.816 > 0.334),
because it normalizes by how much of each document's content the overlap
represents, not just the raw count.

**At 5 million documents, what breaks?** The current design holds every
document and its bag-of-words vector in a single Node process's memory,
and `rankDocuments` does a full linear scan over all `N` documents on
every single request. At 5M documents: the linear scan means query
latency grows with corpus size and every concurrent request repeats the
full scan; holding millions of `Map` objects (one per document) puts
sustained pressure on the V8 heap and GC; and a cold start has to
re-read and re-vectorize the entire corpus before serving a single
request. I'd reach for an inverted index (term → posting list of
document IDs, so a query only touches documents containing at least one
query term instead of all `N`), and, rather than hand-rolling that,
either PostgreSQL's built-in full-text search (`tsvector` + a GIN index,
which pairs naturally with the schema from Part A) or a dedicated search
engine (Elasticsearch/OpenSearch), plus BM25-style ranking instead of raw
cosine-over-term-frequency for better relevance at that scale.

## Part C: HTTP API edge cases

- **Missing `q`**: `400 Bad Request` with a JSON error body. `q` is the
  actual input the endpoint exists to serve, not an optional pagination
  hint, so a request without one is a malformed request, not something to
  silently default (e.g. to "return everything").
- **Non-numeric `limit`**: falls back to a default (`20`) rather than
  `400`. Unlike `q`, `limit`/`offset` are convenience knobs with sensible
  defaults; rejecting a whole search because `limit=abc` was typo'd would
  be a worse experience than just ignoring the bad value and returning a
  normal page of results.
- **`limit=10000`**: clamped to a maximum (`100`), not honored as-is and
  not rejected. Honoring it would let a single request force the server to
  serialize and return every matching document regardless of how many
  documents exist; clamping keeps the response bounded without failing the
  request. `total` in the response always reflects the full match count
  (pre-pagination), so a client can tell more results exist even when the
  page is capped.
- **Negative `offset`**: treated the same as missing (`0`), for the same
  reason as non-numeric `limit`.

## Part D: what I chose not to test, and why

- **`loader.js`**: not given a dedicated test. It's a thin pass-through
  over `node:fs` (`readFile` + `JSON.parse`) with no branching logic of its
  own to get wrong; its behavior is exercised implicitly by actually
  running the server against the real `documents.json` during development.
  A test here would mostly be re-testing `JSON.parse` and the filesystem.
- **`tokenizer.js` / `vectorizer.js` in isolation**: no dedicated test
  file. Both are exercised indirectly through `ranker.test.js` (if
  tokenizing or vector-building were broken, the ranking-order assertions
  there would fail), and the regex-based tokenizer is short enough (one
  line of actual logic) that its behavior is fully visible on inspection.
  I'd add direct tests if the tokenizer grew real logic (stemming,
  stopwords, unicode normalization).
- **`buildIndex()` in isolation**: not tested on its own; its only job
  (attach a precomputed vector to each document) is implicitly verified by
  every `ranker.test.js` assertion, since a broken index would break all
  of them.
- **Tie-breaking when two documents have exactly equal scores**: not
  tested. `rankDocuments` breaks ties by most-recent `created` date, but
  constructing that exact scenario is low value relative to the time it
  costs for this exercise.
- **Concurrency / load on the HTTP server**: out of scope for a take-home;
  no concurrent-request or performance testing was done.

## Later: moving from design to a running PostgreSQL service

The original brief kept the SQL as a standalone design and had the service load
`documents.json` in memory. The service now runs on PostgreSQL. Decisions made along
the way:

- **TEXT primary keys instead of UUID.** The dataset already has readable ids
  (`own-1`, `doc-001`), and the API exposes them in URLs (`/owners/own-1/documents`).
  Keeping them as TEXT means seeding preserves them; rows created without an id still
  default to `gen_random_uuid()::text`.
- **Query 3 generalized to any number of tags.** The self-join in `queries.sql` needs
  one join per tag, so it can't take a variable list. `/documents?tags=` instead uses
  relational division: filter `document_tags` to the requested tags, `GROUP BY` document,
  and keep groups where `COUNT(*)` equals the number of tags. The `(tag_id, document_id)`
  index still serves the filter. Requested tags are de-duplicated first, otherwise the
  count could never match.
- **Full-text search as a second engine, not a replacement.** The cosine ranker stays
  the default so the two can be compared. `search_vector` is a `GENERATED ALWAYS ...
  STORED` column, so it can't drift from `title`/`body`. On 28 rows the planner prefers
  a sequential scan, so the test suite checks with `enable_seqscan = off` that the GIN
  index *can* serve `@@`.
- **The cosine index is built once at startup** from the database. Documents added
  later are visible to `engine=sql` immediately but to `engine=cosine` only after a
  restart, an accepted limitation for an in-memory index.
