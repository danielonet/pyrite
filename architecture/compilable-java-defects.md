# Converter defect log (raw notes, per file)

Collected while porting Pyrite 0.4.0 output for trafilatura 2.3.1 to compilable Java. See compilable-java-plan.md for the prioritised plan.

## Settings.java
- class-level statement: `if (TYPE_CHECKING) {}` emitted inside class body
- `logging.getLogger(__name__)` left as Python
- `getattr(os, "x", None)` -> `Objects.requireNonNullElse(os.sched_getaffinity, null)`
- `a or b` on non-bool -> `a || b` (os.cpu_count() || 1, source && ...)
- set union `a | b` left as operator on Set
- `Path(__file__).parent / "x"` pathlib operators
- checked exception thrown (FileNotFoundException) without `throws`
- default args: callers call `use_config()` but only 2-arg method emitted (no overloads)
- keyword-only args flattened to positional, callers pass in CALL order not PARAMETER order (args_to_extractor passes formatting 4th, ctor has it 7th) -> silent wrong binding
- `int(s)` -> `(int) (s)` cast of String
- `s.isdigit()` -> `chars().allMatch(isDigit)` -> true for "" (Python: False)
- nested Python conditional left inside Java ternary: `recall ? "recall" : "precision" if precision else "balanced"`
- string equality with `==` (`this.format == "markdown"`)
- `bool(x)` -> `Boolean.valueOf(collection)`
- trailing comma before `)` in calls
- `Map.of(...)` with >10 pairs (JUSTEXT_LANGUAGES has 77) -> must be Map.ofEntries / static block
- `10**6` -> `Math.pow(10, 6)` typed Object (double)
- `frozenset(...)` left as call
- constants typed `Object`/`List<Object>`/`Set<Object>` though values are all String
- parenthesized implicit string concatenation `("a" "b")` typed as `Tuple`
- `getattr/setattr(obj, name)` reflective access left; `__slots__` iteration
- `isinstance(v, str)` -> `instanceof str`; `len(str)` -> `.size()`; `s[:n]` -> `.subList`
- no-arg constructor `new Document()` used but only full-arg ctor emitted
- `datetime.now().astimezone().strftime(...)` left as Python
- Python exception types (AttributeError) used as Java classes

## Utils.java
- module-level try/except ImportError emitted as `try {}` blocks in class body containing field declarations (fields declared inside statements, duplicated per branch)
- `sys.version_info >= (3, 14)` tuple comparison left
- `if TYPE_CHECKING:` class-level if
- `re.compile(...)` / `.sub` / `.search` / `.match` / `.split` / `.finditer` left as Python regex API; patterns typed `Object`
- regex flag `re.IGNORECASE` / `re.UNICODE|re.MULTILINE` passed as Python constants
- Python regex syntax differences not handled: `.{,8}` (Java needs `.{0,8}`), `\Z`, `(?P<name>)`; Unicode `\w`/`\W` need UNICODE_CHARACTER_CLASS
- `re.sub` backrefs `\1` in replacement (Java needs `$1`)
- tuple literal `("a", "b")` typed `Tuple`
- `@lru_cache(maxsize=2**14)` -> `@Lru_cache(maxsize = Math.pow(2,14))` (nonexistent annotation; also double in annotation)
- `bytearray()`, `out += chunk`, `bytes(out)`, `b"\x1f\x8b"` byte literals compared with `==` to String, `filecontent[:3]` -> `.subList`
- `zlib.decompressobj`, `brotli`, `zstd` APIs left
- `bytes.decode("utf-8")` / `UnicodeDecodeError` / `LookupError` -> need CharsetDecoder REPORT
- `str(b, encoding=..., errors="replace")` -> `String.valueOf(b, ...)`
- `x.encode("utf8", "surrogatepass")`
- `isinstance(x, bytes)` -> `instanceof bytes`; `instanceof str`; `instanceof list`
- `not x instanceof y` precedence bug: `!filecontent instanceof bytes`
- `hasattr(obj, "data")` -> `obj.data != null`
- `TypeError(...)` / `AttributeError` used as Java exceptions
- local var declared in one if-branch then used in else (`var detection_results` scoping)
- `list.extend(generator)` -> `addAll(stream.map(...))` (Stream is not a Collection)
- `a, _, b = s.partition("\n")` -> `var (a, _, b) = ...` tuple unpacking syntax
- `for _ in range(n)` -> `for (int _ = 0; ...)` (`_` is a keyword)
- `s[:4096].splitlines()[:4]` -> `.subList` on String
- `char` used as an identifier (Java keyword)
- `char.isprintable() or (...)` -> `Objects.requireNonNullElse(bool, ...)` (wrong semantics: Python `a or b` on bools)
- `"".join(map(f, string))` -> `string.stream()` (String has no stream())
- `all(map(str.isspace, s))` -> `s.stream().map(str.isspace)`; note all() on empty string is True
- `line[0]`, `line[-1]` -> `line.get(0)`, `line.get(line.size()-1)`
- `str.join(..., stream)` String.join on a Stream; `.replace("x", "", )` trailing comma
- lambda with tuple params `(k, v) -> ...` for dict items / Collectors.toMap
- `" ".join(string.split())` -> `string.split()` (Java split needs regex arg)
- `next((gen), None)` -> generated stream used twice with `.hasNext()/.next()` on a Stream
- generator functions (`yield`) emitted with `yield` statement
- walrus `while batch := tuple(islice(...))` mistranslated (`batch == null` test; Python tests emptiness)
- `any(x in RE.split(s) for elem in elems)` generator expression mangled into invalid syntax `(... for elems.contains(elem))`
- `elem.get("content", "")` -> `elem.getOrDefault(...)` (lxml element is not a Map)
- `py3langid.classify` optional dependency used unguarded; `cast("str", x)` left
- tuple return `tuple[bool, Document]` -> `Tuple.of(...)` (no such type)
- `!testtext` / `string && ...` on Strings (truthiness)
- logging `%s` placeholders with java.util.logging (no varargs formatting; `debug`/`warning` levels mismatch)

## Deduplication.java
- `@cache` / `@lru_cache` decorators emitted as annotations `@Cache`, `@Lru_cache(maxsize=...)`
- `str.maketrans`, `s.translate(tbl)`, `unicodedata.category(chr(i))[0]` left; `(char) i` cast for code points > 0xFFFF
- comprehension with walrus `[t for token in ... if (t := token.strip(p)).isalnum()]` -> `.filter(...walrus...).map(token -> t)` (t undefined)
- `token.strip(string.punctuation)` -> `.strip(arg)` (Java strip() takes no args); `string.punctuation` module constant left
- lambda capturing non-effectively-final loop var `i` in `for (int i ...)` -> `filter(t -> t.size() > i)`
- integer division `length / 2` (Python `/` is true division)
- `blake2b(...).digest()`, `s.encode()` left; `int.from_bytes(b, "big")` left (`int.` is invalid Java)
- conditional on int in lambda `token_hash & (1 << i) ? 1 : -1` (int is not boolean)
- 64-bit Python ints mapped to Java `int` (overflow; simhash needs unsigned long)
- `[0] * n` -> `List.of(0) * this.length`
- `list(map(add, a, b))` (operator.add, map with 2 iterables) left
- `sum(...)` -> `.mapToDouble(...).sum()` assigned to int return
- `f"{x:x}"` -> `String.format("%x", Object)` OK only for Integer/Long
- chained comparison `18 <= len(x) <= 22` left as Java (`a <= b <= c` invalid)
- `int(x)` / `int(x, 16)` -> `(int) (x)` / `(int) (x, 16)`
- `type(x) is int` -> `x.getClass() == int`
- `x or y` -> `Objects.requireNonNullElse(x, y)` (ignores falsy 0)
- `(a ^ b).bit_count()` left
- `OrderedDict`, `move_to_end`, `popitem(last=False)`, `dict.pop(k, default)` left
- `RLock` / `with self.lock:` -> `synchronized (this.lock)` with variable declared inside the block and used after it
- `__getstate__/__setstate__` / `__dict__` (pickling) emitted
- `isinstance(x, C) ? x : y` assigned to `var` -> type is Object, method call fails
- Python `/` on ints in `similarity()` -> Java integer division

## Xpaths.java
- tuple literals with trailing comma `("a", "b",)` emitted as `static Tuple X = ( "a", "b", );`
- helper `_alt(tuple)` typed `Tuple<String, ?>`; `String.join("|", tuple)`
- f-string triple-quoted XPaths -> Java text blocks split around `+ expr +`; mostly OK, but keyword arg `namespaces=` became a trailing positional `Map.of(...)` followed by a dangling comma `, )`
- lists of compiled XPath typed `List<Object>`; `lxml.etree.XPath` never imported/mapped
- (port note) expressions regenerated from the Python module with a recording stub instead of re-implementing the f-string/token logic

## Htmlprocessing.java (regenerated with `pyrite --file`, rules engine)
- `--file` mode emits Python module paths as imports (`import lxml.etree.Element;`, `import logging;`, `import settings.CUT_EMPTY_ELEMS;`) and no package line
- dict literal with `**dict.fromkeys(...)` splats and `"k": v` pairs emitted inside `Set.of(...)` typed as Map
- dict comprehension `{v: k for k, v in d.items()}` -> `Collectors.toMap((k, v) -> v, ...)` (lambdas take one Map.Entry)
- calling a compiled XPath object `TEX_ANNOTATION_XPATH(element)` -> `TEX_ANNOTATION_XPATH annotation = new TEX_ANNOTATION_XPATH(element)` (treated as a class); `expression(tree)` left as a call
- tuple-valued conditional `a, b = (x, y) if c else (z, w)` -> `var (opening, closing) = ... ? ("\\[", "\\]") : (...)`
- `x or ""` on strings -> `x || ""`
- `elem.find(path)` -> `elem.indexOf(path)` (lxml find is an ElementPath query, not str.find)
- `a, b = x.copy(), y.copy()` -> `var (a, b) = x.copy(), y.copy()`; `list.copy()` -> `.copy() /* shallow copy */` (no such method)
- `if total and ...` int truthiness; `total / 2` int division
- `[e for e in lst if ...]` reassigned to a list later mutated -> `.toList()` (immutable) then `.remove(...)`
- `next(gen, default) is tree` inside `any(...)` -> mangled generator expression `(... for tree.iter("p").contains(p))`
- nested comprehension `dict.fromkeys(elem for expression in nodelist for elem in expression(tree))` -> nonsense `expression(tree).stream().map(elem -> nodelist)...`
- `sum(len(x) for x in xs)` -> `(... for outer.contains(elem)).stream()` (generator expression not translated)
- `tuple[int, int, int, list[str]]` return -> `Tuple<...>`; `len(str)` -> `.size()`; `filter(e -> e)` for truthy strings
- variable first assigned inside `if` branch and reassigned in `elif/else` (`var limitlen` scoped to the if-block)
- `(a, b, _, _) = f()` re-unpacking without `var`
- `elem.text, elem.tail = elem.tail, ""` -> `var (elem.text, elem.tail) = elem.tail, "";`
- `trim(x) or None` -> `Objects.requireNonNullElse(trim(x), null)` (should map "" to null); in tuple context passed as 3 args
- `options.dedup and duplicate_test(...)` where dedup is `bool | LRUCache`
- `dict.fromkeys(list)` (ordered dedupe) left
- `str(elem.tag)`, `callable(conversion)` and dict of mixed lambdas/strings for HTML_CONVERSIONS

## Xml.java
- `importlib.metadata.version("trafilatura")` left as `version(...)`
- `{*HI_FORMATTING, "#u"}` set unpacking -> `Set.of(*HI_FORMATTING, "#u")`
- `frozenset("123456")` (set of chars) left
- dict comprehension with compiled regex values -> `Collectors.toMap(ch -> ch, ch -> re.compile(...))` over a Tuple
- `global TEI_DTD` + lazy init -> local shadowing declaration `DTD TEI_DTD = new DTD(...)` while the field is `final`
- `XMLParser(remove_blank_text=True)` / `DTD` / `.error_log.last_error` lxml APIs left
- `dict.pop(key)` on Map -> `.pop()` (Java Map has `remove`); `x or []` -> `x || .get()` (garbage)
- generator `yield attribute, value` (tuple yield) emitted as `yield a, b;`
- nested function `_escape_run` emitted as a `protected` method inside a method body; `re.Match[str]` type left
- `"\\" * n` string repetition -> `"\\" * (...)` (needs `.repeat(n)`)
- extended slices `parts[::2] = [...]` / `parts[1::2] = [...]` -> `parts.put(::2, ...)` (invalid syntax)
- `match.lastindex`, `match.start(n)` on Python match objects
- `sum(1 for _ in it)` -> `.map(_ -> 1)` (`_` keyword) + `mapToDouble(...).sum()` (double)
- `s[1:2] in HEADING_LEVELS`, `int(level[1])`
- `tail[0].isspace()` / `tail[-1]` -> `tail.get(0).isspace()`
- `copy.deepcopy(elem)` left as `deepcopy(...)`
- `csv.writer(StringIO(), delimiter=..., quoting=csv.QUOTE_MINIMAL)` left
- lxml factory calls with kwargs: `Element("TEI", xmlns=...)` -> `new Element("TEI", /* xmlns = */ "...")` (attribute kwarg became positional arg); `SubElement(parent, tag)` -> `new SubElement(...)` treated as a class and used as a variable type
- assignment to attribute of a call result `SubElement(...).text = x` -> `new SubElement(...).text = x`
- `for body, kind in ((a, "x"), (b, "y"))` -> `for (var (body, kind) : ((...), (...)))`
- Java keyword used as identifier: `SubElement abstract = ...`
- `", ".join(filter(None, [a, b]))` (drop None/empty) left
- `elem.tag, elem.text, elem.tail = "p", elem.tail, None` multi-assignment
- `reversed(list(...))` -> `.reversed()` on a List (only Java 21 SequencedCollection; OK) but on `tree.xpath(...)` raw result

## MainExtractor.java
- `set(A) | {"x"}` set union operator on Java Sets
- `any(c.tag in X for c in element)` -> `element.stream()` (lxml element is iterable, not a Collection)
- `before[-1:].isspace()` -> `before.subList(...)`
- `SubElement(...)` treated as a class (`SubElement x = new SubElement(...)`), then reassigned with `new Element("item")` -> incompatible types
- `next(it, None)` on `iter("graphic")` -> `.next()` (no default, NoSuchElementException)
- `next(it) not in coll` -> `child.iterancestors("table")!nested_elems.contains(.next())` (garbled)
- `new_child_elem.append(Element("lb"))` -> `.add(new Element("lb"))`
- `urljoin` / `re.sub` left as Python
- walrus in if: `if alt_attr := element.get("alt"):` -> `if (alt_attr = /* walrus */ ...)` (undeclared, String in boolean context)
- subset comparison of sets `a <= b` emitted as Java `<=` on Sets
- `*((...) if c else ("ref",))` star-unpacking of a conditional tuple into varargs
- `next((s for s in expr(tree) if s is not None), None)` -> stream `.next()`
- set equality `tags == {"lb"}` -> `tags == Set.of("lb")` (reference comparison)
- list equality `subelems != [subtree]` -> `subelems != List.of(subtree)` (reference comparison)
- identity `is` / `is not` mapped to `==`/`!=` (correct for objects, but used on value types elsewhere)
- `sum(e.tag != "graphic" for e in ...)` (summing booleans) -> `.map(e -> bool).mapToDouble(Number::doubleValue)`
- `zip(a, b, strict=True)` -> `Tuple.zip(...)`
- walrus inside `and` condition: `elem.tag in tags and (processed := f(...)) is not None`
- lxml live iteration semantics (`for c in el.iter("*")` while the loop strips/moves nodes) silently replaced by eager Lists/streams; lxml precomputes only the next node and stops when that node gets detached, which the extraction results depend on

## Baseline.java
- SILENT DATA LOSS: tuple with star-unpacking `(*_JSON_TEXT_KEYS, "recipeInstructions", "acceptedAnswer", *tuple(f'"{t}"' for t in ...))` emitted with only the 2 literal entries (5 of 7 hooks dropped, no warning)
- LLM-suggested import `org.w3c.dom.Element` ("found by qwen2.5-coder:7b") for lxml elements: wrong type, conflicts with the lxml Element usage
- `utils.HtmlInput` type alias (a Union) imported as if it were a class
- compiled XPath call `BASIC_CLEAN_XPATH(tree)` -> `new BASIC_CLEAN_XPATH(tree)`
- `not isinstance(x, dict)` -> `!item instanceof dict`
- list comprehensions with `if` filters inside `extend(...)` emitted as raw generator syntax `bodies.addAll(item.get(key) for ... if ...)`
- `[step, *as_list(...)]` list with star-unpacking -> `List.of(step, *as_list(...))`
- `map(_render_text, xs)` left as Python builtin
- walrus in comprehension filter `if len(text := block_text(elem)) > N` -> uses undefined `text` in `.map(elem -> text)`
- `max(map(len, xs)) / 5` -> `Collections.max(stream)` (needs a Collection) and int division
- generator expression assigned to variable `paragraphs = (... for ... if ...)` typed `Tuple`
- `teaser or (postbody, "", 0)` -> `Objects.requireNonNullElse(teaser, (postbody, "", 0))` (tuple literal)
- `teaser[2]` -> `teaser.get(2)`; `not teaser` on a tuple
- `copy(tree)` (copy.copy of an lxml element = deep copy) left
- `element.iter(*_BLOCK_ELEMS)` star-args from a Set
- `.find(".//body")` -> `.indexOf(...)` again

## JsonMetadata.java / Metadata.java
- `dict.fromkeys((...))` -> left as Python
- `Document().from_dict(...)` classmethod called on an instance -> `new Document().from_dict(...)` (static method via instance; Document had no no-arg ctor)
- walrus in conditions `(title := block_text(...))` -> `(/* title = */ /* walrus */ ...)` used as boolean
- `s.startswith(("og:", "twitter:"))` (tuple of prefixes) -> `startsWith(("og:", "twitter:"))`
- starred assignment `_, *parts = f()` emitted verbatim
- `metatype.rstrip("y")` -> `.rstrip(...)` (no such method; also char-set semantics)
- `"license" not in s.lower().split()` -> `!s.contains("license").toLowerCase().split()` (operator order scrambled)
- dict unpacking `{**date_config}` -> `Set.of(/* ** */ date_config)`; call kwargs splat `find_date(tree, **date_config)` -> `find_date(tree, /* ** */ date_config)`
- `[r for r in dict.fromkeys(line_processing(x) for x in results if x) if r]` -> garbled stream code
- `s.lstrip("@")` -> `.lstrip("@")`
- `str.encode().decode("unicode_escape")` semantics (latin-1 + escapes) not representable
- regex: Python `re` is Unicode-aware for `\w`, `\b`, `\d`, IGNORECASE on str patterns; Java needs `UNICODE_CHARACTER_CLASS` / `UNICODE_CASE` (author name regexes with umlauts)
- regex: Python `\U0001f600` escapes in a character class -> Java needs `\x{1f600}` (supplementary code points)
- regex: Python allows unescaped `{`/`[` inside char classes where Java needs escapes in some positions (e.g. `[^}[]`)
- `json.loads(..., strict=False)` and `except json.JSONDecodeError`; json.loads rejects trailing data (Jackson ignores it by default)
- `next(filter(None, m.groups()), None)` (first non-empty group)

## TrafilaturaInit.java / Meta.java / Core.java
- module-level statement `logging.getLogger(__name__).addHandler(NullHandler())` emitted inside the class body
- `__all__` re-exports turned into a `List<Object>` of names instead of facade methods / static imports
- decorated functions' `.cache_clear()` (`line_processing.cache_clear()`) called on a method name; `gc.collect()` left
- imported aliases (`from courlan.meta import clear_caches as reset_caches_courlan`) called by alias, never resolved
- `_internal_extraction(**locals())` (forwarding all args) cannot be represented; 27-parameter functions with keyword defaults flattened to positional signatures
- `copy(options)` shallow copy of an object; `str(None)` == "None" (Java String.valueOf(null) == "null") affects fingerprint input
- `try/except (TypeError, ValueError)` around a block that raises bare `ValueError` as control flow
- f-string with format spec / conditional `f"{attr}: {_yaml_scalar(v) if isinstance(v, str) else v}"` inside a generator with walrus filter

## Downloads.java
- module-level `try: import pycurl ... except ImportError` with statements (`CURL_SHARE.setopt(...)`) in class body
- urllib3 / pycurl / certifi / socket / ipaddress APIs left as-is (no Java mapping, e.g. java.net.http.HttpClient)
- classes subclassing urllib3 types (`_SafeHTTPConnection(urllib3.connection.HTTPConnection)`) emitted with Python base classes
- nested function closing over a local (`_capped_write` inside `_send_pycurl_request`) emitted as a method declaration inside a method body
- `global HTTP_POOL, NO_CERT_POOL` assignment inside a function; module globals declared final
- `functools.partial(fetch_url, options=options)` left
- generator function `yield future_to_url[future], future.result()` (tuple yield from a `with ThreadPoolExecutor` block)
- `random.choice(xs)`, `sleep()`, `os.environ.get(...)`, `version("trafilatura")`
- `2 ** (attempt - 1)` power, `/ 2` true division on ints
- `isinstance(pool, _SafePoolManager) != ssrf_protection` comparison of bool expressions
- bytes handling: `headerbytes.getvalue()`, `raw.decode("iso-8859-1", errors="replace")`, `url.encode("utf-8")`

## Feeds.java
- LLM-invented imports `org.apache.commons.configuration2.ConfigParser` and `org.apache.commons.lang3.tuple.Tuple` (neither class exists)
- `itertools.islice(iter, n)` left; `pattern.finditer(...)` left; match objects indexed `match[0]` -> `match.get(0)`
- dict comprehension over regex matches `{attr[1]: attr[3] for attr in RE.finditer(s)}` -> `.finditer(...)` chained to stream-less code
- `except (json.decoder.JSONDecodeError, RecursionError)` -> multi-catch with Python exception types
- `for i, feed in enumerate(xs[:N])` -> `for (var (i, feed) : Tuple.enumerate(...))`
- string comparison `!=` / `==` with `params.ref`, `baseurl`, `"self"`
- `x.strip("/")` with char argument -> `.strip("/")` (Java strip() takes no args)
- `link.count("/")` -> `.count(...)` on String
- `time.sleep(seconds)` left as `sleep(...)` (no Thread.sleep / InterruptedException handling)
- conditional/truthiness `if attributes.get("href") and ...` on String

## Sitemaps.java (did not parse: 64 syntax errors)
- generator expression as for-loop iterable `for match in (m[index] for m in islice(regex.finditer(c), N))` -> `for (var match : (m.get(index) for islice.contains(m)(...)))` (garbled, unparseable)
- raw f-string with escaped quotes `rf"hreflang=[\"']({re.escape(x)}.*?|x-default)[\"']"` -> broken Java string literal (`"[\\"'](" ...` -> unclosed character literal)
- nested function `def handle_lang_link(attrs)` closing over `lang_regex`/`self` emitted as a method declaration inside a method body (needs a lambda / Consumer)
- `Callable[[str], None]` parameter -> `Function<String, Void>`; calling it `handler(match)` (needs `.accept`)
- `re.Pattern[str]` -> `Pattern<String>` (java.util.regex.Pattern is not generic)
- lxml `etree.XMLParser(encoding=..., resolve_entities=False, no_network=True, recover=True)` and namespaced tag `f"{{{NS}}}loc"` (Clark notation in an f-string with escaped braces)
- `url.endswith((".gz", "sitemap", ".xml"))` tuple of suffixes
- `[f"{baseurl}/{g}" for g in reversed(GUESSES)]` / `x or [...]` list fallback
- list `.pop()` (last element) -> needs `remove(size()-1)`
- walrus inside comprehension filter `[url for u in c if u and (url := f(u))]`
- trailing comma before `)` in multi-line calls (LOGGER.debug(..., self.current_url, ))

## Spider.java (did not parse)
- `try: import py3langid except ImportError: pass` -> `try { } catch (ImportError ignored) { }` directly in the class body
- tuple unpacking with discards `_, text, _ = baseline(...)` -> `var (_, text, _) = ...`; re-assignment `(result, _) = ...`
- `known or []` -> `known || .get()` (garbled)
- keyword call `extract_links(pagecontent=..., url=url or params.base, ...)` -> positional args in caller order + trailing comma
- `links, links_priority = [], []` -> `var (links, links_priority) = new ArrayList<>(), new ArrayList<>();`
- `s.removeprefix("http://")`, `s.rsplit("/", 1)[0]`
- `RobotFileParser` (urllib.robotparser) has no mapping
- `bool(result == language)` -> `Boolean.valueOf(result == language)` (string identity comparison)
- `if htmlstring and language and LANGID_FLAG` -> `htmlstring && language && LANGID_FLAG` on Strings
- module-level mutable `URL_STORE` that tests reassign; emitted final

## docs/Conf.java, docs/DocsTests.java
- module-level statements in class body: `sys.path.insert(0, os.path.abspath("."))` -> `sys.path.add(...)` at class level; `html_theme_options["analytics"] = {...}` -> `.put(...)` statement in class body (and on an immutable `Map.of`)
- tuple values in a dict `("https://...", None)` -> `Map.of("python", ("https://...", null), ...)`
- `import trafilatura` + `trafilatura.__version__` reference not mapped
- a pytest test module placed under src/main (tests belong in src/test)
- `subprocess.run([...], capture_output=True, text=True, timeout=300,)` -> keyword args as comments + trailing comma; `pytest.fail(...)`, `tmp_path` fixture left

## Test files (pytest -> JUnit), seen in DeduplicationTests.java and the others
- pytest test functions emitted as `public static void test_x()` without `@Test`; no JUnit dependency/imports used at all
- `assert a == b` emitted as Java `assert` statements: disabled by default at runtime (no -ea), and `==` compares references for Strings/Lists (should be assertEquals)
- a stray `/*` before the first member opens a block comment, and docstrings become `/* ... */` inside method bodies, so code after a nested comment is swallowed or unbalanced
- `@pytest.fixture(autouse=True)` generator fixtures (setup/yield/teardown) -> `@Fixture` annotation on a generator method with `yield null;` (needs @BeforeEach/@AfterEach or a JUnit extension)
- `@pytest.mark.parametrize(...)` -> needs @ParameterizedTest + @MethodSource/@CsvSource
- `pytest.raises(X)` context manager -> needs assertThrows
- `monkeypatch.setattr(module, "name", fake)` cannot be expressed (static functions are not patchable): needs explicit hook fields in the production code
- `unittest.mock.patch(...)` decorators/context managers left
- integer literals beyond 64 bits (18446744073709551615, 2**64 -> Math.pow) emitted verbatim (do not compile / lose precision)
- `[False] * 3` -> `List.of(false)` (list repetition silently dropped) and a missing `;`
- `"..." * 50` string repetition on a variable -> `my_p * 50`
- assignments to module globals by dotted module path `trafilatura.deduplication.LRU_TEST = x` (needs a non-final static field)
- `pickle.dumps/loads`, `copy.copy` left
- tmp_path / capsys / caplog fixtures as parameters left untranslated

## Cross-cutting semantic traps found while running the tests
- Python `x in ("a", "b")` / `x in {...}` / `d.get(x)` are False/None for x=None; Java `List.of/Set.of/Map.of` `.contains(null)`/`.get(null)` throw NullPointerException (lxml attribute lookups `elem.get("role")` return None when absent)
- lxml iteration is live (next node computed when the current one is yielded); translating to eager lists changes results when the loop body strips/moves/removes nodes
- lxml `drop_tree()`/`drop_tag()` assert a parent; `strip_tags()` leaves the detached element without text/tail, `drop_tag()` keeps them
