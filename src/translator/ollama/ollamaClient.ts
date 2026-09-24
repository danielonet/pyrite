/**
 * Minimal client for a local Ollama server (https://ollama.com), using its `/api/chat` endpoint.
 * Uses the global `fetch` (Node 18+, and the VS Code extension host).
 */

export interface OllamaConnection {
  /** Base URL of the Ollama server, e.g. "http://localhost:11434". */
  url: string;
  /** Model name as `ollama list` shows it, e.g. "qwen2.5-coder:7b". */
  model: string;
  /** Give up on one request after this many milliseconds. */
  timeoutMs: number;
}

/** A failed Ollama call. `unreachable` means the server could not be contacted at all (as opposed to a bad answer). */
export class OllamaError extends Error {
  constructor(message: string, readonly unreachable: boolean) {
    super(message);
    this.name = 'OllamaError';
  }
}

export type ChatFn = (conn: OllamaConnection, system: string, user: string) => Promise<string>;

/** Send one system + user prompt and return the model's reply text. */
export const ollamaChat: ChatFn = async (conn, system, user) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), conn.timeoutMs);
  try {
    const res = await fetch(`${conn.url.replace(/\/+$/, '')}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: conn.model,
        stream: false,
        // Thinking models (qwen3, ...) are far too slow for this; the answer is a translation, not a puzzle.
        think: false,
        // Deterministic output keeps the view stable between regenerations.
        options: { temperature: 0 },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });
    if (res.status === 404) {
      // Ollama answers 404 when the model has not been pulled.
      throw new OllamaError(`model "${conn.model}" is not installed in Ollama; run "ollama pull ${conn.model}" or set pyrite.ollama.model to one from "ollama list"`, true);
    }
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 200);
      throw new OllamaError(`Ollama returned HTTP ${res.status}${body ? `: ${body}` : ''}`, false);
    }
    const data = (await res.json()) as { message?: { content?: string } };
    const content = data.message?.content;
    if (!content) throw new OllamaError('Ollama returned an empty reply', false);
    return content;
  } catch (err) {
    if (err instanceof OllamaError) throw err;
    if (controller.signal.aborted) throw new OllamaError(`Ollama did not answer within ${Math.round(conn.timeoutMs / 1000)}s`, false);
    throw new OllamaError(`Could not reach Ollama at ${conn.url}: ${err instanceof Error ? err.message : String(err)}`, true);
  } finally {
    clearTimeout(timer);
  }
};
