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

// A document's tags as a sorted array, as a correlated subquery so each
// query below can return documents in the same shape as listDocuments.
const TAGS_OF_D = `
  COALESCE((SELECT array_agg(t.name ORDER BY t.name)
            FROM document_tags dt JOIN tags t ON t.id = dt.tag_id
            WHERE dt.document_id = d.id), '{}') AS tags`;

export async function ownerExists(db, ownerId) {
  const { rowCount } = await db.query('SELECT 1 FROM owners WHERE id = $1', [ownerId]);
  return rowCount > 0;
}

// queries.sql #1: the 10 most recent documents for one owner, served by
// idx_documents_owner_created.
export async function recentDocumentsForOwner(db, ownerId) {
  const { rows } = await db.query(
    `SELECT d.id, d.title, d.body, d.owner_id AS owner, d.created_at AS created, ${TAGS_OF_D}
     FROM documents d
     WHERE d.owner_id = $1
     ORDER BY d.created_at DESC
     LIMIT 10`,
    [ownerId],
  );
  return rows;
}

// queries.sql #2: how many documents carry each tag, most common first.
export async function tagStats(db) {
  const { rows } = await db.query(`
    SELECT t.name AS tag, COUNT(dt.document_id)::int AS document_count
    FROM tags t
    LEFT JOIN document_tags dt ON dt.tag_id = t.id
    GROUP BY t.id, t.name
    ORDER BY document_count DESC, t.name ASC
  `);
  return rows;
}

// queries.sql #3, generalized from exactly two tags to any number: keep the
// documents whose matching tag rows number as many as the tags asked for.
// tagNames must already be de-duplicated, or the count can never match.
export async function documentsWithAllTags(db, tagNames) {
  const { rows } = await db.query(
    `WITH matches AS (
       SELECT dt.document_id
       FROM document_tags dt
       JOIN tags t ON t.id = dt.tag_id
       WHERE t.name = ANY($1::text[])
       GROUP BY dt.document_id
       HAVING COUNT(*) = cardinality($1::text[])
     )
     SELECT d.id, d.title, d.body, d.owner_id AS owner, d.created_at AS created, ${TAGS_OF_D}
     FROM documents d
     JOIN matches m ON m.document_id = d.id
     ORDER BY d.created_at DESC`,
    [tagNames],
  );
  return rows;
}

// queries.sql #4: owners who have never created a document.
export async function inactiveOwners(db) {
  const { rows } = await db.query(`
    SELECT o.id, o.name, o.email
    FROM owners o
    WHERE NOT EXISTS (SELECT 1 FROM documents d WHERE d.owner_id = o.id)
    ORDER BY o.id
  `);
  return rows;
}
