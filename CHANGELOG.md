# Changelog

All notable changes to Pyrite are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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
