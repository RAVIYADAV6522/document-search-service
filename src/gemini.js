// A small client for the Google Gemini API, used to generate the answers
// for /ask. Plain fetch, no SDK. The API key is
// sent in a header, never in the URL, so it can't end up in a log line.

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const TIMEOUT_MS = 12_000;
// Free-tier models are sometimes overloaded (503) or slow; each is tried in
// turn until one answers.
const DEFAULT_CHAT_MODELS = 'gemini-flash-latest,gemini-3.1-flash-lite,gemini-3.5-flash-lite,gemini-flash-lite-latest';

export class GeminiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'GeminiError';
    this.status = status;
  }
}

export function createGemini({
  apiKey = process.env.GEMINI_API_KEY,
  chatModels = (process.env.GEMINI_CHAT_MODELS || DEFAULT_CHAT_MODELS).split(',').map((m) => m.trim()),
  fetchImpl = fetch,
} = {}) {
  if (!apiKey) return null;

  async function call(model, method, body) {
    const res = await fetchImpl(`${BASE_URL}/models/${model}:${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new GeminiError(res.status, data.error?.message ?? `Gemini ${method} failed (${res.status})`);
    }
    return data;
  }

  async function generateWith(model, { system, prompt }) {
    const data = await call(model, 'generateContent', {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2 },
    });
    const parts = data.candidates?.[0]?.content?.parts ?? [];
    const text = parts.filter((p) => !p.thought).map((p) => p.text ?? '').join('').trim();
    if (!text) throw new GeminiError(502, 'Gemini returned an empty answer');
    return text;
  }

  // Returns the answer and the model that wrote it. Only overload, rate
  // limit, timeout and server errors move on to the next model; a bad
  // request would fail the same way everywhere.
  async function generate(request) {
    let lastError;
    for (const model of chatModels) {
      try {
        return { text: await generateWith(model, request), model };
      } catch (err) {
        const retryable = err.name === 'TimeoutError' || err.status === 429 || err.status >= 500;
        if (!retryable) throw err;
        lastError = err;
      }
    }
    throw lastError;
  }

  return { generate };
}
