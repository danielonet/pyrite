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
- **Two-way navigation** – `Ctrl+Alt+J` jumps from a Python line to the matching
  Java line and back, using a per-file line map.
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
| `f"Hi {name}, {total:.2f}"` | `"Hi " + name + ", " + String.format("%.2f", total)` |
| `x if c else y`, `and/or/not`, `None/True/False` | `c ? x : y`, `&&/\|\|/!`, `null/true/false` |
| `Optional[T]`, `list[int]`, `dict[str, Any]` | `T /* nullable */`, `List<Integer>`, `Map<String, Object>` |
| `ValueError`, `KeyError`, ... | `IllegalArgumentException`, `NoSuchElementException`, ... |
| docstrings / `# comments` | Javadoc / `// comments` |

Anything without a clean equivalent is kept and annotated with a `/* ... */`
comment rather than dropped, so the view is always complete.

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

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `pyrite.engine` | `rules` | translation engine (`rules` is the only one today) |
| `pyrite.outputFolder` | `.java-view` | where the mirror is written (relative to the workspace root) |
| `pyrite.exclude` | venv, node_modules, ... | glob patterns to skip |
| `pyrite.watch` | `true` | re-translate on save |

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
