# Plan: from readable Java view to compilable Java

Source of evidence: translating **trafilatura 2.3.1** (≈9k lines library, ≈13k lines pytest)
with Pyrite 0.4.0 (rules engine, with qwen2.5-coder:7b assist on some files), then porting
the output by hand until it compiled and the ported tests passed. Every item below was
observed in that output; file names refer to the generated Java files.

Starting point:

- 0 of 22 library files compiled. 5 did not even parse (Sitemaps: 64 syntax errors,
  Spider, Deduplication, docs/Conf, docs/DocsTests); once those were excluded, javac
  reported another 557 syntax errors in the rest.
- Several outputs compiled-looking but were **silently wrong** (dropped list items,
  keyword arguments bound to the wrong parameters). These are worse than syntax errors,
  because nobody notices them.
- None of the 21 test files used JUnit. `assert` statements plus `==` on strings mean
  they would "pass" even if run.

The plan is ordered by impact. Every rule lists the trafilatura example, the target
output, and where it probably belongs in Pyrite.

---

## 0. Architectural prerequisites

These make most of the later rules simple. Without them, every rule fights regex
edge cases.

### 0.1 Finish the AST front end (see `frontend-migration.md`)

Nearly all *unparseable* output came from expressions being rewritten textually:

- generator and list comprehensions, especially nested or with `if` filters
- walrus inside comprehensions or conditions
- tuple unpacking, star-unpacking, multi-target assignment
- nested `def`, conditional expressions nested in other expressions

Examples of garbled output:

```java
for (var match : (m.get(index) for islice.contains(m)(regex.finditer(this.content), MAX_LINKS)))   // Sitemaps
child.iterancestors("table")!nested_elems.contains(.next())                                         // MainExtractor
!element.getOrDefault("rel", "").contains("license").toLowerCase().split()                         // Metadata
```

Rule of thumb: **translate expressions from the syntax tree, bottom-up, never by
substring.** `tree-sitter` is already the oracle; make it the source.

### 0.2 Add a type-inference pass (local, best-effort)

Most remaining defects are type-dependent:

- `len(x)` becomes `.length()` (String), `.size()` (List) or `.length` (array)
- `x[i]` becomes `charAt`, `get`, a record accessor, or `[i]`
- `x[a:b]` becomes `substring`, `subList` or `Arrays.copyOfRange`
- `a == b` becomes `equals` or `==`
- `if x:` becomes `x != null && !x.isEmpty()`, `x != 0`, `!x.isEmpty()` and so on

Sources of types, in order of reliability:

1. type hints (`str | None`, `list[str]`, `tuple[bool, Document]`)
2. literals and constructor calls
3. return types of project functions (from the definition index)
4. a small table for stdlib and common third-party calls

Carry the type with every translated expression (`(code, type)` pairs). When the type
is unknown, emit a **compile-safe** fallback through a runtime helper (see 0.3) instead
of guessing a method.

### 0.3 Ship a small runtime library (`pyrite-runtime`) and target it

Many Python semantics have no one-line Java equivalent. Generating inline code for them
is long and error-prone; calling a helper is short and correct. The port needed these
helpers (all written as `trafilatura.compat.*`, which you can use as the seed):

| Helper | Replaces | Why a helper |
|---|---|---|
| `Py.truthy(Object)` | `if x:` / `not x` on unknown types | None, "", 0, empty containers |
| `Py.or(a, b)` | `a or b` on strings | returns the first truthy value, not a boolean |
| `Py.strip/lstrip/rstrip(s[, chars])` | `str.strip()` | Python whitespace includes U+00A0; char-set argument |
| `Py.split(s)` | `s.split()` without argument | whitespace runs, no empty strings |
| `Py.splitlines`, `Py.partition`, `Py.count`, `Py.title` | same-named str methods | no direct equivalent |
| `Py.isdigit/isspace/isprintable` | str predicates | **empty string is False** |
| `Py.slice(s, start, end)` | `s[a:b]`, negative indexes | clamping and negative indexes |
| `Py.str(x)` / `Py.repr(x)` | `str(None)` → `"None"`, `repr(list)` | Java prints `null` / `[a, b]` |
| `Py.unescape` | `html.unescape` | |
| `Re.match/search/fullmatch/split/findall/sub/finditer/escape` | `re` module | `match` is anchored at the start, `split` keeps groups, `findall` returns groups, `sub` takes a function |
| `Pair<A,B>`, `Triple<A,B,C>` records | tuple return values | typed and destructurable |
| `Json.loads/dumps` | `json` | Python `", "`/`": "` output format, rejects trailing data |
| `ConfigParser` | `configparser` | DEFAULT-section inheritance, `getboolean("on")` |
| `ArgumentParser` + typed namespace | `argparse` | |
| `SequenceMatcher` | `difflib` | |
| `RobotFileParser` | `urllib.robotparser` | |
| `SystemExit` | `sys.exit` | testable, carries the code and message |

Generated code then reads like `if (Py.truthy(x))` instead of a 3-line guard. Keep this
library on the classpath of generated projects (a Maven artifact).

### 0.4 Project-wide symbol index

`definitionIndex.ts` exists; extend it to record for each function:

- parameter names, defaults, kinds (positional-only, keyword-only, `*args`, `**kwargs`)
- the inferred return type
- module globals that are **reassigned** anywhere, including from tests
  (`spider.URL_STORE = ...`)

Several rules below depend on this (keyword-argument binding, overloads, `final`).

---

## 1. P0: output must parse

**Progress (rules engine):** done: 1.7, 1.8, 1.9, 1.10, 1.15, 1.20 (each with a regression
test in `src/test/rules.test.ts`, "compilable 1.x"). 1.14 (`*/` in docstrings) already held.
Still open: the parse gate and the rows that need the AST front end (0.1).

Every item here produced a javac syntax error. Add a parse gate: run the Java output
through a Java parser (tree-sitter-java or `javac -proc:none` on the single file). On
failure, **degrade the offending statement** to a compile-safe stub
(`throw new UnsupportedOperationException("TODO(pyrite): <python source>")` plus a
comment) instead of emitting broken text. One unparseable statement must not poison the
whole file.

| # | Python | Bad output | Target |
|---|---|---|---|
| 1.1 | list / generator / set / dict comprehension, nested, with `if` | raw `x for y in z` text, garbled `.contains(...)` | loop into a fresh collection, or a stream when simple and the lambda captures only effectively-final variables |
| 1.2 | `a, b = f()` / `var (a, _, b) = ...` | Java has no destructuring | `Pair`/`Triple` temp plus one declaration per name; skip `_` |
| 1.3 | `a, b = b, a` / `x.text, x.tail = x.tail, ""` | `var (x.text, x.tail) = ...` | temps, then the assignments |
| 1.4 | walrus `if (x := f()):` / inside comprehensions | `(/* walrus */ ...)` | hoist the declaration before the statement, or turn it into a loop variable |
| 1.5 | nested `def` (closure) | method declared inside a method | lambda assigned to a `Function`/`Consumer`/`Supplier`, or a private static method when nothing is captured |
| 1.6 | statements at module level (`if TYPE_CHECKING:`, `try: import x except ImportError`, `logging.basicConfig(...)`, `d["k"] = v`) | statements in the class body; fields declared inside `try` blocks | static initializer blocks; `try/except ImportError` becomes a `static final boolean HAS_X` flag (see 3.6) |
| 1.7 | trailing comma in call arguments | `f(a, b, )` | drop it (very frequent, cheap win) |
| 1.8 | Java keywords used as identifiers (`abstract`, `char`, `_`, `default`, `new`, `class`) | compile error | suffix with `_` (`abstract_`), consistently in declaration and uses |
| 1.9 | `for _ in range(n)` | `for (int _ = 0; ...)` | a non-keyword name (`for (int i = 0; ...)`) |
| 1.10 | chained comparison `a <= b <= c` | left as is | `a <= b && b <= c` (temp if `b` has side effects) |
| 1.11 | extended slices `x[::2] = ...` | `parts.put(::2, ...)` | an index loop |
| 1.12 | star-unpacking in literals and calls `[a, *b]`, `f(*xs)`, `{*s, "x"}` | `List.of(step, *as_list(...))` | build with `addAll`; varargs via `toArray` |
| 1.13 | string literals: raw strings, escaped quotes inside f-strings, lone surrogates, `\U0001f600` | unclosed literal in Sitemaps | escape from the decoded value, not from source text: `\"`, `\\`, `\n`, `\uXXXX` for surrogates and control chars; never emit `\u000a`/`\u000d` (Java pre-lexes unicode escapes) |
| 1.14 | docstrings in methods and module | a stray `/*` opened a block comment that swallowed the test file | docstrings become Javadoc above the member; escape `*/`; never emit a bare `/*` |
| 1.15 | int literals beyond 64 bits (`18446744073709551615`, `2**64`) | verbatim or `Math.pow` | `new BigInteger("...")`, or `-1L` / `Long.parseUnsignedLong` when the type is `long` |
| 1.16 | `yield` (generator functions) | `yield x;` | return a `List` (eager) by default; an `Iterator` class only when the generator is infinite or lazy by contract |
| 1.17 | `@decorator` (`@lru_cache`, `@cache`, `@pytest.fixture`, `@classmethod`) | invented annotations `@Lru_cache(...)` | drop caching decorators with a comment; map `@classmethod`/`@staticmethod` to `static`; map test decorators (section 4) |
| 1.18 | variable first assigned inside an `if` branch, used after it | `var x` scoped to the branch | declare at the narrowest common enclosing scope with the inferred type, assign in the branches |
| 1.19 | `with lock:` declaring variables used after the block | out of scope | hoist the declarations before `synchronized` |
| 1.20 | Python exception classes (`AttributeError`, `TypeError`, `LookupError`, `UnicodeDecodeError`, `ImportError`) | used as Java classes | map table: ValueError/TypeError → `IllegalArgumentException`, KeyError/IndexError → `NoSuchElementException`/`IndexOutOfBoundsException`, OSError → `IOException`/`UncheckedIOException`, `UnicodeDecodeError` → `CharacterCodingException` |

---

## 2. P1: silent semantic errors (compile, but wrong)

These matter most. Each one is invisible until a test fails. Ship a regression test for
each.

| # | Python | Bad output | Correct output |
|---|---|---|---|
| 2.1 | **keyword arguments** `f(a=1, c=3)` | positional args in **call** order, so they bind to the wrong parameters (`args_to_extractor` passed `formatting` 4th to a constructor expecting it 7th) | reorder by the callee's signature from the index (0.4) and fill defaults; for more than ~5 keyword parameters, generate a `Kwargs` builder class (see 3.3) |
| 2.2 | default arguments `def f(a, b=None)` | a single method, and callers omit args, so it doesn't compile | telescoping overloads delegating to the full method |
| 2.3 | **star-unpacking dropped**: `(*KEYS, "a", "b", *tuple(...))` | **only the 2 literal items emitted** (Baseline `_JSON_HOOKS`: 5 of 7 entries lost) | never drop elements; if an element cannot be translated, fail the statement (see the P0 gate) |
| 2.4 | `[x] * 3` | `List.of(false)` (repetition dropped) | `Collections.nCopies(3, x)` or `new ArrayList<>(...)` |
| 2.5 | string and collection equality `a == b` | `==` (reference comparison) | `Objects.equals(a, b)` for any non-primitive type; `==` only for primitives and enums |
| 2.6 | `a or b` / `a and b` on values | `a \|\| b`, or `Objects.requireNonNullElse(a, b)` (ignores falsy `""`/`0`) | `Py.or(a, b)` / a typed ternary using truthiness |
| 2.7 | truthiness `if s:` / `not lst` / `if total and ...` | `if (s)` (doesn't compile) or `!= null` only | `Py.truthy` or a typed check (`!s.isEmpty()`, `n != 0`) |
| 2.8 | `/` on ints | integer division | `(double) a / b` when either operand is an int; `//` → `Math.floorDiv` |
| 2.9 | `x ** n` | `Math.pow` typed `Object`/double | int power when both are int literals (`10**6` → `1_000_000`); `BigInteger.pow` when it may overflow |
| 2.10 | `s.isdigit()` | `chars().allMatch(Character::isDigit)` is **true for ""** | `Py.isdigit` |
| 2.11 | `str(None)` / f-string of None | `"null"` | `Py.str(x)` (the fingerprint input in trafilatura changed because of this) |
| 2.12 | `x in ("a","b")`, `d.get(x)` with `x = None` | `List.of(...).contains(null)` **throws NullPointerException**; so do `Set.of`/`Map.of` | null-guard when `x` can be None (`x != null && SET.contains(x)`), or use HashSet-backed constants |
| 2.13 | Python `re` patterns | copied verbatim | rewrite the syntax: `{,n}` → `{0,n}`; `(?P<n>` → `(?<n>`; `\Z` → `\z`; `\U0001f600` → `\x{1f600}`; escape `[` and `{` inside classes where Java requires it; add `UNICODE_CHARACTER_CLASS` (Python 3 `\w`/`\b`/`\d` are Unicode); `IGNORECASE` → `CASE_INSENSITIVE \| UNICODE_CASE`; replacement `\1` → `$1` and escape `$` |
| 2.14 | `re.match` | `matcher.matches()`/`find()` | `lookingAt()` (anchored at the start only); `re.split` with groups keeps the groups (`Re.split`) |
| 2.15 | `isinstance(x, int)` where `x` may be bool | `instanceof Integer` | note that Python `bool` is an `int`; keep the explicit exclusion if the code has `type(x) is int` |
| 2.16 | 64-bit or unbounded ints (hashes) | `int` | `long` with unsigned helpers (`Long.toUnsignedString`, `compareUnsigned`) or `BigInteger` |
| 2.17 | `x if c else y` nested in a ternary | `recall ? "recall" : "precision" if precision else "balanced"` | translate recursively from the AST |
| 2.18 | `s.strip("/")`, `s.lstrip("@")` | `.strip("/")` (Java `strip()` takes no args) | `Py.strip(s, "/")` (char set, not prefix) |
| 2.19 | `" ".join(s.split())` | `String.join(" ", s.split())` (Java `split` needs a regex) | `String.join(" ", Py.split(s))` |
| 2.20 | `list.copy()`, `dict.pop(k[, d])`, `list.pop()`, `OrderedDict.move_to_end` | invented methods | `new ArrayList<>(x)`, `map.remove(k)` with default, `remove(size()-1)`, access-ordered `LinkedHashMap` |
| 2.21 | `[...]` later mutated | `.toList()` (immutable), then `.remove()` | `new ArrayList<>(...)` when the variable is mutated later in scope |
| 2.22 | `next(it, default)` | `.next()` (throws) | `it.hasNext() ? it.next() : default`, or a first-match loop |
| 2.23 | `sum(bool_expr for ...)` | `mapToDouble(...).sum()` assigned to an int | a counting loop with `int` |
| 2.24 | **lambdas capturing loop variables** | `filter(t -> t.size() > i)` with mutable `i` | copy to an effectively-final local first |
| 2.25 | `Map.of(...)` with more than 10 pairs (`JUSTEXT_LANGUAGES` has 77) | does not compile | `Map.ofEntries(Map.entry(...), ...)` or a static block |
| 2.26 | module globals reassigned elsewhere (`trafilatura.deduplication.LRU_TEST = ...`, `spider.URL_STORE = ...`) | `static final` | non-final `public static` when any assignment exists (0.4) |

Domain-specific lesson (lxml, but the pattern generalizes): Python libraries with
**live iterators** (`for c in el.iter()` while the body mutates the tree) behave
differently from an eager list. Don't silently convert iteration over a library object
into `List`/stream; keep `for (X x : obj.iter())` and let the target API decide.
trafilatura's extraction results depend on lxml stopping iteration when the next node
gets detached.

---

## 3. P2: types and library mapping

### 3.1 Typed declarations instead of `Object`

Constants were emitted as `Object`, `List<Object>` or `Set<Object>` even when every
element was a string literal. Infer the element type from literals (`Set<String>`,
`List<XPath>`, `Map<String, String>`). Emit `var` only for locals with a known
initializer type.

### 3.2 Tuples

- Tuple **return types** (`tuple[bool, Document]`): `Pair<Boolean, Document>` /
  `Triple`, or a generated `record` when the function is public and the fields have
  meaningful names.
- Tuple **literals used as constants** (`("a", "b")`) → `List.of(...)`; parenthesized
  implicit concatenation `("a" "b")` is a **string**, not a tuple (it was typed `Tuple`).

### 3.3 Keyword-heavy functions

For functions with many keyword parameters (trafilatura's `extract` has 27), generate:

```java
public static class Kwargs { String output_format = "txt"; boolean fast = false; ...
    public Kwargs output_format(String v) { output_format = v; return this; } ... }
public static String extract(Object filecontent, Kwargs kw)
```

Calls become `extract(html, Core.kw().output_format("xml").include_links(true))`.
That keeps the Python names, the defaults and the readability, and makes argument
binding explicit.

### 3.4 Library mapping table (data, not code)

Keep a JSON/TS table `python symbol → Java expression template + imports + Maven
coordinates`. Use it in the import resolver **and** in the pom generator. Mappings
proven in this port:

| Python | Java |
|---|---|
| `logging.getLogger(__name__)`, `%s` args | SLF4J `LoggerFactory.getLogger(X.class)`, `{}` placeholders, `warning` → `warn` (`org.slf4j:slf4j-api` + `slf4j-simple`) |
| `json` | Jackson `JsonMapper` (`com.fasterxml.jackson.core:jackson-databind`) wrapped by `Json` |
| `re` | `java.util.regex` via `Re` |
| `configparser` | runtime `ConfigParser` |
| `argparse` | runtime `ArgumentParser` + a typed namespace class |
| `pathlib.Path` / `os.path` | `java.nio.file.Path` / `Files` |
| `copy.copy/deepcopy` | `.copy()` on the type, a copy constructor, or `new ArrayList<>(...)` |
| `hashlib.blake2b` | BouncyCastle `Blake2bDigest` (`org.bouncycastle:bcprov-jdk18on`) |
| `difflib.SequenceMatcher` | runtime port |
| `urllib.parse` | runtime `urlsplit/urljoin` (`java.net.URI` differs on edge cases) |
| `urllib3` / `pycurl` | `java.net.http.HttpClient` |
| `gzip`/`zlib` | `java.util.zip` |
| `datetime.now().strftime("%Y-%m-%d")` | `ZonedDateTime.now().format(DateTimeFormatter.ofPattern("yyyy-MM-dd"))` (convert strftime codes) |
| `time.sleep` | `Thread.sleep` with `InterruptedException` handling |
| `concurrent.futures` | `ExecutorService` / `CompletionService` |
| `html.unescape` | jsoup `Parser.unescapeEntities` |
| `lxml` | no drop-in: needs a wrapper with text/tail semantics (jsoup + Jaxen were used); map `_Element`/`HtmlElement` to one type |

### 3.5 Exceptions

Python code raises `ValueError` as control flow and catches it a few frames up. Map it
consistently to one unchecked type, so `raise ValueError` and `except ValueError` stay
paired. Never emit a checked exception without `throws`; wrap it in an unchecked one.

### 3.6 Optional imports

`try: import pycurl; HAS_PYCURL = True except ImportError: HAS_PYCURL = False` →
`static final boolean HAS_PYCURL = false;` plus a comment, and code guarded by the flag
kept compile-safe. In this port, brotli, zstd, pycurl, py3langid and cchardet all
followed this pattern.

### 3.7 Imports: never invent

The LLM step produced imports that **do not exist**: `org.apache.commons.configuration2.ConfigParser`,
`org.apache.commons.lang3.tuple.Tuple`, and `org.w3c.dom.Element` for lxml elements,
which is the wrong type. Validate every suggested import against the JDK index
(`scripts/JdkIndex.java` exists) or a Maven artifact index before emitting it.
Otherwise leave a `// TODO(pyrite): no Java import for X` comment, as the rules engine
already does. In `--file` mode, Python module paths were emitted as Java imports
(`import lxml.etree.Element;`, `import settings.CUT_EMPTY_ELEMS;`).

### 3.8 Visibility

Python has no access control; `_name` is only a convention, and tests call `_helpers`.
Emit module-level functions and constants `public static`. Otherwise generated tests in
another package can't reach them.

---

## 4. P3: pytest → JUnit 5

| pytest | JUnit 5 |
|---|---|
| `def test_x():` | `@Test void test_x()` (package-private class) |
| `assert a == b` | `assertEquals(b, a)` (**never** the Java `assert` keyword: it is off without `-ea`, so failing tests pass) |
| `assert x is None` / `is not None` / `is True` / `in` / `not in` | `assertNull`/`assertNotNull`/`assertTrue`/`assertTrue(c.contains(x))`/`assertFalse(...)` |
| `assert x` | `assertTrue(Py.truthy(x))` |
| `with pytest.raises(E):` | `assertThrows(MappedE.class, () -> ...)` |
| `@pytest.mark.parametrize("a,b", [...])` (stacked = cartesian product) | `@ParameterizedTest @MethodSource` producing the product |
| `xfail(strict=True, raises=E)` | `assertThrows(E.class, ...)`; an unexpected pass must fail |
| `@pytest.fixture(autouse=True)` with `yield` | `@BeforeEach`/`@AfterEach`; suite-wide autouse in conftest.py → a JUnit `Extension` registered through `META-INF/services` + `junit.jupiter.extensions.autodetection.enabled=true` |
| `monkeypatch.setattr(module, "fn", fake)` | requires **patchable seams** in the generated production code: a `public static` functional-interface field (`Downloads.SEND_REQUEST`) that the function calls through. Detect monkeypatched names from the test files and generate seams for them |
| `tmp_path` | `@TempDir Path tmp_path` |
| `capsys` / `caplog` | redirect `System.out`/`System.err`; a log-capturing appender |
| `"x" * 50`, `[False] * 3` | `.repeat(50)`, `Collections.nCopies(3, false)` |
| long literal strings | escaped from the decoded value (1.13) |
| test resources `Path(__file__).parent / "resources"` | `src/test/resources`, resolved through the classloader |

A small AST-based translator (`py2junit.py`, about 500 lines) handled about 95% of the
statements of a 1,269-line test module automatically (12 TODOs left). Its design:
expression → `(code, type)`, a table of known API signatures for keyword binding,
asserts mapped by comparison operator, and a TODO marker for anything unknown. It shows
how far 0.1 + 0.2 alone go; consider folding it in as a reference implementation (copied to `scripts/py2junit.py`).

---

## 5. Build output

- Generate a **pom.xml** (or build.gradle) from the dependencies actually imported,
  using the mapping table's Maven coordinates.
- Use the standard layout: `src/main/java`, `src/test/java`, `src/main/resources`.
  Copy non-Python package data (`settings.cfg`, `data/*.dtd`) into resources and load
  them through the classloader instead of `Path(__file__).parent`.
- Never emit both a translated tree and a leftover copy. The trafilatura project had
  stale `tests/` and `docs/` at the root next to `trafilatura/src/...`, which confused
  the build.
- Keep the package name sensible: `trafilatura.trafilatura` (the package repeated
  under itself) came from mirroring the folder; offer a `--package` mapping.

---

## 6. Verification loop (make it part of Pyrite's tests)

1. **Parse gate per file** (P0): tree-sitter-java, zero errors allowed.
2. **Compile gate per project**: `javac` with the generated pom classpath; report
   errors per rule ID (tag generated code with the rule that produced it, e.g.
   `/* pyrite:kwargs */`, so failures map back to rules).
3. **Behavioural corpus**: keep trafilatura as an integration fixture. Its port now
   exists (`trafilatura-java`) and can serve as the golden reference for files and
   tests. Measure compile errors and passing ported tests per release.
4. **Unit tests per defect**: every row in sections 1–2 is a small Python input with an
   expected Java output; the tables above are the test list.

Suggested milestones:

| Milestone | Scope | Exit criterion |
|---|---|---|
| M1 | 0.1 AST expressions, 1.1–1.14, parse gate | every trafilatura file parses |
| M2 | 0.2 types, 0.3 runtime, 2.1–2.12, 3.1–3.3 | Settings, Utils, Deduplication, Xml compile against the runtime |
| M3 | 2.13–2.26, 3.4–3.8, pom generation | the whole library compiles |
| M4 | section 4 + seams | DeduplicationTests, FiltersTests, XmlTeiTests, BaselineTests compile and pass unmodified |

---

## Appendix: per-file defect log

The raw notes collected during the port, per generated file, are in
`compilable-java-defects.md` next to this plan.
