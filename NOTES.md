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
  tag name. Both joins hit the composite index
  `idx_document_tags_tag_document (tag_id, document_id)`, so PostgreSQL can
  find "documents tagged finance" and then check membership in "documents
  tagged q4" via indexed lookups, without ever scanning the full
  `documents` table. Cost is roughly proportional to how many documents
  carry the rarer of the two tags, not the total document count.

An equivalent `GROUP BY d.id HAVING COUNT(DISTINCT t.name) = 2` formulation
(matching either tag, then filtering to rows that matched both) also uses
the same index and is correctness-equivalent; the double self-join was
preferred because it never materializes rows for documents that only
matched one of the two tags before discarding them.

## Part B / Part C / Part D notes

<!-- Filled in as those parts are implemented. -->
