# LLM engine — pulled the plug (concept preserved here)

**Status: removed from the codebase.** This document is the record of the
`llm` translation engine that used to sit alongside the `rules` engine
(see [phase-1.md](phase-1.md)), kept so it can be re-plugged in later
without re-deriving the design. The code below is no longer in `src/`; it is
reproduced here as spec/reference. If you want it back, this is everything
you need to reconstruct it.

## Why it existed, and why it was pulled

The `rules` engine is deterministic and offline but mechanical: it does a
faithful, line-oriented job, not always an idiomatic one. The `llm` engine
asked Claude to produce a more idiomatic Java-flavored reading view of the
same file, at the cost of an API call per file (latency, cost, an API key
to manage, network dependence, non-determinism).

It was removed to simplify the extension down to its offline, deterministic
core (Phase 1's `rules` engine) — no API key setup, no network calls, no
external dependency (`@anthropic-ai/sdk`), fully reproducible output. The
concept is preserved here rather than deleted outright because it's also the
mechanism [phase-2.md](phase-2.md)'s Java→Python sync-back would need.

## Surface area it added (all removed)

- **Engine option**: `pyrite.engine` setting accepted `"llm"` in addition to
  `"rules"`.
- **Settings**: `pyrite.llm.model` (default `claude-opus-5`),
  `pyrite.llm.effort` (`low`/`medium`/`high`, default `medium`),
  `pyrite.llm.fallbackToRules` (default `true` — use the rules engine for a
  file when the LLM call fails).
- **Command**: `pyrite.setApiKey` ("Pyrite: Set LLM API Key") — prompted for
  an Anthropic API key and stored it in VS Code's secret storage
  (`context.secrets`, key `pyrite.llm.apiKey`), falling back to the
  `ANTHROPIC_API_KEY` environment variable if no stored key was set.
- **CLI flags**: `--engine llm`, `--model <id>`, `--effort low|medium|high`
  on the `pyrite` CLI, reading `ANTHROPIC_API_KEY` from the environment.
- **About panel**: showed the configured LLM model when `engine === 'llm'`
  and a "Set LLM API Key" button.
- **Dependency**: `@anthropic-ai/sdk`.

## Design

### `EngineConfig` / `createTranslator` (`src/translator/index.ts`)

```ts
export type EngineName = 'rules' | 'llm';

export interface EngineConfig {
  engine: EngineName;
  llm?: Partial<LlmOptions> & { apiKey?: string };
}

export function createTranslator(config: EngineConfig): { translator: Translator; note?: string } {
  if (config.engine === 'llm') {
    const apiKey = config.llm?.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return {
        translator: new RuleBasedTranslator(),
        note: 'LLM engine selected but no API key is configured; using the rules engine. Run "Pyrite: Set LLM API Key" or set ANTHROPIC_API_KEY.',
      };
    }
    return {
      translator: new LlmTranslator({
        apiKey,
        model: config.llm?.model ?? 'claude-opus-5',
        effort: config.llm?.effort ?? 'medium',
        fallbackToRules: config.llm?.fallbackToRules ?? true,
        baseURL: config.llm?.baseURL,
      }),
    };
  }
  return { translator: new RuleBasedTranslator() };
}
```

Key behavior worth keeping if this comes back: **fail soft, never fail
silent** — no API key, or any call error, degrades to the rules engine
rather than blocking the developer, but always surfaces a note/warning
explaining why the output isn't the LLM's.

### `LlmTranslator` (`src/translator/llm/llmTranslator.ts`)

Called Claude via the official Anthropic SDK (`@anthropic-ai/sdk`),
`client.beta.messages.stream(...)`, with:

- A system prompt (reproduced in full below) instructing faithfulness first,
  Java readability second, structure rules third.
- Adaptive thinking (`thinking: { type: 'adaptive' }`) and a configurable
  `output_config.effort`.
- Server-side refusal fallback (`betas: ['server-side-fallback-2026-07-01']`,
  `fallbacks: 'default'`) so a declining primary model retried on a fallback
  model before the caller had to handle it.
- The Python source sent line-numbered (`"  12 | some_code"`), so the model
  could tag output lines with a trailing `// py:N` marker on every class
  header, method header, and control-flow header line.
- `parseModelOutput` stripped those `// py:N` markers back out of the
  displayed text and turned them into the same sparse `sourceMap` format the
  rules engine produces (each line inherits the nearest marker above it),
  so two-way navigation (`Ctrl+Alt+J`) worked identically regardless of
  engine.
- On any error (refusal, `max_tokens` truncation, network failure), and
  when `fallbackToRules` was true (default), it fell back to
  `translateWithRules` for that file and prepended a warning explaining why.

Full system prompt, for faithful reconstruction:

```
You translate Python source files into a Java-flavored *reading view* for Java developers who do not know Python.

Goals, in priority order:
1. Faithfulness: keep every statement, name, string, comment and docstring from the Python source. Do not summarize, reorder or drop code. Do not add behavior.
2. Readability for a Java developer: Java syntax, braces, semicolons, explicit types (infer from hints, defaults and usage; use var or Object when unknown), docstrings as Javadoc, comments as // comments.
3. Structure: one Python module becomes one `public final class <ModuleName>`; Python classes become nested `public static class`; module-level functions become static methods; `if __name__ == "__main__":` becomes `public static void main(String[] args)`. Keep Python's file order.

Conventions:
- Keep snake_case identifiers exactly as in Python so readers can grep the original source.
- Python idioms map to Java equivalents: comprehensions -> streams, f-strings -> concatenation or String.format, dict -> Map, list -> List, tuple -> Tuple.of(...), None -> null, self -> this, raise -> throw new, with -> try-with-resources, decorators -> annotations.
- When something has no Java equivalent, keep it as close to Java as possible and add a short /* python: ... */ comment explaining it. Never silently drop it.
- The output does NOT need to compile. Never invent helper classes; prefer a comment.
- Add a trailing marker comment `// py:N` (N = 1-based Python line number) at the end of every class header, method header, and control-flow header line (if/for/while/try/with). Do not add markers elsewhere.
- Output only the Java text. No Markdown fences, no explanations.
```

### Wiring into the extension (`src/extension.ts`)

- `settings()` read `pyrite.llm.model` / `pyrite.llm.effort` /
  `pyrite.llm.fallbackToRules` alongside the existing engine/output/exclude/
  watch settings.
- `buildTranslator(context)` resolved the API key (secret storage, else
  `ANTHROPIC_API_KEY`) only when `engine === 'llm'`, passed it into
  `createTranslator`, and surfaced any `note` (e.g. missing key) as both an
  output-channel line and a warning toast.
- `setApiKey(context)` showed a password input box, stored/deleted the
  secret, and offered to flip `pyrite.engine` to `"llm"` after a successful
  save.

### `package.json` contributions

```json
"pyrite.llm.model": {
  "type": "string",
  "default": "claude-opus-5",
  "description": "Claude model ID used by the LLM engine."
},
"pyrite.llm.effort": {
  "type": "string",
  "enum": ["low", "medium", "high"],
  "default": "medium",
  "description": "Reasoning effort for the LLM engine. Lower is faster and cheaper."
},
"pyrite.llm.fallbackToRules": {
  "type": "boolean",
  "default": true,
  "description": "If the LLM call fails (no key, network error, refusal), fall back to the rule-based translator for that file."
}
```

plus `"llm"` as a second `pyrite.engine` enum value, the `pyrite.setApiKey`
command contribution, and the `@anthropic-ai/sdk` dependency.

## How to plug it back in

1. Restore `src/translator/llm/llmTranslator.ts` from this document (or from
   git history — it existed before this removal commit).
2. Restore `EngineName = 'rules' | 'llm'`, the `llm` branch in
   `createTranslator`, and widen `Translator['name']` /
   `TranslateResult['engine']` back to `'rules' | 'llm'` in
   `src/translator/types.ts`.
3. Re-add the settings, command, and About-panel bits in `src/extension.ts`,
   `src/aboutView.ts` and `package.json` listed above.
4. Re-add the `@anthropic-ai/sdk` dependency.
5. Re-add CLI support (`--engine llm`, `--model`, `--effort`) in
   `src/cli.ts`.
6. Restore the `parseModelOutput` unit test (it lived in
   `src/test/rules.test.ts`, asserting `// py:N` markers are stripped into a
   sparse source map).
