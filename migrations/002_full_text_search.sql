-- Full-text search, as a database-side alternative to the in-memory cosine
-- ranker (GET /search?engine=sql).
--
-- search_vector is a generated column, so Postgres keeps it in sync with
-- title and body on every insert/update and no application code has to.
-- to_tsvector('english', ...) lowercases, drops stop words ("the", "is")
-- and stems words, so "ranking", "ranked" and "ranks" all index as "rank".
-- setweight marks title terms as A and body terms as B, which ts_rank uses
-- to score a title match above a body match.
ALTER TABLE documents ADD COLUMN search_vector tsvector
    GENERATED ALWAYS AS (
        setweight(to_tsvector('english', title), 'A') ||
        setweight(to_tsvector('english', body), 'B')
    ) STORED;

-- GIN is an inverted index (term -> documents containing it), which is what
-- lets search_vector @@ query find matches without reading every row.
CREATE INDEX idx_documents_search ON documents USING GIN (search_vector);
