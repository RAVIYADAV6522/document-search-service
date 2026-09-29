import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DEFAULT_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'documents.json');

// Reads and parses documents.json. Takes the path as a parameter (defaulting
// to the project's own documents.json) so tests can point it at a small
// fixture file instead.
export async function loadDocuments(filePath = DEFAULT_PATH) {
  const raw = await readFile(filePath, 'utf8');
  const data = JSON.parse(raw);
  return data.documents ?? [];
}
