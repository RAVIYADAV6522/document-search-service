// Text embeddings for semantic search, computed inside this process with
// all-MiniLM-L6-v2: a small open-source sentence-transformer that maps text
// to 384 numbers capturing its meaning. Running it locally (ONNX runtime via
// transformers.js) means embedding the whole library costs nothing and has
// no API rate limit; documents and queries must use the same model, so the
// server loads it too. The quantized model is ~23 MB, downloaded once from
// Hugging Face and cached.
import { pipeline } from '@huggingface/transformers';

export const EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';
// Must match the vector(384) column in migration 003.
export const EMBEDDING_DIMENSIONS = 384;

let extractor;

// Loaded on first use and shared, so a server that never gets a semantic
// query never pays for it.
function load() {
  extractor ??= pipeline('feature-extraction', EMBEDDING_MODEL, { dtype: 'q8' });
  return extractor;
}

// Mean pooling over tokens plus L2 normalization: the standard way to turn
// this model's token outputs into one sentence vector.
export async function embed(texts) {
  const output = await (await load())(texts, { pooling: 'mean', normalize: true });
  return output.tolist();
}

// pgvector reads vectors as text like '[0.1,0.2,0.3]'.
export function toPgVector(values) {
  return `[${values.join(',')}]`;
}
