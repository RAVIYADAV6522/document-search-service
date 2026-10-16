-- Semantic search: each document gets an embedding, a 384-number vector
-- from the all-MiniLM-L6-v2 model (src/embeddings.js) that captures what the text means rather
-- than which words it uses. Documents about similar things end up close
-- together, so "server outage" can find a postmortem that only says
-- "latency spike" (GET /search?engine=semantic).
--
-- pgvector adds the vector type and distance operators. The column is
-- nullable: migrations are plain SQL and can't run the model, so
-- scripts/embed.js fills it in afterwards, and only rows with an embedding are searched.
CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE documents ADD COLUMN embedding vector(384);

-- HNSW is an approximate nearest-neighbour index: a layered graph that
-- finds the closest vectors without comparing the query to every row.
-- vector_cosine_ops makes it serve the <=> (cosine distance) operator.
CREATE INDEX idx_documents_embedding ON documents USING hnsw (embedding vector_cosine_ops);
