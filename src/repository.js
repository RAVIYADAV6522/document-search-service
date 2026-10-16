// Every SQL statement the service runs lives here. All values are passed as
// bind parameters ($1, $2, ...), never concatenated into the SQL text.
// Rows come back in the same shape documents.json uses (owner, created,
// tags) plus the owner's display name, so the API response format doesn't
// depend on the storage layer.

// Every document with its tags, for building the in-memory cosine index.
export async function listDocuments(db) {
  const { rows } = await db.query(`
    SELECT d.id, d.title, d.body, d.owner_id AS owner, o.name AS owner_name, d.created_at AS created,
           COALESCE(array_agg(t.name ORDER BY t.name) FILTER (WHERE t.id IS NOT NULL), '{}') AS tags
    FROM documents d
    JOIN owners o ON o.id = d.owner_id
    LEFT JOIN document_tags dt ON dt.document_id = d.id
    LEFT JOIN tags t ON t.id = dt.tag_id
    GROUP BY d.id, o.id
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
    `SELECT d.id, d.title, d.body, d.owner_id AS owner, o.name AS owner_name, d.created_at AS created, ${TAGS_OF_D}
     FROM documents d
     JOIN owners o ON o.id = d.owner_id
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
// Paginated, with the full match count, since a common tag can match
// thousands of documents.
const ALL_TAGS_MATCHES = `
  SELECT dt.document_id
  FROM document_tags dt
  JOIN tags t ON t.id = dt.tag_id
  WHERE t.name = ANY($1::text[])
  GROUP BY dt.document_id
  HAVING COUNT(*) = cardinality($1::text[])`;

export async function documentsWithAllTags(db, tagNames, { limit, offset }) {
  const [page, count] = await Promise.all([
    db.query(
      `WITH matches AS (${ALL_TAGS_MATCHES})
       SELECT d.id, d.title, d.body, d.owner_id AS owner, o.name AS owner_name, d.created_at AS created, ${TAGS_OF_D}
       FROM documents d
       JOIN owners o ON o.id = d.owner_id
       JOIN matches m ON m.document_id = d.id
       ORDER BY d.created_at DESC, d.id
       LIMIT $2 OFFSET $3`,
      [tagNames, limit, offset],
    ),
    db.query(`SELECT COUNT(*)::int AS total FROM (${ALL_TAGS_MATCHES}) AS matches`, [tagNames]),
  ]);
  return { total: count.rows[0].total, results: page.rows };
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

// Full-text search (GET /search?engine=sql). websearch_to_tsquery accepts
// the same loose syntax people type into search boxes ("quoted phrases",
// -exclusions, or) and never throws on bad input. @@ is answered by the GIN
// index on search_vector; ts_rank scores each match, weighting title terms
// above body terms. Ties fall back to newest first, like the cosine ranker.
export async function searchFullText(db, query, { limit, offset }) {
  const [page, count] = await Promise.all([
    db.query(
      `SELECT d.id, d.title, d.body, d.owner_id AS owner, o.name AS owner_name, d.created_at AS created, ${TAGS_OF_D},
              ts_rank(d.search_vector, q.query) AS score
       FROM documents d
       JOIN owners o ON o.id = d.owner_id
       CROSS JOIN websearch_to_tsquery('english', $1) AS q(query)
       WHERE d.search_vector @@ q.query
       ORDER BY score DESC, d.created_at DESC
       LIMIT $2 OFFSET $3`,
      [query, limit, offset],
    ),
    db.query(
      `SELECT COUNT(*)::int AS total
       FROM documents d
       WHERE d.search_vector @@ websearch_to_tsquery('english', $1)`,
      [query],
    ),
  ]);
  return { total: count.rows[0].total, results: page.rows };
}

// Semantic search (GET /search?engine=semantic): the documents whose
// embeddings are closest to the query's, by cosine distance (<=>), served by
// the HNSW index from migration 003. score is cosine similarity (1 - distance).
// HNSW only returns as many rows as hnsw.ef_search (default 40), so it is
// raised for this transaction to cover every candidate asked for.
export async function searchSemantic(db, queryVector, { candidates }) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL hnsw.ef_search = ${Math.max(40, candidates)}`);
    const { rows } = await client.query(
      `SELECT d.id, d.title, d.body, d.owner_id AS owner, o.name AS owner_name, d.created_at AS created, ${TAGS_OF_D},
              1 - (d.embedding <=> $1::vector) AS score
       FROM documents d
       JOIN owners o ON o.id = d.owner_id
       WHERE d.embedding IS NOT NULL
       ORDER BY d.embedding <=> $1::vector
       LIMIT $2`,
      [queryVector, candidates],
    );
    await client.query('COMMIT');
    return rows;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Documents still waiting for an embedding (scripts/embed.js).
export async function documentsWithoutEmbedding(db, limit) {
  const { rows } = await db.query(
    'SELECT id, title, body FROM documents WHERE embedding IS NULL ORDER BY id LIMIT $1',
    [limit],
  );
  return rows;
}

// Stores one batch of embeddings in a single statement: two parallel arrays
// unnested into rows and joined on id.
export async function saveEmbeddings(db, ids, vectors) {
  await db.query(
    `UPDATE documents d SET embedding = v.embedding::vector
     FROM unnest($1::text[], $2::text[]) AS v(id, embedding)
     WHERE d.id = v.id`,
    [ids, vectors],
  );
}
