// Fills in documents.embedding for semantic search, using the local model in
// src/embeddings.js. Only documents without one are processed, so it is
// safe to stop and re-run: it picks up where it left off. Re-seeding keeps
// existing embeddings.
//   npm run embed
import { createPool } from '../src/db.js';
import { embed, toPgVector } from '../src/embeddings.js';
import { documentsWithoutEmbedding, saveEmbeddings } from '../src/repository.js';

const BATCH = 64;

const pool = createPool();
try {
  let done = 0;
  const started = Date.now();
  for (;;) {
    const docs = await documentsWithoutEmbedding(pool, BATCH);
    if (docs.length === 0) break;
    const vectors = await embed(docs.map((d) => `${d.title}. ${d.body}`));
    await saveEmbeddings(pool, docs.map((d) => d.id), vectors.map(toPgVector));
    done += docs.length;
    if (done % 1024 === 0) console.log(`embedded ${done} documents`);
  }
  console.log(`done: ${done} documents embedded in ${((Date.now() - started) / 1000).toFixed(0)} s`);
} finally {
  await pool.end();
}
