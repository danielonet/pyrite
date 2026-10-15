# Phase 2 — local LLM alongside the rules engine

Phase 2 is delivered in two steps. **Step 1, the `hybrid` engine, is
implemented** (below). **Step 2, editing the Java view and syncing back to
Python, is still roadmap only** (the rest of this file). [phase-1.md](phase-1.md)
covers the rules engine both steps build on.

## Step 1 — `hybrid` engine (implemented)

The rules engine translates every file: fast, deterministic, offline. A local
[Ollama](https://ollama.com) model then rewrites only the *functions* the rules
handle badly. It is the "pulled plug" LLM engine from
[llm-engine.md](llm-engine.md) brought back, but local (no API key, no cloud)
and scoped to hard functions instead of whole files.

Code: `src/translator/ollama/`

- `hardBlocks.ts` — `findHardBlocks` picks the outermost `def` blocks that are
  hard. A function is hard only when the rules demonstrably fail on it: the
  rules engine flagged something inside it (a warning, or a `TODO:
  untranslated` line), or it uses a construct known to come out wrong (nested
  comprehension, `:=`). Generators, `async`/`await`, lambdas and `exec`/`eval`
  are translated acceptably by the rules (annotated in a comment), so they do
  not qualify. The unit of work is the function: the sample project sends 0 of
  its 54 functions to the model, and a file with no hard function never
  touches Ollama.
- `hybridTranslator.ts` — `HybridTranslator` runs the rules first, then for
  each hard function (bottom-up, at most `maxBlocksPerFile`) sends the numbered
  Python plus the rules' Java draft to the model, and splices the answer over
  the draft. The model tags header lines with `// py:N`; the markers are
  stripped back into the source map (the same idea as the old LLM engine), so
  `Ctrl+Alt+J` navigation and Go to Definition keep working. A note line
  (`// Rewritten by <model> (<reason>) ...`) marks every rewritten function.
- `ollamaClient.ts` — `POST /api/chat`, `stream: false`, `temperature: 0`,
  `think: false` (thinking models are far too slow here).

Behavior worth knowing:

- **Fail soft, never fail silent.** Ollama unreachable, a timeout, an HTTP
  error or an unusable answer (unbalanced braces, Markdown left in) keeps the
  rules output for that function and adds a warning. After the server is found
  unreachable the translator stops trying for 60 s instead of waiting on every
  function.
- **Cache.** Answers are keyed by model + prompt and stored in
  `<outputFolder>/.pyrite/ollama-cache.json`, so a regeneration or a save only
  calls the model for functions that changed.
- **Speed.** On a CPU-only machine a 4B model took minutes per function (the
  first request also loads the model), so the default timeout is 300 s and
  `maxFunctionsPerFile` caps the cost. Prefer a small code model
  (`qwen2.5-coder`) and a GPU when you have one.

Use it:

- Settings: `pyrite.engine = "hybrid"`, plus `pyrite.ollama.url`,
  `pyrite.ollama.model`, `pyrite.ollama.timeoutSeconds`,
  `pyrite.ollama.maxFunctionsPerFile`.
- CLI: `pyrite <root> --engine hybrid [--ollama-url URL] [--ollama-model NAME]`.

Tests: `src/test/hybrid.test.ts` uses a fake chat function, so they need no
server.

### Real Java imports

After the function rewrites, the hybrid engine swaps the rules' import block
(`import logging;`, `import typing.Dict;`, `java.util.*` wildcards) for
explicit imports of real classes, so that a view can one day compile.

Code: `src/translator/imports/`

- `jdkClasses.ts` — every public top-level class of the packages the `java.se`
  modules export, by package. Generated from a real JDK by
  `npm run build:jdk-index` (`scripts/build-jdk-index.js` runs
  `scripts/JdkIndex.java`); the output is committed, so users need no JDK.
- `javaImports.ts` — `planImports` scans the Java body (strings and comments
  blanked out) for capitalized names not after a `.` and resolves them, in
  order: classes declared in the file, project imports, Lombok annotations,
  `java.lang` (no import), the JDK in `PREFERRED_PACKAGES` order (so `List` is
  `java.util.List`, never `java.awt.List`), and project classes used without a
  Python import. Project imports use `KnownMembers.modules` (Python module ->
  Java module class) and `KnownMembers.classes` (top-level class -> nested
  class FQN), both filled by the project scan in `mirror.ts`: a capitalized
  name becomes `import pkg.Module.Name;`, a function or constant
  `import static pkg.Module.name;`. What is left is sent to the model
  (`IMPORTS_SYSTEM_PROMPT`, one request per file, cached), and
  `acceptModelImports` keeps only imports of requested names, with JDK
  namespaces verified against the index. Decorators the rules kept as
  annotations (`@Property`, `@Fixture`) have no Java class and are listed,
  not sent.
- Non-project Python imports become `// python: <original line>` comments
  mapped to their Python line, and unresolved names one `// No Java import
  found for: ...` comment. The source map and symbols are shifted to match.

Two layout rules of the rules engine (all modes) exist for the same goal:
every view file is named after its public class (`Models.java`,
`InventoryInit.java`), and a class named like its module (`class
OrderService` in `order_service.py`) becomes the module's class instead of
`OrderService.OrderService`, which Java rejects
(`promoteModuleNamedClass` in `ruleTranslator.ts`; the project scan records it
in `KnownMembers.classes` so imports name `pkg.OrderService`).

Not done yet: the rest of what keeps a view from compiling, mainly Python
left in expressions (`logging.getLogger(__name__)`, `Tuple.zip(...)`), and a
promoted class extending another class of its own module (`class
Point(Base)` with `Base` in `point.py` would extend its own nested class).

Not done yet: choosing hard functions by anything smarter than the heuristics
above, running the model on module-level statements (only `def` blocks are
sent), and a per-function "re-translate with the model" command.

## Step 2 — edit the Java view, sync back (not implemented)

Roadmap only. No code exists for this yet.

## Goal

Let a Java developer edit the generated Java-flavored view directly, and
turn those edits back into the real Python source — so "reading as Java"
can grow into "steering the Python project from a Java-shaped view" without
ever hand-writing Python.

## Intended design

- **Function-level, not whole-file.** A whole-file round trip (Java view →
  Python) is lossy and would produce noisy, hard-to-review diffs. Instead,
  detect which methods/functions changed in the Java view (using the same
  source map from [phase-1.md](phase-1.md) to know which Python
  function each edited region maps to).
- **LLM-translated, with the original as context.** For each changed
  method, ask an LLM to translate just that method back to Python, giving it
  the original Python function as context so it preserves everything it
  isn't asked to change. This reuses the "pull the plug" LLM engine
  described in [llm-engine.md](llm-engine.md) — Phase 2 is the reason that
  engine existed at all; the Java-flavored *reading* view was a stepping
  stone toward this.
- **Approval-gated.** Never write to the Python source directly. Show the
  resulting Python diff (per function) for review, same as any AI-authored
  change, before it's applied. This is the same "Supervised Development, not
  vibe coding" principle the whole project is built around (see the
  top-level README): the developer reads and approves every change at the
  Python level, even though they authored it by editing Java.

## Open questions (unresolved, for whoever picks this up)

- How to detect "this method changed" robustly across re-generations of the
  Java view (diffing against the last-generated `.java-view` copy vs. a
  stored snapshot).
- What happens when an edit doesn't map cleanly to one Python function
  (renamed method, split/merged methods, edits that span a class boundary).
- Whether partial acceptance (approve some changed methods, reject others)
  is needed for the first version, or whether it can start all-or-nothing
  per file.
- Conflict handling when the Python source changed (e.g. someone else's
  commit) since the Java view was last generated.
