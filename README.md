# document-search-service

The retrieval core of a tiny internal document search tool: a PostgreSQL schema and query
set, an in-memory cosine-similarity ranking engine written entirely from scratch, and a
small HTTP search API — all on **zero external dependencies**.

| | |
|---|---|
| **Runtime** | Node.js 20+, standard library only (`node:http`, `node:fs`, `node:test`) |
| **Storage design** | PostgreSQL (schema + queries, reviewed as SQL — not wired to a live DB) |
| **Ranking** | Hand-rolled bag-of-words vectorization + cosine similarity, no libraries |
| **Tests** | `node:test`, 15 tests across similarity / ranking / HTTP layers |
| **Dependencies** | None. `dependencies` and `devDependencies` are both empty. |

## Highlights

- **No black boxes.** The vectorizer, tokenizer, and cosine similarity scorer are all
  written from first principles — no search or ML library involved.
- **Layered, independently testable modules.** Pure algorithm (`tokenizer.js` →
  `vectorizer.js` / `similarity.js`) is fully decoupled from I/O (`loader.js`, `server.js`),
  so the core ranking logic has zero filesystem or network dependency in its tests.
- **Schema designed around the hard query, not just the easy ones.** Tags are normalized
  into a join table specifically so "has both tag A and tag B" is an indexed lookup instead
  of an unindexed array scan — see [`NOTES.md`](./NOTES.md) for the full reasoning.
- **Verified against a real database.** `schema.sql` and `queries.sql` were run against an
  actual PostgreSQL 16 instance (not just read for syntax) — every query, every constraint
  (foreign keys, uniqueness, cascading deletes), confirmed correct.
- **Documented assumptions and edge-case decisions**, not silent guesses — see `NOTES.md`.

## Project structure

```
document-search-service/
├── src/
│   ├── tokenizer.js    text → lowercase word tokens
│   ├── vectorizer.js   tokens → bag-of-words vector (Map<term, count>)
│   ├── similarity.js   dot product / magnitude / cosine similarity
│   ├── loader.js        reads and parses documents.json
│   ├── ranker.js         builds the search index, ranks documents against a query
│   └── server.js         node:http HTTP API (GET /search)
├── test/
│   ├── similarity.test.js
│   ├── ranker.test.js
│   └── server.test.js
├── documents.json      sample dataset (28 documents, 5 owners)
├── schema.sql           PostgreSQL schema
├── queries.sql          the 4 required queries, each with a one-line comment
├── NOTES.md              assumptions, design reasoning, and required written answers
├── AI_USAGE.md           AI tool usage disclosure
└── package.json          zero dependencies, ESM ("type": "module")
```

## Getting started

```
npm start        # starts the HTTP search API on :3000 (override with PORT=)
npm test         # runs the full node:test suite
```

No `npm install` step — there is nothing to install.

## API

```
GET /search?q=<text>&limit=<n>&offset=<n>
```

| Param | Required | Behavior |
|---|---|---|
| `q` | Yes | Search query. Missing or blank → `400`. |
| `limit` | No | Page size. Non-numeric or missing → default `20`. Clamped to a max of `100`. |
| `offset` | No | Page offset. Non-numeric or negative → `0`. |

**Response**

```json
{
  "query": "search ranking",
  "total": 17,
  "limit": 20,
  "offset": 0,
  "results": [
    { "id": "doc-020", "title": "Search Relevance Tuning Notes", "body": "...",
      "owner": "own-2", "tags": ["engineering", "search", "ranking"],
      "created": "2026-06-30T15:00:00Z", "score": 0.3536 }
  ]
}
```

(real output from `GET /search?q=search%20ranking` against this project's `documents.json`.)

`total` always reflects the full match count before pagination is applied, so a client can
tell more results exist even when the page is capped.

## Architecture at a glance

```
documents.json → loader.js → ranker.js (buildIndex, once at startup)
                                  │
                    vectorizer.js + similarity.js
                                  │
                       rankDocuments (per request)
                                  │
                              server.js  →  GET /search  →  JSON response
```

Part A (`schema.sql` / `queries.sql`) is intentionally a separate, standalone SQL design —
per the brief, the Node service loads `documents.json` in memory and never connects to a
database.

## Documentation

| File | Contents |
|---|---|
| [`NOTES.md`](./NOTES.md) | Stated assumptions, schema/query reasoning, ranking complexity analysis, HTTP edge-case decisions, and testing judgment — the required written answers. |
| [`AI_USAGE.md`](./AI_USAGE.md) | Disclosure of AI tool usage: what was used, what was corrected, what saved time. |
| [`schema.sql`](./schema.sql) | PostgreSQL schema (owners, documents, tags, document_tags). |
| [`queries.sql`](./queries.sql) | The 4 required queries, each with a one-line comment. |

## License

Private take-home submission. Not for public distribution.
