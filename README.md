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

## Features

- **Generate Java view for the workspace** – one command translates the whole tree.
- **Live sync** – saving a Python file re-translates just that file (`pyrite.watch`).
- **Status bar report** – the Pyrite logo sits in the status bar; hovering it
  (or clicking it) shows how many classes, methods, files and fields the Java
  view holds, a health bar, and the engine in use. Failures, Python syntax
  errors and warnings are links: clicking one lists every message in the Output
  panel. Buttons regenerate or delete the view, or open the Pyrite settings.
- **Two-way navigation** – `Ctrl+Alt+J` jumps from a Python line to the matching
  Java line and back, using a per-file line map.
- **Go to Definition** – F12 / Ctrl+Click / right-click on a class, method or
  field name inside the Java view jumps to where it's declared, even in
  another mirrored file.
- **Two work modes** – `rules` (default: deterministic, offline, instant) and
  `hybrid` (the rules plus a small LLM running on your own machine for the few
  functions the rules cannot translate). Switch with the `pyrite.engine` setting.
  See [Work modes](#work-modes-rules-and-hybrid).
- **CLI** for CI or quick checks: `npx pyrite <project-root>`.

See [architecture/](architecture/) for design notes, including the
[hybrid engine](architecture/phase-2.md) and the earlier
[cloud LLM engine](architecture/llm-engine.md) that the local one replaced.

## The rules engine

The rules engine is Pyrite's core and the default mode. It is a deterministic,
line-oriented translator built on a real Python parser
([tree-sitter](architecture/tree-sitter.md)): the same Python always gives the same
Java view, it runs offline with no API key, and it translates a whole project in
seconds. It works on the structure it recognises (classes, functions, control flow,
common builtins, type hints), which covers the large majority of ordinary Python.

What it maps:

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

## The small LLM

Some Python does not translate well line by line, for example a comprehension with two
`for` clauses, or an assignment expression (`if (n := len(xs)) > 3`). For those, Pyrite
can ask a **small language model running locally** to rewrite just that one function.
The model gets the Python function (with line numbers) and the rules engine's draft,
and returns a Java-flavored version that keeps every statement, name and comment.
It runs through [Ollama](https://ollama.com), so nothing leaves your machine and no
API key is involved.

**Pyrite does not include an LLM server.** For now you install and run one yourself
(Ollama is the supported one) and point Pyrite at it; see
[Running a local LLM with Ollama](#running-a-local-llm-with-ollama). If none is
running, `hybrid` mode simply behaves like `rules` and tells you why.

## Work modes: rules and hybrid

Set the mode with `pyrite.engine`:

| Mode | What runs | Needs |
| --- | --- | --- |
| `rules` (default) | Rules engine only | nothing |
| `hybrid` | Rules engine for everything, plus the local LLM for the functions the rules cannot handle | a running Ollama and a downloaded model |

How `hybrid` works, per file:

1. The rules engine translates the whole file first, exactly as in `rules` mode.
2. Pyrite splits the file into functions and methods and looks for ones the rules
   failed on: a warning was raised inside it, a statement stayed `untranslated`, or it
   uses a construct the rules are known to get wrong (nested comprehension, `:=`).
3. **Only those functions** are sent to the model, one request per function, each with
   its Python source and the rules' draft. Files and functions the rules handled never
   touch the model, so most files make no request at all (`pyrite.ollama.maxFunctionsPerFile`
   caps the rest).
4. The answer replaces just that function in the Java view. The line map and Go to
   Definition are kept, and a `// Rewritten by <model> (<reason>); check against the
   Python.` line marks it, so you always know which parts came from the model.
5. If the model is unreachable, too slow, or returns something unusable, the rules
   output for that function stays and a warning is recorded (click the warning count in
   the status bar report to see it). Answers are cached in
   `.java-view/.pyrite/ollama-cache.json`, so only functions that changed are sent again.

Model output is not deterministic or guaranteed correct: treat a rewritten function as
a reading aid and check it against the Python, which is why it is marked.

## Running a local LLM with Ollama

The default `rules` engine needs nothing. The optional `hybrid` engine adds a small
model running on your own machine, used only for the functions the rules cannot
translate (nested comprehensions, assignment expressions `:=`, and anything the rules
flag with a warning or an `untranslated` marker). Generators, `async`/`await`, lambdas
and the rest stay rule-based. If Ollama is off or fails, Pyrite keeps the rules output
for that function and adds a warning, so it never blocks you.

**1. Install Ollama** ([ollama.com/download](https://ollama.com/download))

```bash
# Linux
curl -fsSL https://ollama.com/install.sh | sh
# macOS
brew install ollama          # or download the app
# Windows: download the installer from ollama.com/download
```

On Linux the installer sets up a background service on `http://localhost:11434`. On macOS
and Windows the app starts the server; otherwise run `ollama serve`.

**2. Download a model.** Pick a small code model; a bigger one is slower:

```bash
ollama pull qwen2.5-coder:7b     # Pyrite's default; good at code, ~4.7 GB
ollama pull qwen2.5-coder:3b     # smaller and faster, for weaker machines
ollama list                      # shows the exact names you can use
```

**3. Check it works**

```bash
curl http://localhost:11434/api/tags       # should list your models
ollama run qwen2.5-coder:7b "say hi"
```

**4. Turn it on in VS Code** (`settings.json`):

```json
"pyrite.engine": "hybrid",
"pyrite.ollama.model": "qwen2.5-coder:7b"
```

`pyrite.ollama.model` must match a name from `ollama list` exactly, tag included. Then run
*Pyrite: Generate Java View for Workspace*. A function rewritten by the model has a
`// Rewritten by <model> (<reason>); check against the Python.` line above it, and the
answers are cached in `.java-view/.pyrite/ollama-cache.json`, so only changed functions
are sent again. From the command line:

```bash
node out/cli.js my-project --engine hybrid --ollama-model qwen2.5-coder:7b
```

**Troubleshooting**

| Symptom | Cause and fix |
| --- | --- |
| `404` on `/api/chat`, or a warning that the model "is not installed" | The model in `pyrite.ollama.model` is not pulled. Run `ollama pull <name>` or set the setting to a name from `ollama list`. |
| Warning "Could not reach Ollama" | The server is not running, or `pyrite.ollama.url` is wrong. Start it with `ollama serve`. |
| Warning "did not answer within ...s" | Too slow. On a CPU-only machine the first request also loads the model and can take minutes. Use a smaller model, raise `pyrite.ollama.timeoutSeconds`, or lower `pyrite.ollama.maxFunctionsPerFile`. |
| Where are Ollama's logs? | Linux service: `journalctl -u ollama -f`. Also `ollama ps` shows what is loaded and whether it runs on CPU or GPU. |

Every warning is listed in the Output panel: click the warning count in the status bar report.

## Testing

`npm test` runs the unit tests, a snapshot of the sample project
(`src/test/snapshots/`, refresh with `UPDATE_SNAPSHOTS=1 npm test` after an intended
change) and a corpus run over the first 300 files of the local Python standard
library: the engine must not throw, must emit balanced braces, must stay fast, and
every class and function the real parser sees must come out as a symbol. Point it
elsewhere with `PYRITE_CORPUS=dir1:dir2`, widen it with `PYRITE_CORPUS_ALL=1`. CI runs
the full standard library on every push to `main`.

## Getting started (development)

On a fresh Debian/Ubuntu machine, `scripts/setup-env.sh` installs Node.js and npm through
apt (adding the NodeSource repository when apt's Node is older than 20) and runs
`npm install`. `scripts/build-and-install.sh` builds a `.vsix`, installs Node 20 through
nvm if it is missing, and installs the extension into your local VS Code.

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
| `pyrite.engine` | `rules` | work mode: `rules`, or `hybrid` (rules + a local LLM for hard functions, see [Work modes](#work-modes-rules-and-hybrid)) |
| `pyrite.ollama.url` | `http://localhost:11434` | Ollama server used by the `hybrid` engine |
| `pyrite.ollama.model` | `qwen2.5-coder:7b` | model name, exactly as `ollama list` shows it |
| `pyrite.ollama.timeoutSeconds` | `300` | give up on one request after this long and keep the rules output |
| `pyrite.ollama.maxFunctionsPerFile` | `10` | at most this many functions per file go to the model |
| `pyrite.outputFolder` | `.java-view` | where the mirror is written (relative to the workspace root) |
| `pyrite.exclude` | venv, node_modules, ... | glob patterns to skip |
| `pyrite.watch` | `true` | re-translate on save |
| `pyrite.javadoc` | `docstringOnly` | Javadoc generation: `always` (every class/method, extrapolated when there's no docstring), `docstringOnly` (only where a docstring exists), or `none` (no Javadoc; docstrings kept as plain comments) |
| `pyrite.javadocTestCode` | `false` | Document test code too, using the same `pyrite.javadoc` rules as production code. When unchecked, test files (`test_*.py`, `*_test.py`, `conftest.py`, or anything under a `test`/`tests` folder) never get Javadoc |
| `pyrite.lombok` | `true` | Use Lombok-style annotations instead of spelling out boilerplate: a plain `self.x = x` `__init__` becomes `@AllArgsConstructor`, a trivial `__str__`/`__repr__` becomes `@ToString`, a trivial `__eq__`/`__hash__` becomes `@EqualsAndHashCode`, a `@property`/`@x.setter` pair that just wraps a field becomes `@Getter`/`@Setter` on that field, and a dataclass-like class becomes `@Data`. Methods that don't match these simple shapes are left spelled out |
| `pyrite.lineWidth` | `120` | Maximum line length of the generated Java. Longer lines wrap like IntelliJ IDEA and palantir-java-format by default: a signature or call that does not fit gets one parameter per line with an 8-space continuation indent, conditions break before `&&`/`\|\|`, concatenation before `+`, call chains before each `.call()`. Long string literals are never split. `0` turns wrapping off |

The generated folder contains its own `.gitignore` so it is never committed.

## Roadmap

- **Edit the Java view and sync back to Python** is not implemented yet. The intended
  design (function-level, approval-gated, LLM-translated with the original Python as
  context) and its open questions are in [architecture/phase-2.md](architecture/phase-2.md).
- A built-in LLM server is not planned for now: the model runs in your own Ollama.

## Limitations

- The rules engine is line-oriented. Deeply nested comprehensions, exotic
  decorators, metaclasses and dynamic attribute tricks are kept verbatim with a comment
  (nested comprehensions and `:=` can be rewritten by the `hybrid` engine's local model).
- Python truthiness (`if items:`) is annotated, not rewritten.
- Types are inferred from hints, defaults and simple literals only; unknown types show as `Object`/`var`.
