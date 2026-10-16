// Retrieval-augmented generation for POST /ask: find the documents most
// relevant to the question, then have the model answer using only those,
// citing each one it relied on by id. The model never sees the rest of the
// library, so an answer can always be traced back to its sources.

export const ASK_SOURCES = 5;

const SYSTEM = `You answer questions about a company's internal documents, using ONLY the documents provided, never outside knowledge.

Step 1: Decide whether any document is about the topic of the question.
- If none is, reply exactly: "I couldn't find that in the documents." and stop.
Step 2: Otherwise, always answer from the relevant documents, even if they don't contain the exact thing asked:
- Questions often don't match the documents word for word. Report what the documents do say about the topic (names, numbers, findings).
- If something asked for is not in them, add one short sentence saying what is missing.
- Each document has a date; use it for questions about the newest, latest or oldest.
- If the input is just a topic or keyword (e.g. "budget"), summarize what the documents say about it.

Every sentence must end with the ids of the documents it came from in square brackets, e.g. [doc-001] or [doc-001, doc-002].
Keep the answer under 120 words, in plain text without markdown.`;

export function buildPrompt(question, docs) {
  const context = docs
    .map((d) => `[${d.id}] ${d.title}\nDate: ${d.created ? new Date(d.created).toISOString().slice(0, 10) : 'unknown'}\nTags: ${d.tags.join(', ')}\n${d.body}`)
    .join('\n\n---\n\n');
  return `Documents:\n\n${context}\n\nQuestion: ${question}`;
}

// The ids the answer actually cites, in order, limited to the sources given
// (a model can invent an id; it is dropped rather than shown as a source).
export function citedIds(answer, docs) {
  const known = new Set(docs.map((d) => d.id));
  const ids = [...answer.matchAll(/\[([^\]]+)\]/g)].flatMap((m) => m[1].split(/\s*,\s*/));
  return [...new Set(ids)].filter((id) => known.has(id));
}

export async function answerQuestion(ai, question, docs) {
  if (docs.length === 0) return { answer: "I couldn't find that in the documents.", model: null, cited: [] };
  const { text, model } = await ai.generate({ system: SYSTEM, prompt: buildPrompt(question, docs) });
  return { answer: text, model, cited: citedIds(text, docs) };
}
