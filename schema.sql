-- Schema for the document search service. Written for PostgreSQL.
--
-- Tags are normalized into their own table plus a document_tags join table,
-- rather than stored as a text[] column on documents. That is a deliberate
-- choice: it is what lets "has both tag A and tag B" (queries.sql, query 3)
-- be answered with two indexed lookups instead of an unindexed array-
-- containment scan over every document. See NOTES.md for the full
-- reasoning.

CREATE TABLE owners (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name       TEXT NOT NULL,
    email      TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE documents (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title      TEXT NOT NULL,
    body       TEXT NOT NULL,
    owner_id   UUID NOT NULL REFERENCES owners(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE tags (
    id   SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE
);

CREATE TABLE document_tags (
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    tag_id      INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (document_id, tag_id)
);

-- Query 1 (10 most recent documents for one owner): owner_id equality plus
-- created_at ordering, served directly by this composite index.
CREATE INDEX idx_documents_owner_created ON documents (owner_id, created_at DESC);

-- Queries 2 and 3 (tag counts, and "has both tag A and tag B"): both filter
-- and aggregate by tag_id first, then look up document_id. This index
-- serves both as an index-only scan.
CREATE INDEX idx_document_tags_tag_document ON document_tags (tag_id, document_id);
