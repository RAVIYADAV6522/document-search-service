# document-search-service

**Live demo:** [document-search-service-0y08.onrender.com](https://document-search-service-0y08.onrender.com) — a search page where you can type a keyword,
switch between the two search engines, compare them side by side, and browse by tag.
**API:** [`/search?q=budget&engine=sql`](https://document-search-service-0y08.onrender.com/search?q=budget&engine=sql) ·
[`/documents?tags=finance,q4`](https://document-search-service-0y08.onrender.com/documents?tags=finance,q4) · [all endpoints](#api)
(Free hosting: the first request after a quiet spell can take up to a minute while the server wakes up.)

A document search API on **PostgreSQL**: a normalized schema with versioned migrations,
SQL endpoints for reporting queries, Postgres full-text search, and an in-memory
cosine-similarity ranker written from scratch, served side by side so the two search
approaches can be compared on the same data.

| | |
|---|---|
| **Runtime** | Node.js 22, standard library HTTP server (`node:http`) |
| **Frontend** | One page of plain HTML/CSS/JS served by the same server, no framework or build step |
| **Database** | PostgreSQL 16 (Neon in production, Docker locally), `pg` driver |
| **Search** | `engine=sql`: `tsvector` + GIN index + `ts_rank` · `engine=cosine`: hand-rolled bag-of-words cosine similarity |
| **Data** | 10,000 documents from 25 owners: 28 hand-written plus 9,972 generated deterministically |
| **Tests** | `node:test`, 49 tests, including integration tests against a real Postgres |
| **Deploy** | Render (web service) + Neon (Postgres) |
| **Dependencies** | One: `pg` |

## Highlights

- **SQL that runs, not just SQL on paper.** Every endpoint is backed by a parameterized
  query in [`src/repository.js`](./src/repository.js): owner timelines from a composite
  index, tag counts with `LEFT JOIN … GROUP BY`, "has all of these tags" as relational
  division (`GROUP BY … HAVING COUNT(*) = n`), and anti-joins with `NOT EXISTS`.
- **Two search engines, one API.** `?engine=sql` uses Postgres full-text search: a
  generated `tsvector` column (title weighted above body), a GIN index, stemming and
  stop words, and web-style query syntax (`"exact phrase"`, `-exclude`).
  `?engine=cosine` uses a tokenizer, vectorizer and cosine scorer written from first
  principles. See [Comparing the engines](#comparing-the-engines).
- **Schema designed around the hard query.** Tags are normalized into a join table so
  "has tag A and tag B" is an indexed lookup instead of an array scan over every
  document. See [`NOTES.md`](./NOTES.md) for the reasoning and `EXPLAIN` checks.
- **Versioned migrations and an idempotent seed.** `migrations/*.sql` are applied in order
  and recorded in `schema_migrations`; the seed upserts in a single transaction using
  `unnest()` batch inserts, so both are safe to run repeatedly.
- **Production basics.** `/healthz` checks the database, settings come from environment
  variables, errors never leak database details, every request is logged as JSON, and
  the server shuts down gracefully on `SIGTERM`.
- **Tested against real Postgres.** Integration tests migrate and seed a throwaway schema
  per run, including a test that the GIN index can serve the full-text query.

## API

All endpoints are `GET` and return JSON.

| Endpoint | What it does | SQL technique |
|---|---|---|
| `/` | The search page (HTML) | Calls the endpoints below |
| `/search?q=<text>&engine=cosine\|sql&limit=&offset=` | Ranked search, paginated | Full-text search (`@@`, `ts_rank`) or in-memory cosine |
| `/owners/:id/documents` | An owner's 10 most recent documents | Composite index `(owner_id, created_at DESC)` |
| `/tags/stats` | How many documents carry each tag | `LEFT JOIN` + `GROUP BY` |
| `/documents?tags=finance,q4` | Documents that have **every** listed tag | Relational division: `HAVING COUNT(*) = n` |
| `/owners/inactive` | Owners who have never created a document | Anti-join: `NOT EXISTS` |
| `/healthz` | Liveness + database check | `SELECT 1` |

**`/search` parameters**

| Param | Required | Behavior |
|---|---|---|
| `q` | Yes | Search query. Missing or blank → `400`. Over 500 characters → `400`. |
| `engine` | No | `cosine` (default) or `sql`. Anything else → `400`. |
| `limit` | No | Page size. Non-numeric or missing → `20`. Clamped to a maximum of `100`. |
| `offset` | No | Page offset. Non-numeric or negative → `0`. |

**Example**

```
$ curl 'https://document-search-service-0y08.onrender.com/search?q=search%20ranking&limit=1'
{
  "query": "search ranking",
  "engine": "cosine",
  "total": 1867,
  "limit": 1,
  "offset": 0,
  "results": [
    { "id": "doc-04731", "title": "Ranking Change Proposal: dark mode", "body": "...",
      "owner": "own-18", "owner_name": "Sofia Haddad", "created": "2026-06-23T13:23:00.000Z",
      "tags": ["engineering", "ranking", "search"], "score": 0.465 }
  ]
}
```

`total` is the full match count before pagination, so a client can tell more results exist.

## Comparing the engines

The same queries against the 10,000 documents:

| Query | `engine=cosine` | `engine=sql` | Why |
|---|---|---|---|
| `search ranking` | 1,867 results | 624 results | Cosine matches *any* query word; full-text search requires *all* of them. |
| `budgets` | 0 results | 716 results | Postgres stems "budgets" to "budget"; cosine needs the exact word. |
| `the` | 9,742 results | 0 results | Postgres drops stop words; cosine scores them like any other word. |
| `"latency spike"` | 1,198 results | 262 results | Postgres treats the quotes as a phrase; cosine matches either word anywhere. |
| `finance -audit` | 2,135 results | 618 results | Postgres supports `-word` exclusion. |

**Do the indexes matter?** `EXPLAIN ANALYZE` on the 10,000 rows (local Postgres 16):

| Query | With index | Index disabled |
|---|---|---|
| Full-text search for a rare word (`sharding`) | 0.026 ms, GIN bitmap index scan | 2.29 ms, sequential scan |
| An owner's 10 most recent documents | 0.072 ms, `idx_documents_owner_created` | 2.41 ms, sequential scan + sort |
| Full-text search for a common word (356 matches) | sequential scan, 2.3 ms | (same) |

The last row is the planner choosing correctly: when a term matches a large share of
rows, reading the table is cheaper than going through the index, so Postgres skips it.

**Trade-offs.** Cosine similarity gives full control over scoring and handles partial
matches, but scores every document in application memory on each request (time grows
linearly with the number of documents) and only sees data loaded at startup. Postgres full-text search uses an index, stays in sync with the
data automatically, and understands word forms, at the cost of less control over the
ranking formula (for example, `ts_rank` scores queries with `-exclusions` as 0, so those
results fall back to newest-first).

## Project structure

```
document-search-service/
├── migrations/
│   ├── 001_init.sql             owners, documents, tags, document_tags + indexes
│   └── 002_full_text_search.sql generated tsvector column + GIN index
├── scripts/
│   ├── migrate.js               applies pending migrations, tracked in schema_migrations
│   ├── generate.js              deterministic generator for the other 9,972 documents
│   └── seed.js                  loads documents.json (idempotent, one transaction)
├── public/
│   ├── index.html               search page: search box, engine toggle, results, tag sidebar
│   ├── app.js                   page logic (plain DOM, renders text via textContent only)
│   └── styles.css               light/dark, responsive down to phone width
├── src/
│   ├── server.js                HTTP routes, static page, validation, errors, logging, shutdown
│   ├── repository.js            every SQL statement the service runs
│   ├── db.js                    connection pool (timeouts, idle-error handling)
│   ├── ranker.js                builds the cosine index, ranks documents
│   ├── vectorizer.js            tokens → bag-of-words vector
│   ├── similarity.js            dot product / magnitude / cosine similarity
│   ├── tokenizer.js             text → lowercase word tokens
│   └── loader.js                reads documents.json for the seed
├── test/
│   ├── api.test.js              integration tests against real Postgres
│   ├── server.test.js           HTTP behaviour and static files, with fake databases
│   ├── ranker.test.js
│   └── similarity.test.js
├── queries.sql                  the original four queries, annotated
├── documents.json               28 hand-written documents and 5 owners
├── render.yaml                  Render deployment blueprint
└── NOTES.md                     design reasoning, assumptions, EXPLAIN analysis
```

## Running locally

Requires Node.js 22+ and Docker.

```
docker run -d --name dss-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=docsearch \
  -p 5433:5432 postgres:16
cp .env.example .env
npm install
npm run db:setup   # apply migrations + seed the 28 hand-written documents
npm run seed -- --total=10000   # optional: add generated documents up to 10,000
npm run dev        # search page at http://localhost:3000
npm test           # integration tests run when DATABASE_URL is set
```

## Deployment

- **Database:** Neon Postgres. Migrations run automatically on each deploy; seed once
  with `node --env-file=.env.neon scripts/seed.js --total=10000`.
- **API:** Render web service from [`render.yaml`](./render.yaml), with `DATABASE_URL` set
  in the dashboard and the health check pointed at `/healthz`.

## Documentation

| File | Contents |
|---|---|
| [`NOTES.md`](./NOTES.md) | Assumptions, schema and query reasoning, ranking complexity, HTTP edge cases, testing approach. |
| [`AI_USAGE.md`](./AI_USAGE.md) | How AI tools were used during development. |
