/**
 * LLM-based translator (Claude via the official Anthropic SDK).
 *
 * Produces a more idiomatic Java-flavored reading view than the rule engine,
 * at the cost of an API call per file. Source-line correspondence is kept by
 * asking the model to tag declarations with `// py:N` markers, which we strip
 * from the displayed text and turn into a sparse source map.
 */

import Anthropic from '@anthropic-ai/sdk';
import { TranslateInput, TranslateResult, Translator } from '../types';
import { translateWithRules } from '../rules/ruleTranslator';

export interface LlmOptions {
  apiKey: string;
  model: string;
  effort: 'low' | 'medium' | 'high';
  /** When the LLM call fails, fall back to the rule engine instead of throwing. */
  fallbackToRules: boolean;
  baseURL?: string;
}

const SYSTEM_PROMPT = `You translate Python source files into a Java-flavored *reading view* for Java developers who do not know Python.

Goals, in priority order:
1. Faithfulness: keep every statement, name, string, comment and docstring from the Python source. Do not summarize, reorder or drop code. Do not add behavior.
2. Readability for a Java developer: Java syntax, braces, semicolons, explicit types (infer from hints, defaults and usage; use var or Object when unknown), docstrings as Javadoc, comments as // comments.
3. Structure: one Python module becomes one \`public final class <ModuleName>\`; Python classes become nested \`public static class\`; module-level functions become static methods; \`if __name__ == "__main__":\` becomes \`public static void main(String[] args)\`. Keep Python's file order.

Conventions:
- Keep snake_case identifiers exactly as in Python so readers can grep the original source.
- Python idioms map to Java equivalents: comprehensions -> streams, f-strings -> concatenation or String.format, dict -> Map, list -> List, tuple -> Tuple.of(...), None -> null, self -> this, raise -> throw new, with -> try-with-resources, decorators -> annotations.
- When something has no Java equivalent, keep it as close to Java as possible and add a short /* python: ... */ comment explaining it. Never silently drop it.
- The output does NOT need to compile. Never invent helper classes; prefer a comment.
- Add a trailing marker comment \`// py:N\` (N = 1-based Python line number) at the end of every class header, method header, and control-flow header line (if/for/while/try/with). Do not add markers elsewhere.
- Output only the Java text. No Markdown fences, no explanations.`;

export class LlmTranslator implements Translator {
  readonly name = 'llm' as const;
  private readonly client: Anthropic;

  constructor(private readonly options: LlmOptions) {
    this.client = new Anthropic({ apiKey: options.apiKey, baseURL: options.baseURL });
  }

  async translate(input: TranslateInput): Promise<TranslateResult> {
    try {
      return await this.callModel(input);
    } catch (err) {
      if (!this.options.fallbackToRules) throw err;
      const fallback = translateWithRules(input);
      const reason = err instanceof Error ? err.message : String(err);
      fallback.warnings.unshift(`${input.relativePath}: LLM translation failed (${reason}); used the rules engine instead.`);
      return fallback;
    }
  }

  private async callModel(input: TranslateInput): Promise<TranslateResult> {
    const numbered = input.source
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((l, i) => `${String(i + 1).padStart(4, ' ')} | ${l}`)
      .join('\n');

    const stream = this.client.beta.messages.stream({
      model: this.options.model,
      max_tokens: 64000,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      thinking: { type: 'adaptive' },
      output_config: { effort: this.options.effort },
      // Server-side refusal fallback: if the primary model declines, the API re-runs on a fallback model.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      messages: [
        {
          role: 'user',
          content: `File: ${input.relativePath}\n\nPython source (each line prefixed with its line number and " | "; the prefix is not part of the code):\n\n${numbered}`,
        },
      ],
    });
    const message = await stream.finalMessage();

    if (message.stop_reason === 'refusal') {
      throw new Error(`model declined to translate (${message.stop_details?.category ?? 'refusal'})`);
    }
    if (message.stop_reason === 'max_tokens') {
      throw new Error('model output was truncated (max_tokens)');
    }

    const text = message.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    return parseModelOutput(stripFences(text), input);
  }
}

function stripFences(text: string): string {
  const m = /^\s*```(?:java)?\s*\n([\s\S]*?)\n```\s*$/.exec(text);
  return m ? m[1] : text;
}

/** Strip `// py:N` markers and build a sparse source map (each line inherits the nearest marker above it). */
export function parseModelOutput(text: string, input: TranslateInput): TranslateResult {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const sourceMap: number[] = [];
  const cleaned: string[] = [];
  let current = 0;
  for (const raw of lines) {
    const m = /\s*\/\/\s*py:(\d+)\s*$/.exec(raw);
    if (m) {
      current = Number(m[1]);
      cleaned.push(raw.slice(0, m.index).replace(/\s+$/, ''));
    } else {
      cleaned.push(raw);
    }
    sourceMap.push(current);
  }
  const header = [`// Java view of ${input.relativePath}`, '// Generated by Pyrite (LLM engine). Read-only reading aid: edit the Python source instead.', ''];
  return {
    java: [...header, ...cleaned].join('\n'),
    sourceMap: [0, 0, 0, ...sourceMap],
    warnings: [],
    engine: 'llm',
  };
}
