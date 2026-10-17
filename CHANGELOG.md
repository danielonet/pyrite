# Changelog

All notable changes to Pyrite are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Runtime library.** Python semantics with no one-line Java equivalent go
  through a small Java library whose sources Pyrite writes into the view
  project (`src/main/java/pyrite/runtime/`, imported like any other class):
  `Py` (`truthy`, `slice`, `at`, `len`, `repr`), `Tuple` (an immutable `List`
  that prints and compares like Python, with `zip` and `enumerate`), and the
  commonly used part of `os`, `os.path`, `sys`, `re`, `time` and `warnings`
  as `Os`, `Os.path`, `Sys`, `Re`, `Time`, `Warnings`. `Re` takes Python
  pattern syntax and returns Python's results (`match` anchored at the start,
  `findall` returning groups, `split` keeping groups, `sub` with `\1` or a
  function, `None` as `null`). `@Property` / `@PropertySetter` mark what was
  a Python property and setter (the setter marker was `@Setter`, which read
  as Lombok's).
- **Python modules map to Java.** `os.path.join(a, b)` -> `Os.path.join(a,
  b)`, `sys.argv` -> `Sys.argv`, `re.match(p, s)` -> `Re.match(p, s)`, for the
  members the runtime implements (anything else keeps its Python spelling);
  `from os.path import join` is a static import. `math` maps to
  `java.lang.Math` (`math.floor(x)` -> `(long) Math.floor(x)`, `math.log(x,
  b)` -> `Math.log(x) / Math.log(b)`).
- **Truthiness is rewritten.** In a condition, each operand of `and`, `or` and
  `not` that is a value rather than a boolean goes through `Py.truthy` (`if
  items and not done:` -> `if (Py.truthy(items) && !done)`). Comparisons,
  predicate calls (`contains`, `startsWith`, `is_valid`, `isdir`, ...) and
  names known to be booleans are left alone. `not isinstance(x, T)` is
  `!(x instanceof T)`; it was `!x instanceof T`, which Java reads as
  `(!x) instanceof T`.
- **Locals are declared where Java can see them.** A name first assigned in
  an `if`/`else`/`try`/`with` branch but used after it (or in a sibling
  branch) is declared before the block, typed when every assignment agrees
  and initialized (`String label = null;`); never inside a loop body, where
  Python keeps the value across iterations, nor directly in a `match`.

javac errors on the gated Python 3.12 standard library (`npm run measure`):
34,629 -> 26,384: unknown names 10,549 -> 6,269, runtime library 2,674 -> 0,
truthiness 1,581 -> 191, module references 4,409 -> 2,702.

- **Generators are collected eagerly.** Java has no `yield` that suspends a
  method, and `yield x;` was left as text. A generator function now declares
  `List<T> yielded = new ArrayList<>();`, `yield x` -> `yielded.add(x)`,
  `yield from xs` -> `yielded.addAll(xs)`, and a bare `return` or the end of
  the body returns the list (`yielded.iterator()` when the function is
  declared to return an `Iterator`). Callers iterate it as before. A generator
  that may never end (`while True:` with no `return` or `break`) is flagged
  with a comment and a warning: it needs a lazy `Iterator`. Nested generator functions work the same way inside their
  lambda. Stubs on the Python 3.12 standard library: 217 -> 160.
- **Comprehensions at any depth.** Comprehensions and generator expressions
  are found by scanning instead of regexes that allowed one level of nested
  brackets: `[[c for c in p if c] for p in paths]` nests, and several `for`
  clauses flat-map (`[x * y for x in xs for y in ys]` ->
  `xs.stream().flatMap(x -> ys.stream().map(y -> x * y)).toList()`). A tuple
  target was a two-parameter lambda on a stream (`((k, v)) -> ...`); it is now
  one parameter whose parts are read where the names were used (`item.get(1)`,
  or `item.getKey()` / `item.getValue()` over `.items()`). `dict(pairs)` of a
  generator collects into a map. In loops, `for x in a, b, c:` walks
  `List.of(a, b, c)`, and nested targets unpack under `enumerate(...)` and
  `.items()` (`for i, (op, arg) in enumerate(ops):`). Stubs on the Python 3.12
  standard library: 280 -> 217.
- **Slices.** A slice of a plain name stays `xs.subList(a, b)`, with negative
  bounds counted from the end (`xs[-n:]` -> `xs.subList(xs.size() - n,
  xs.size())`); `xs[:]` is a copy. A slice of a call or subscript
  (`f()[2:]`, `x[0][1:]`) or with a step goes through the runtime helper
  `Py.slice(expr, lo, hi[, step])`, so the expression is evaluated once;
  `f()[-1]` -> `.getLast()`, other negative indexes `Py.at(expr, -n)`. Slice
  assignment replaces the range (`xs[a:b] = ys` -> `xs.subList(a,
  b).clear(); xs.addAll(a, ys);`, copying `ys` first when it reads `xs`), and
  `del xs[a:b]` clears it. Extended-slice assignment (`xs[::2] = ys`) is still
  stubbed. Stubs on the Python 3.12 standard library: 398 -> 280.
- **Calls on values.** Python calls whatever an expression returns
  (`handlers[event](self, frame)`, `factory(name)(data)`); Java only calls
  methods, so the value is cast to the functional interface nested functions
  use and called through it (`((BiFunction<Object, Object, Object>)
  handlers.get(event)).apply(this, frame)`). `type(self)(...)` and
  `self.__class__(...)` construct the enclosing class.
- **Nested unpacking targets.** `name, (a, b) = x` and `for k, (a, b) in
  pairs:` unpack the inner tuple through a named local.
- **Builtin types.** `int(s, 16)` -> `Integer.parseInt(s, 16)` (`int(s, 0)` ->
  `Integer.decode(s)`); a builtin type used as a value is its class
  (`d[int] = f` -> `d.put(Integer.class, f)`); `issubclass(T, int)` ->
  `Integer.class.isAssignableFrom(T)`.
- **Star-unpacking.** `f(*xs)` -> `f(xs.toArray())`; mixed arguments
  `f(a, *xs)` become one array built from a stream, for the varargs
  parameter. `[*a, b]`, `{*a, b}` and `(*a, b)` concatenate streams
  (`.toList()`, `Collectors.toSet()`, `Tuple.of(...)`). Dict merges
  `{**d, "k": v}` were silently turned into a set; they now merge the maps in
  order, later keys winning, into a `LinkedHashMap`. Stubs on the Python 3.12
  standard library: 1,055 -> 823.
- **Nested functions become lambdas.** Java has no methods inside methods, so
  a `def` inside a function is a lambda in a local variable, typed by its
  shape (`Runnable`, `Supplier`, `Consumer`, `Function`, `BiConsumer`,
  `BiFunction`; three or more parameters or `*args`/`**kwargs` take one
  `Object[]`, unpacked at the top with defaults applied). Calls to it become
  `name.apply(...)`, `name.accept(...)`, `name.get()`, `name.run()`.
  Decorators on nested functions are kept as comments, and a class inside a
  function is a local class. Stubs on the Python 3.12 standard library:
  1,393 -> 1,055.
- **Loop-`else` and `try`-`else`.** Java has neither, so a loop with an
  `else:` gets a `broke` flag that its own `break`s set (not those of nested
  loops), and the else part becomes `if (!broke) { ... }`. A `try` with an
  `else:` gets a `raised` flag that every `except` sets, and the else part runs
  after the try as `if (!raised) { ... }`, so the excepts do not catch what it
  raises, as in Python; with a `finally:` as well, a wrapping `try` holds the
  finally. Stubs on the Python 3.12 standard library: 1,611 -> 1,393.
- **Static initializer blocks.** Module- and class-level code that is not a
  declaration (calls, `del`, `obj.attr = ...`, `d[k] = v`, `X += 1`,
  `if`/`for`/`try`/`with`, reassigning a field) runs in a `static { }` block
  instead of sitting in the class body. Consecutive statements share one
  block and a declaration closes it, so the Python order is kept. A name
  first assigned inside the block (`try: import x; HAS_X = True`) is declared
  as a field just before it, and a field the code assigns again is no longer
  `final`. Enums and interfaces are left as they were. Stubs on the Python
  3.12 standard library: 1,984 -> 1,611.
- **Tuples.** Tuple literals become `Tuple.of(...)` (`List.of(...)` after `in`
  and in `for x in (a, b)`); call arguments and `"..." % (a, b)` are left
  alone. Unpacking becomes one statement per name: `a, b = pair` ->
  `var a = pair.get(0); var b = pair.get(1);`, with a temporary for calls
  and swaps, `subList` for `first, *rest`, `_` skipped, and fields at module
  and class level. `for k, v in pairs:` unpacks at the top of the loop body.
  `self.x, self.y = ...` declares both fields. `isinstance(x, (int, str))`
  tests `Integer`/`String`. On the Python 3.12 standard library this halves
  the parse-gate stubs (4,397 -> 1,984).
- **Parse gate.** Every Java view is parsed with tree-sitter-java. Each
  generated statement that is not valid Java becomes a stub that parses,
  `if (true) throw new UnsupportedOperationException("TODO(pyrite): <python>");`,
  with the original text kept as a comment and the line count unchanged (so
  the source map and Go to Definition stay right). An invalid block header
  opens a plain block, so its body is kept; Python's loop-`else` and
  try-`else` keep their bodies the same way. On the Python 3.12 standard
  library, files that parse as Java went from 14 to 157 of 167. New setting
  `pyrite.invalidJava` (`stub` | `keep`) and CLI flag `--invalid-java`.
- **First steps towards compilable Java** (M1 quick wins of
  `architecture/compilable-java-plan.md`):
  - Python names that are Java reserved words are renamed consistently
    (`new` -> `new_`, `default` -> `default_`, `_` -> `unused`); module
    paths in imports keep their names. `for _ in range(n)` gets a free
    counter name (`i`, `j`, ...).
  - Chained comparisons become `&&` chains: `0 <= i < n` ->
    `0 <= i && i < n`.
  - Integer literals are sized: `3000000000L`, `0xFFFFFFFFFFFFFFFFL`,
    `new BigInteger("...")` beyond 64 bits; literal powers are folded
    (`2**10` -> `1024`); `0o17` is written in decimal.
  - A trailing comma in a call is dropped; `(x,)` becomes `Tuple.of(x)`.
  - More exceptions are mapped (`TypeError`, `AttributeError`,
    `LookupError`, `UnicodeDecodeError`, `ImportError`, `OverflowError`,
    ...), and a multi-catch never lists the same Java type twice.
- **Nullable primitives are boxed.** A Java primitive cannot hold `null`, so a
  value the Python code may set to `None` is declared with its wrapper type
  (`int` -> `Integer`, `float` -> `Double`, `bool` -> `Boolean`):
  `Optional[int]` / `int | None` hints, `x: int = None`, parameters defaulting
  to `None` or checked with `is None`, locals assigned `None` anywhere in the
  function (`n = 0 ... n = None` -> `Integer n = 0`; `x = None ... x = 0` ->
  `Integer x = null`), return types of functions that `return None`, and
  `self.x` fields set to or compared with `None`.
- **`hybrid` engine (Phase 2): rules + a local Ollama model.** The rules engine
  still translates every file; only functions it handles badly (a warning, an
  untranslated statement, nested comprehensions, walrus) are rewritten by the model. Fails soft: an
  unreachable or slow Ollama, or an unusable answer, keeps the rules output and
  adds a warning. Answers are cached in `.java-view/.pyrite/ollama-cache.json`.
  New settings `pyrite.ollama.url`, `.model`, `.timeoutSeconds`,
  `.maxFunctionsPerFile`; CLI `--engine hybrid --ollama-url --ollama-model`.
- **Real Java imports in `hybrid` mode.** The Python-shaped import block
  (`import logging;`, `import typing.Dict;`, `java.util.*`) is replaced by
  explicit imports of real classes: JDK classes looked up in an index generated
  from a real JDK, the classes Pyrite generates for the project's own modules
  (static imports for functions and constants), Lombok for its annotations,
  and, for the names left over, the local model, whose suggestions are checked
  against the JDK. Python imports with no Java counterpart stay as
  `// python: ...` comments. Setting `pyrite.resolveImports` (default on);
  CLI `--no-java-imports`.

### Changed

- **The rules engine writes real Java imports too.** Python's imports used to
  stay as Java-looking lines (`import os;`, `import typing.List;`): readable,
  but not Java (`import os;` alone was 855 javac syntax errors on the
  standard library). Both engines now import the JDK and project classes the
  view uses and keep Python imports as `// python: ...` comments; only the
  hybrid engine asks the model about names the index cannot resolve. An
  import inside a one-line body (`if not re: import re`) joins the import
  block. `pyrite.resolveImports: false` (CLI `--no-java-imports`) keeps the
  Python-shaped lines.
- **`scripts/measure-java.js`** (`npm run measure -- <folder> [--javac]`)
  reports how far the views of a folder of Python files are from compiling:
  files that need no parse-gate stub, the stubs, and with `--javac` the
  compiler's errors grouped by cause.

- **The view is a standard Java project.** Views are written to
  `.java-view/src/main/java`, and test modules (`test_*.py`, `*_test.py`,
  `conftest.py`, anything under `test`/`tests`) to `.java-view/src/test/java`.
  Every package starts with the project's name, then the Python folder path:
  `my-project/inventory/models.py` is `package my_project.inventory;` in
  `src/main/java/my_project/inventory/Models.java`. Imports of the project's
  own modules carry the same prefix. New setting `pyrite.basePackage` (CLI
  `--package`) replaces the folder name, e.g. `com.acme.shop`. Folder names
  that are Java keywords get a `_` suffix (`static` -> `static_`). Views left
  in the old flat layout are removed on the next regeneration.
- **View files are named after their Java class**, as `javac` requires:
  `order_service.py` -> `OrderService.java`, `main.py` -> `Main.java`. A
  package module's class takes the `Init` suffix its file already had,
  `inventory/__init__.py` -> `class InventoryInit` in `InventoryInit.java`.
  Views written under the old names are removed on the next regeneration.
- **A class named like its module is the module's class.** `class
  OrderService` in `order_service.py` used to become
  `OrderService.OrderService`, which Java rejects; it is now
  `public class OrderService` itself, with the module's constants and
  functions as its static members (an enum's constants stay first).
- Enum constants followed by methods or fields end with `;`, as Java requires.
- **New logo.** The two Python snakes around a steaming cup of Java, in
  `media/icon.png`, the Activity Bar outline and the status bar glyph.
- **The status bar report is laid out like the Copilot status panel**: a
  title row with a Regenerate button, a delete icon and a settings gear, the
  file count with when the view was last updated, a large "clean" percentage
  with a meter, then right-aligned rows for classes, methods, fields,
  problems (each opens the warnings list) and the engine and
  translate-on-save settings.

### Fixed

- `d[K[0]] = v` split the target at the wrong bracket (`d[K.put(0], v)`), and
  a subscript on an UPPER_CASE name was read as a generic type (`K<0>`).
- `%`, `**`, `//` and `in` took at most one level of parentheses as an
  operand: `"%s" % f(g(x))` became `String.format("%s", f)(g(x))`. Operands
  are now found by scanning, and `fmt % (a, b)` with a non-literal format is
  formatting too. `x in [a, b]` read `in[...]` as a subscript.
- Errors javac reports that the parse gate's parser accepts (found by compiling
  the gated standard library): Python string escapes are translated (`\x00`
  -> `\000`, `\a`, `\v`, `\U0001F600` -> a surrogate pair; an unknown escape
  such as `\d` keeps its backslash, and `\s` no longer turns into a space);
  `\"` inside a single-quoted string ended the Java string; an attribute named
  `int` or `float` is renamed (`value.int` -> `value.int_`); `*args` before
  `**kwargs` or keyword-only parameters is an array, since Java varargs must
  come last; a decorator call whose arguments are not annotation constants
  (`@wraps(f)`) stays a comment instead of an invalid annotation;
  `issubclass(x, type)` -> `Class.class.isAssignableFrom(x)`.
- A variable named like `yielded` was read as a `yield` statement.
- A function containing a nested generator was itself typed as a generator.
- `Generator[int, None, None]` became `Iterator<Integer, Void, Void>`; it is
  `Iterator<Integer>`. `Callable[[A, B, C], R]` became `Function<(A, B, C),
  R>`; it is `Function<Object[], R>`, as nested functions with three or more
  parameters are.
- A backslash continuation on a line with `#` inside a string (`x == '#' and
  \`) was not joined: the comment was cut without regard to strings.
- `len("abc")` -> `"abc".length()`, not `.size()`.
- `{"a": 1}[k]` is an element of the map, not a map; `super(X, self).m()` ->
  `super.m()`.

Together with the additions above: stubs on the Python 3.12 standard library
823 -> 160, files with no stub 54 -> 103.

## [0.2.1] - 2026-09-17

### Added

- **Line wrapping to 120 columns.** Generated Java now fits a wide screen,
  following the IntelliJ IDEA and palantir-java-format defaults: 4-space
  indentation, 8-space continuation indentation, and "chop down if long".
  A method signature or call that does not fit puts one parameter per line.
  Conditions break before `&&` and `||`, arithmetic and string concatenation
  before the operator, and call chains before each `.call()`. A single call
  argument stays on the first line with only its own arguments chopped, and
  `Map.of` keeps each key with its value. Long Javadoc and comment prose is
  re-flowed. Long string literals, text blocks and URLs are never split.
- **`pyrite.lineWidth` setting** and `--line-width` CLI option to choose the
  width. `0` turns wrapping off.

### Changed

- **The status bar shows the Pyrite logo alone**, without the word "Pyrite".
  The logo ships as a small icon font (`media/pyrite-icons.woff`, built from
  `media/icon.svg` with `npm run build:icon-font`) and is contributed as
  `pyrite-logo`, since VS Code can only draw font glyphs there. The outline
  fills 85% of the em box so it sits beside the built-in icons rather than
  towering over them; change `GLYPH_SCALE` in the build script to adjust.
- **Hovering the status bar shows a report** on the generated view: how many
  files were translated, how many classes, methods and fields they hold, how
  many files failed or have Python syntax errors, the warning count, and when
  the view was last updated. The counts come from the sidecar maps, which now
  record how each file's translation went. Below the report sit action buttons
  for regenerating and for deleting the view. Clicking the icon opens that report
  instead of starting a translation, so nothing happens by accident.

### Fixed

- Python's implicit joining of adjacent string literals (`"a " "b"`) was
  copied as is, which is not valid Java. It now becomes `"a " + "b"`.

## [0.2.0] - 2026-09-17

This release adds features and changes what the Java view looks like, hence
the minor version bump.

### Added

- **Python builtins translate to Java equivalents.** `sum`, `sorted` (with
  `key` and `reverse`), `any`, `all`, `next`, `iter`, `round(x, n)`, `map`,
  `filter`, `zip`, `enumerate`, `range`, `min`, `max`, `reversed`, `pow`,
  `divmod`, `chr`, `ord`, `repr`, `getattr`, `hasattr` and `open` (with its
  mode) now become Java streams, `Comparator`, `Math`, `Collections` and
  `java.io` calls. Nested calls and keyword arguments are handled.
- **Type inference from type hints.** Local variables, fields and loop
  variables get a real type instead of `var` or `Object` when it can be worked
  out. The type can come from a function or method return hint, from a base
  class in the same file, from another file in the project, from the element
  type of a `List[T]`, or from the key and value types of a `Dict[K, V]`.
- **Project-wide knowledge.** Generating the Java view first scans every file,
  so properties and return types declared in one module are used when
  translating another. The result is saved as `.pyrite/maps/members.json` in
  the output folder, so a single file translated on save uses it too.
- **Syntax error warnings.** A Python file with a syntax error is still
  translated, but its Java view starts with a warning block naming the line
  and column of each error, and the problem is listed with the other warnings.
  Syntax is checked with a real Python parser (tree-sitter, running offline as
  WebAssembly).
- **Python 3.12 generic syntax.** `class Box[T]:` and `def first[T](...)`
  become Java type parameters, including bounds such as `V: Comparable`.

### Changed

- **Properties read like accessor calls.** A read of a `@property` such as
  `order.total` becomes `order.total()`, and a write through a setter becomes
  `order.note("paid")`. With Lombok style on, a simple getter and setter pair
  becomes `@Getter` and `@Setter` on a field named after the property, and
  reads become `order.getTotal()`. A boolean property uses `is`, as in
  `flag.isActive()`. Names that are also ordinary attributes somewhere in the
  project are left alone.
- **`a or b` as a fallback.** When assigned or returned, `value = a or b`
  becomes `Objects.requireNonNullElse(a, b)`. In an `if` or `while` condition
  it stays `a || b`.
- **Looping over a dictionary** walks its keys: `for k in prices` becomes
  `for (String k : prices.keySet())`.
- **Conditions on known booleans** no longer get the
  `/* truthy: non-null and non-empty */` comment.
- **The `@Property` comment** now names the property it describes instead of
  the placeholder `obj.name`.
- The extension now depends on `web-tree-sitter` and `tree-sitter-python`.
  Only their JavaScript loader and two `.wasm` files are packaged.

### Fixed

- One-line compound statements such as `if x: y = 1`, `except: pass`,
  `for x in xs: total += x` and `def one(): return 1` produced unbalanced
  braces. Each now opens and closes its own block and chains correctly with a
  following `elif`, `else` or `except`.
- A comment inside a multi-line list or dict literal cut the statement short
  and broke the rest of the file. Such comments now appear above the
  statement.
- A multi-line triple-quoted f-string produced a Java string with raw line
  breaks. It now becomes Java text blocks.
- After any multi-line text block, the line mapping between Python and Java
  drifted. Jumping between the two files and Go to Definition landed on the
  wrong line.
- A module with a very large dictionary literal took several seconds to
  translate. Python's own `locale.py` took about 7 seconds and now takes a
  fraction of a second.

### Development

- A snapshot test checks that the sample project translates exactly as
  recorded. Refresh the snapshot with `UPDATE_SNAPSHOTS=1 npm test` after an
  intended change.
- A corpus test translates the local Python standard library. It fails if
  the translator throws, emits unbalanced braces, takes more than three
  seconds on a file, or drops a class or function that the real parser finds.
  `npm test` checks the first 300 files. Set `PYRITE_CORPUS_ALL=1` for all of
  them, or `PYRITE_CORPUS` to test other folders.
- GitHub Actions runs the tests on every push and pull request, and the full
  standard-library corpus on pushes to `main`.
- `architecture/tree-sitter.md` describes the parser integration.
  `architecture/frontend-migration.md` is the plan for translating from the
  syntax tree instead of regular expressions.

## [0.1.3] - 2026-09-16

First tagged release. Earlier versions were not tagged, so their changes are
not listed here.

[Unreleased]: https://github.com/danielonet/pyrite/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/danielonet/pyrite/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/danielonet/pyrite/compare/v0.1.3...v0.2.0
[0.1.3]: https://github.com/danielonet/pyrite/releases/tag/v0.1.3
