# document-search-service

Retrieval core of a tiny internal document search tool: PostgreSQL schema/queries, an
in-memory cosine-similarity ranker written from scratch, and a small `node:http` search
API. No external dependencies (Node 20+, standard library only).

See [NOTES.md](./NOTES.md) for assumptions and design answers, and
[AI_USAGE.md](./AI_USAGE.md) for AI tool usage disclosure.

## Run

```
npm start        # starts the HTTP search API
npm test         # runs the node:test suite
```
