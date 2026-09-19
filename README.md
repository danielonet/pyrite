# Pyrite

**Read Python as if it were Java.**

Developers today, Java developers included, increasingly write code with AI. A Java
developer dropped into a Python codebase no longer has to close the language gap
before contributing, because the AI can write the Python. The real risk is the
opposite: shipping code you cannot read. That is vibe coding, and it leaves the
developer unable to review, reason about, or take responsibility for what the
application does.

Pyrite closes that gap on the reading side, so a Java developer on a Python project
can practise **Supervised Development instead of vibe coding**: read the AI's output
at a developer level, understand the design, review changes, and steer the
application deliberately.

The name is the disclaimer. Pyrite is fool's gold: it looks like Java but is not, and
it is never meant to compile. It is a faithful *reading view* of the Python underneath.

Pyrite mirrors every `.py` file in your workspace into a `.java-view/`
folder with the **same directory structure**, translating each module into a
Java-flavored *reading view*. The view keeps Python's names, order, comments
and docstrings, but uses Java syntax: braces, semicolons, explicit types,
`for (var x : xs)`, `throw new ...`, streams instead of comprehensions, and
so on. It is meant to be **read**, not compiled.

```
my-project/                          my-project/.java-view/
├── main.py                          ├── main.java
└── inventory/                       └── inventory/
    ├── models.py            ==>         ├── models.java
    └── services/                        └── services/
        └── order_service.py                 └── order_service.java
```

## Features (Phase 1: read-only mirror)

- **Generate Java view for the workspace** – one command translates the whole tree.
- **Live sync** – saving a Python file re-translates just that file (`pyrite.watch`).
- **Status bar report** – the Pyrite logo sits in the status bar; hovering it
  shows how many files, classes, methods and fields the Java view holds, plus
  any failures, Python syntax errors and warnings, with buttons to regenerate
  or delete the view. Clicking the icon opens the same report.
- **Two-way navigation** – `Ctrl+Alt+J` jumps from a Python line to the matching
  Java line and back, using a per-file line map.
- **Go to Definition** – F12 / Ctrl+Click / right-click on a class, method or
  field name inside the Java view jumps to where it's declared, even in
  another mirrored file.
- **`rules` engine**: deterministic, offline, instant. No API key, no network call.
- **CLI** for CI or quick checks: `npx pyrite <project-root>`.

See [architecture/](architecture/) for design notes, including
[architecture/llm-engine.md](architecture/llm-engine.md): a second, LLM-backed
engine used to live here and was pulled out to keep Pyrite offline and
deterministic; its design is preserved there rather than deleted.

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
| `sum`, `sorted(key=..)`, `any`/`all`, `next`, `round(x, 2)`, `map`/`filter`, `isinstance(x, (A, B))`, `open(p, "w")`, ... | `.mapToDouble(..).sum()`, `.sorted(Comparator.comparing(..))`, `.anyMatch(..)`, `it.next()`, `Math.round(x * 100.0) / 100.0`, `.map(..)`/`.filter(..)`, `x instanceof A \|\| ..`, `new PrintWriter(p)`, ... |
| `value = a or default` | `Objects.requireNonNullElse(a, default)` (in a condition `a or b` stays `a \|\| b`) |
| `@property def total(self)` and `order.total` | `total()` and `order.total()`; a trivial getter/setter pair in Lombok style becomes `@Getter`/`@Setter` on a field named after the property, read as `order.getTotal()` |
| `x = repo.order(1)` where `order` has a `-> Order` hint, `for line in self.lines` with `lines: List[OrderLine]` | `Order x = ...`, `for (OrderLine line : this.lines)` - types follow hints on functions, methods (also from other files and base classes), fields and parameters |
| `f"Hi {name}, {total:.2f}"` | `"Hi " + name + ", " + String.format("%.2f", total)` |
| `x if c else y`, `and/or/not`, `None/True/False` | `c ? x : y`, `&&/\|\|/!`, `null/true/false` |
| `Optional[T]`, `list[int]`, `dict[str, Any]` | `T /* nullable */`, `List<Integer>`, `Map<String, Object>` |
| `ValueError`, `KeyError`, ... | `IllegalArgumentException`, `NoSuchElementException`, ... |
| docstrings / `# comments` | Javadoc / `// comments` |
| `inventory/__init__.py` with only a docstring / `__all__` | nothing: Java packages are plain folders |
| `inventory/__init__.py` with real content (constants, re-exports) | `public final class Inventory`, Javadoc names the original `__init__.py`; written to `inventory/inventoryInit.java`, the `Init` suffix hinting at `__init__.py` and keeping the file distinct from a sibling `inventory.py` on case-insensitive filesystems |

Anything without a clean equivalent is kept and annotated with a `/* ... */`
comment rather than dropped, so the view is always complete.

A file with a Python syntax error is still translated, but its view starts with a
`// WARNING` block naming the error, and a file the engine cannot handle at all gets a
`TRANSLATION FAILED` placeholder rather than an outdated view. Syntax is checked with a
real Python parser ([tree-sitter](architecture/tree-sitter.md), WebAssembly, offline).

## Testing

`npm test` runs the unit tests, a snapshot of the sample project
(`src/test/snapshots/`, refresh with `UPDATE_SNAPSHOTS=1 npm test` after an intended
change) and a corpus run over the first 300 files of the local Python standard
library: the engine must not throw, must emit balanced braces, must stay fast, and
every class and function the real parser sees must come out as a symbol. Point it
elsewhere with `PYRITE_CORPUS=dir1:dir2`, widen it with `PYRITE_CORPUS_ALL=1`. CI runs
the full standard library on every push to `main`.

## Getting started (development)

```bash
git clone https://github.com/danielonet/pyrite.git && cd pyrite
npm install
npm run compile
npm test                       # unit tests (node --test)
npm run cli -- sample-python-project   # writes sample-python-project/.java-view/
```

Open this folder in VS Code and press **F5** to launch an Extension Development
Host; open `sample-python-project` there and run *Pyrite: Generate Java View for Workspace*.

To build an installable package: `npx @vscode/vsce package` (produces a `.vsix`).

To publish a release to the Visual Studio Marketplace: `npm run publish:marketplace`
(runs [scripts/publish-marketplace.sh](scripts/publish-marketplace.sh) - builds, tests,
packages and publishes). It reads the publisher id and Marketplace personal access token
from a plain text file *outside* this repo (`~/.config/pyrite/marketplace.env` by default,
never committed); the script prints a template and instructions the first time it's run.
Use `--dry-run` to build and package without publishing.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `pyrite.engine` | `rules` | `rules`, or `hybrid` (rules + a local Ollama model for hard functions, see [architecture/phase-2.md](architecture/phase-2.md)) |
| `pyrite.ollama.url` / `.model` / `.timeoutSeconds` / `.maxFunctionsPerFile` | `http://localhost:11434` / `qwen2.5-coder:7b` / `300` / `10` | settings for the `hybrid` engine |
| `pyrite.outputFolder` | `.java-view` | where the mirror is written (relative to the workspace root) |
| `pyrite.exclude` | venv, node_modules, ... | glob patterns to skip |
| `pyrite.watch` | `true` | re-translate on save |
| `pyrite.javadoc` | `docstringOnly` | Javadoc generation: `always` (every class/method, extrapolated when there's no docstring), `docstringOnly` (only where a docstring exists), or `none` (no Javadoc; docstrings kept as plain comments) |
| `pyrite.javadocTestCode` | `false` | Document test code too, using the same `pyrite.javadoc` rules as production code. When unchecked, test files (`test_*.py`, `*_test.py`, `conftest.py`, or anything under a `test`/`tests` folder) never get Javadoc |
| `pyrite.lombok` | `true` | Use Lombok-style annotations instead of spelling out boilerplate: a plain `self.x = x` `__init__` becomes `@AllArgsConstructor`, a trivial `__str__`/`__repr__` becomes `@ToString`, a trivial `__eq__`/`__hash__` becomes `@EqualsAndHashCode`, a `@property`/`@x.setter` pair that just wraps a field becomes `@Getter`/`@Setter` on that field, and a dataclass-like class becomes `@Data`. Methods that don't match these simple shapes are left spelled out |
| `pyrite.lineWidth` | `120` | Maximum line length of the generated Java. Longer lines wrap like IntelliJ IDEA and palantir-java-format by default: a signature or call that does not fit gets one parameter per line with an 8-space continuation indent, conditions break before `&&`/`\|\|`, concatenation before `+`, call chains before each `.call()`. Long string literals are never split. `0` turns wrapping off |

The generated folder contains its own `.gitignore` so it is never committed.

## Roadmap (Phase 2: edit the Java view, sync back)

Not implemented yet. See [architecture/phase-2.md](architecture/phase-2.md)
for the intended design (function-level, approval-gated, LLM-translated with
the original Python as context) and open questions.

## Limitations

- The rules engine is line-oriented. Deeply nested comprehensions, exotic
  decorators, metaclasses and dynamic attribute tricks are kept verbatim with a comment.
- Python truthiness (`if items:`) is annotated, not rewritten.
- Types are inferred from hints, defaults and simple literals only; unknown types show as `Object`/`var`.
