// Loads documents.json into the database. Safe to run repeatedly: rows are
// upserted by id, and each seeded document's tags are replaced, so the
// database ends up matching the file. Everything runs in one transaction.
//
//   npm run seed                  the 28 hand-written documents
//   npm run seed -- --total=10000 plus generated ones up to 10,000 in total
import { loadDataset } from '../src/loader.js';
import { createPool } from '../src/db.js';
import { expandDataset } from './generate.js';

export async function seed(pool, { owners, documents }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Bulk loads take longer than the 5 s limit set for API queries.
    await client.query("SET LOCAL statement_timeout = '120s'");

    // unnest() turns parallel arrays into rows, so each table is filled
    // with a single statement instead of one INSERT per row.
    await client.query(
      `INSERT INTO owners (id, name, email)
       SELECT * FROM unnest($1::text[], $2::text[], $3::text[])
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, email = EXCLUDED.email`,
      [owners.map((o) => o.id), owners.map((o) => o.name), owners.map((o) => o.email)],
    );

    await client.query(
      `INSERT INTO documents (id, title, body, owner_id, created_at)
       SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::timestamptz[])
       ON CONFLICT (id) DO UPDATE SET
         title = EXCLUDED.title, body = EXCLUDED.body,
         owner_id = EXCLUDED.owner_id, created_at = EXCLUDED.created_at`,
      [
        documents.map((d) => d.id),
        documents.map((d) => d.title),
        documents.map((d) => d.body),
        documents.map((d) => d.owner),
        documents.map((d) => d.created),
      ],
    );

    const tagNames = [...new Set(documents.flatMap((d) => d.tags ?? []))];
    await client.query(
      `INSERT INTO tags (name) SELECT unnest($1::text[]) ON CONFLICT (name) DO NOTHING`,
      [tagNames],
    );

    const pairs = documents.flatMap((d) => (d.tags ?? []).map((tag) => [d.id, tag]));
    await client.query('DELETE FROM document_tags WHERE document_id = ANY($1::text[])', [
      documents.map((d) => d.id),
    ]);
    await client.query(
      `INSERT INTO document_tags (document_id, tag_id)
       SELECT p.document_id, t.id
       FROM unnest($1::text[], $2::text[]) AS p(document_id, tag_name)
       JOIN tags t ON t.name = p.tag_name
       ON CONFLICT DO NOTHING`,
      [pairs.map(([id]) => id), pairs.map(([, tag]) => tag)],
    );

    await client.query('COMMIT');
    return { owners: owners.length, documents: documents.length, tags: tagNames.length };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const totalArg = process.argv.find((a) => a.startsWith('--total='));
  const total = totalArg ? Number(totalArg.split('=')[1]) : 0;
  if (totalArg && !(Number.isInteger(total) && total > 0)) {
    throw new Error(`--total must be a positive integer, got "${totalArg}"`);
  }
  const pool = createPool();
  try {
    const started = Date.now();
    const counts = await seed(pool, expandDataset(await loadDataset(), total));
    console.log(
      `seeded ${counts.owners} owners, ${counts.documents} documents, ${counts.tags} tags in ${Date.now() - started} ms`,
    );
  } finally {
    await pool.end();
  }
}
