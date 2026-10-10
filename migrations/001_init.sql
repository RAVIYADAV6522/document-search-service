-- Initial schema for the document search service. Written for PostgreSQL.
--
-- Primary keys are TEXT so the readable ids from documents.json (own-1,
-- doc-001) survive seeding and show up unchanged in API responses. Rows
-- created without an explicit id still get a random UUID as their id.
--
-- Tags are normalized into their own table plus a document_tags join table,
-- rather than stored as a text[] column on documents. That is a deliberate
-- choice: it is what lets "has both tag A and tag B" (queries.sql, query 3)
-- be answered with two indexed lookups instead of an unindexed array-
-- containment scan over every document. See NOTES.md for the full
-- reasoning.

CREATE TABLE owners (
    id         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    name       TEXT NOT NULL,
    email      TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE documents (
    id         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    title      TEXT NOT NULL,
    body       TEXT NOT NULL,
    owner_id   TEXT NOT NULL REFERENCES owners(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE tags (
    id   SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE
);

CREATE TABLE document_tags (
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    tag_id      INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (document_id, tag_id)
);

-- Query 1 (10 most recent documents for one owner): owner_id equality plus
-- created_at ordering, served directly by this composite index.
CREATE INDEX idx_documents_owner_created ON documents (owner_id, created_at DESC);

-- Query 3 ("has both tag A and tag B"): lets each half of the intersection
-- (finance, q4) be found by an indexed tag_id lookup instead of a full
-- document_tags scan. Verified with EXPLAIN against real seeded data (see
-- NOTES.md) -- on a table this small (dozens of rows) PostgreSQL's planner
-- may reasonably choose a sequential scan instead, since it's cheaper at
-- that size; the index is what keeps the query from degrading to a full
-- scan as document_tags grows into the millions of rows.
CREATE INDEX idx_document_tags_tag_document ON document_tags (tag_id, document_id);
