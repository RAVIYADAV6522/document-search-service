// Every SQL statement the service runs lives here. All values are passed as
// bind parameters ($1, $2, ...), never concatenated into the SQL text.
// Rows come back in the same shape documents.json uses (owner, created,
// tags), so the API response format doesn't depend on the storage layer.

// Every document with its tags, for building the in-memory cosine index.
export async function listDocuments(db) {
  const { rows } = await db.query(`
    SELECT d.id, d.title, d.body, d.owner_id AS owner, d.created_at AS created,
           COALESCE(array_agg(t.name ORDER BY t.name) FILTER (WHERE t.id IS NOT NULL), '{}') AS tags
    FROM documents d
    LEFT JOIN document_tags dt ON dt.document_id = d.id
    LEFT JOIN tags t ON t.id = dt.tag_id
    GROUP BY d.id
    ORDER BY d.created_at DESC
  `);
  return rows;
}
