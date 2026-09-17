# tree-sitter — real parsing beside the rules engine (step 1 of the front-end swap)

**Status: the parser is in; the translator does not use it as its front end yet.**

Pyrite's rules engine works on *logical lines* (`src/translator/rules/logicalLines.ts`)
and regular expressions. That is fast and dependency-free, but every construct it gets
wrong is a symptom of not having a syntax tree: precedence, nesting, comprehension
scoping, strings with tricky quoting, decorators with arguments, multi-target
assignments. A corpus run over the Python standard library (`src/test/corpus.test.ts`)
is how such gaps are found today.

[tree-sitter](https://tree-sitter.github.io/tree-sitter/) gives a real Python syntax
tree, offline, in-process, from a WebAssembly build of the grammar. No Python
installation is needed. It runs on the extension host, in the mirror worker thread
and in the CLI alike.

## What is wired in now

`src/parser/pythonParser.ts` (dependencies `web-tree-sitter` + `tree-sitter-python`):

- `checkSyntax(source)` — syntax errors (unexpected or missing tokens) with line and
  column. `mirrorFile` runs it on every file: a file with errors is still translated,
  but its Java view starts with a `// WARNING: Python syntax error ...` block and the
  problem is reported as a warning, instead of a garbled view passing as faithful.
- `definitions(tree)` — the classes and functions a module declares (module level,
  class bodies, and under module-level `if`/`try`). The corpus test uses this as an
  **oracle**: every definition tree-sitter sees must come out of the rules engine as a
  symbol. This is the first check that compares the engine against ground truth
  rather than against itself.

Every entry point returns "no information" if the WebAssembly runtime cannot be
loaded, so a packaging problem can never break translation.

## Migration plan

The step-by-step plan for moving the translator's front end onto the tree, with
node types, files to change, acceptance criteria, estimates and a progress log,
is in [frontend-migration.md](frontend-migration.md).

## Packaging notes

- `web-tree-sitter` needs `tree-sitter.wasm` next to `tree-sitter.cjs`;
  `tree-sitter-python` ships `tree-sitter-python.wasm`. Both are resolved at runtime
  with `require.resolve`, so they must stay under `node_modules` in the VSIX. If the
  extension is ever bundled (esbuild/webpack), copy the two `.wasm` files next to the
  bundle and point `Parser.init({ locateFile })` / `Language.load` at them.
- `.vscodeignore` drops the native prebuilds, grammar sources and debug builds of
  those packages; only the two `.wasm` files and the JS loader are shipped.
