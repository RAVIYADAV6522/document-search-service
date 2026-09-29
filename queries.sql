-- Queries for the document search service. Written for PostgreSQL,
-- against the schema in schema.sql. $1, $2, ... are bind parameters.

-- 1. The 10 most recent documents belonging to one owner.
SELECT d.id, d.title, d.body, d.owner_id, d.created_at
FROM documents d
WHERE d.owner_id = $1
ORDER BY d.created_at DESC
LIMIT 10;

-- 2. For every tag, how many documents carry it, most common first.
SELECT t.name AS tag, COUNT(dt.document_id) AS document_count
FROM tags t
LEFT JOIN document_tags dt ON dt.tag_id = t.id
GROUP BY t.id, t.name
ORDER BY document_count DESC, t.name ASC;

-- 3. Documents that have both the tag 'finance' and the tag 'q4' (not either, both).
-- Self-join document_tags on document_id, once per required tag: each join
-- can be served by the (tag_id, document_id) index, so cost scales with how
-- many documents carry the rarer tag rather than the full table -- avoiding
-- the full scan an unindexed array-containment check would need. See
-- NOTES.md for why, and for how this was actually verified with EXPLAIN.
SELECT d.id, d.title, d.body, d.owner_id, d.created_at
FROM documents d
JOIN document_tags dt1 ON dt1.document_id = d.id
JOIN tags t1 ON t1.id = dt1.tag_id AND t1.name = 'finance'
JOIN document_tags dt2 ON dt2.document_id = d.id
JOIN tags t2 ON t2.id = dt2.tag_id AND t2.name = 'q4';

-- 4. Any owner who has never created a document.
SELECT o.id, o.name, o.email
FROM owners o
WHERE NOT EXISTS (
    SELECT 1 FROM documents d WHERE d.owner_id = o.id
);
