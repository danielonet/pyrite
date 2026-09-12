# Phase 1 — read-only mirror (implemented)

Pyrite mirrors every `.py` file in a workspace into a parallel `.java-view/`
folder, translating each module into a Java-flavored *reading view*. The view
is never meant to compile; it exists so a Java developer can read Python code
at a glance, using Java syntax, before reviewing or steering an AI's changes.

```
my-project/                          my-project/.java-view/
├── main.py                          ├── main.java
└── inventory/                       └── inventory/
    ├── models.py            ==>         ├── models.java
    └── services/                        └── services/
        └── order_service.py                 └── order_service.java
```

## Engine

Phase 1 ships one translation engine: **`rules`** — a deterministic,
offline, line-oriented translator (`src/translator/rules/`). No API key, no
network call, instant output. See [llm-engine.md](llm-engine.md) for the
second engine that existed alongside it and was pulled out of the codebase.

`src/translator/types.ts` defines the shared contract every engine
implements:

```ts
interface TranslateInput {
  source: string;        // full Python source
  relativePath: string;  // e.g. "app/services/order_service.py"
}

interface TranslateResult {
  java: string;         // generated Java-flavored text
  sourceMap: number[];  // generated line (0-based) -> Python line (1-based), 0 = synthetic
  warnings: string[];   // constructs that couldn't be translated faithfully
  engine: 'rules';
}

interface Translator {
  readonly name: 'rules';
  translate(input: TranslateInput): Promise<TranslateResult>;
}
```

`src/translator/index.ts` (`createTranslator`) builds the configured engine.

## What the rules engine does

| Python | Java view |
| --- | --- |
| module `order_service.py` | `public final class OrderService { ... }` |
| `class Foo(Base):` | `public static class Foo extends Base {` |
| `@dataclass` fields, `self.x = ...` in `__init__` | field declarations with inferred types |
| `def f(self, a: int, b="x") -> bool:` | `public boolean f(int a, String b /* = "x" */) {` |
| `__init__`, `__str__`, `__eq__`, `__len__` ... | constructor, `toString()`, `equals()`, `size()` ... |
| `if __name__ == "__main__":` | `public static void main(String[] args) {` |
| `for i in range(n)` / `for k, v in d.items()` | `for (int i = 0; i < n; i++)` / `entrySet()` loop |
| `try/except X as e/finally`, `raise X(...)` | `try/catch (X e)/finally`, `throw new X(...)` |
| `with open(p) as f:` | `try (var f = open(p)) {` |
| `[f(x) for x in xs if c]` | `xs.stream().filter(x -> c).map(x -> f(x)).toList()` |
| `f"Hi {name}, {total:.2f}"` | `"Hi " + name + ", " + String.format("%.2f", total)` |
| `x if c else y`, `and/or/not`, `None/True/False` | `c ? x : y`, `&&/\|\|/!`, `null/true/false` |
| `Optional[T]`, `list[int]`, `dict[str, Any]` | `T /* nullable */`, `List<Integer>`, `Map<String, Object>` |
| `ValueError`, `KeyError`, ... | `IllegalArgumentException`, `NoSuchElementException`, ... |
| docstrings / `# comments` | Javadoc / `// comments` |

Anything without a clean equivalent is kept and annotated with a `/* ... */`
comment rather than dropped, so the view is always complete. The rules engine
is line-oriented: deeply nested comprehensions, exotic decorators,
metaclasses and dynamic attribute tricks are kept verbatim with a comment.
Python truthiness (`if items:`) is annotated, not rewritten. Types are
inferred from hints, defaults and simple literals only; unknown types show
as `Object`/`var`.

## Source mapping and navigation

Each generated file is paired with a sparse source map (`sourceMap` in
`TranslateResult`, persisted alongside the mirror by `src/mirror.ts`) so the
extension can jump between a Python line and its corresponding Java-view
line and back (`Ctrl+Alt+J`, commands `pyrite.openJavaView` /
`pyrite.goToPythonSource`).

## Surface area

- **Commands**: `pyrite.generateView` (whole workspace or a folder),
  `pyrite.translateCurrentFile`, `pyrite.openJavaView`,
  `pyrite.goToPythonSource`, `pyrite.clearView`.
- **Live sync**: saving a `.py` file re-translates just that file when
  `pyrite.watch` is enabled (default on), via a `FileSystemWatcher` in
  `src/extension.ts`.
- **CLI** (`src/cli.ts`, `npx pyrite <project-root>`): the same mirroring
  logic, usable outside VS Code (CI, quick checks).
- **Settings**: `pyrite.outputFolder` (default `.java-view`),
  `pyrite.exclude` (glob patterns to skip), `pyrite.watch`.
- The generated output folder contains its own `.gitignore` so it is never
  committed.
