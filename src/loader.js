import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DEFAULT_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'documents.json');

// Reads and parses documents.json (owners and documents). Used by the seed
// script; the running service reads from the database instead. Takes the
// path as a parameter so tests can point it at a small fixture file.
export async function loadDataset(filePath = DEFAULT_PATH) {
  const raw = await readFile(filePath, 'utf8');
  const data = JSON.parse(raw);
  return { owners: data.owners ?? [], documents: data.documents ?? [] };
}
