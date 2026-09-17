/**
 * Unit tests for the rule-based translator. Run with `npm test` (Node's built-in test runner).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { translateWithRules } from '../translator/rules/ruleTranslator';
import { translateExpression } from '../translator/rules/expressions';
import { translateType } from '../translator/rules/typeHints';
import { splitLogicalLines } from '../translator/rules/logicalLines';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FAILURE_MARKER, globToRegExp, isExcluded, isPackageMarkerOnly, javaLineFor, javaPathFor, mirrorFile, pythonLineFor, removeMirroredFolder } from '../mirror';
import { Translator, createTranslator, moduleClassName } from '../translator';

function java(source: string, relativePath = 'pkg/mod.py'): string {
  return translateWithRules({ source, relativePath }).java;
}

function contains(haystack: string, needle: string): void {
  assert.ok(haystack.includes(needle), `expected output to contain:\n  ${needle}\n--- output ---\n${haystack}`);
}

test('logical lines join bracket continuations and keep line numbers', () => {
  const lines = splitLogicalLines('x = foo(1,\n        2)\ny = 3\n');
  assert.equal(lines[0].text, 'x = foo(1, 2)');
  assert.equal(lines[0].startLine, 1);
  assert.equal(lines[0].endLine, 2);
  assert.equal(lines[1].startLine, 3);
});

test('type hints map to Java types', () => {
  assert.equal(translateType('int'), 'int');
  assert.equal(translateType('str'), 'String');
  assert.equal(translateType('list[int]'), 'List<Integer>');
  assert.equal(translateType('Dict[str, Any]'), 'Map<String, Object>');
  assert.equal(translateType('Optional[Order]'), 'Order /* nullable */');
  assert.equal(translateType('Order | None'), 'Order /* nullable */');
  assert.equal(translateType('Callable[[str, int], bool]'), 'BiFunction<String, Integer, Boolean>');
  assert.equal(translateType('None'), 'void');
});

test('expressions: keywords, builtins and literals', () => {
  assert.equal(translateExpression('a and not b or c is None'), 'a && !b || c == null');
  assert.equal(translateExpression("print(f'Hello {name}!')"), 'System.out.println("Hello " + name + "!")');
  assert.equal(translateExpression('len(items) > 0'), 'items.size() > 0');
  assert.equal(translateExpression('[1, 2, 3]'), 'List.of(1, 2, 3)');
  assert.equal(translateExpression('{"a": 1}'), 'Map.of("a", 1)');
  assert.equal(translateExpression('x if cond else y'), 'cond ? x : y');
  assert.equal(translateExpression('"and" in words'), 'words.contains("and")');
  assert.equal(translateExpression('key not in cache'), '!cache.contains(key)');
  assert.equal(translateExpression('status in (A, B)'), 'List.of(A, B).contains(status)');
  assert.equal(translateExpression('Order(id=1, note=None)'), 'new Order(/* id = */ 1, /* note = */ null)');
  assert.equal(translateExpression('a // b + a ** 2'), 'Math.floorDiv(a, b) + Math.pow(a, 2)');
  assert.equal(translateExpression("', '.join(names)"), 'String.join(", ", names)');
  assert.equal(translateExpression('lambda x, y: x + y'), '(x, y) -> x + y');
});

test('expressions: comprehensions become streams', () => {
  assert.equal(translateExpression('[p.name for p in products if p.active]'), 'products.stream().filter(p -> p.active).map(p -> p.name).toList()');
  assert.equal(translateExpression('{o.id: o for o in orders}'), 'orders.stream().collect(Collectors.toMap(o -> o.id, o -> o))');
  assert.equal(translateExpression('sum(x * 2 for x in xs)'), 'xs.stream().map(x -> x * 2).mapToDouble(Number::doubleValue).sum()');
  assert.equal(translateExpression('"".join(c.lower() if c.isalnum() else "-" for c in text)'), 'String.join("", text.stream().map(c -> c.isalnum() ? c.toLowerCase() : "-"))');
});

test('strings are never rewritten', () => {
  assert.equal(translateExpression('"None and True"'), '"None and True"');
  assert.equal(translateExpression("'it\\'s'"), '"it\'s"');
});

test('module structure: package, imports, module class, main', () => {
  const out = java(
    `"""Doc."""
import os
from ..models import Order, Customer as C

X = 1

def helper(a: int, b: str = "x") -> bool:
    return a > 0

if __name__ == "__main__":
    helper(1)
`,
    'app/services/svc.py',
  );
  contains(out, 'package app.services;');
  contains(out, 'import os;');
  contains(out, 'import app.models.Order;');
  contains(out, 'import app.models.Customer; // as C');
  contains(out, '/** Doc. */\npublic final class Svc {');
  contains(out, 'public static final int X = 1;');
  contains(out, 'public static boolean helper(int a, String b /* = "x" */) {');
  contains(out, 'public static void main(String[] args) {');
  assert.ok(out.trimEnd().endsWith('}'));
});

test('classes: dataclass fields, constructor, properties, enum, inheritance', () => {
  const out = java(`
from dataclasses import dataclass, field
from enum import Enum

class Color(Enum):
    RED = 1
    GREEN = 2

@dataclass
class Point:
    x: int
    y: int = 0
    tags: list[str] = field(default_factory=list)

    @property
    def norm(self) -> float:
        return (self.x ** 2 + self.y ** 2) ** 0.5

class Repo(Base):
    def __init__(self, url: str, retries=3):
        self.url = url
        self._retries = retries

    def __str__(self):
        return f"Repo({self.url})"

class MyError(ValueError):
    pass
`);
  contains(out, 'public enum Color {');
  contains(out, 'RED(1),');
  contains(out, '@Dataclass\n    public static class Point {');
  contains(out, 'public int x;');
  contains(out, 'public int y = 0;');
  contains(out, 'public List<String> tags = new ArrayList<>();');
  contains(out, '@Property');
  contains(out, 'public double norm() {');
  contains(out, 'public static class Repo extends Base {');
  contains(out, 'public String url; // assigned as self.url in __init__()');
  contains(out, 'private int _retries; // assigned as self._retries in __init__()');
  contains(out, 'public Repo(String url, int retries /* = 3 */) {');
  contains(out, 'this.url = url;');
  contains(out, 'public String toString() {');
  contains(out, 'public static class MyError extends IllegalArgumentException {');
});

test('symbols: classes, methods and fields are recorded for "Go to Definition"', () => {
  const result = translateWithRules({
    source: `
class Repo:
    def __init__(self, url: str):
        self.url = url

    def fetch(self):
        return self.url
`,
    relativePath: 'app/repo.py',
  });
  const lines = result.java.split('\n');
  const byName = (name: string) => result.symbols.filter((s) => s.name === name);

  const module = byName('Repo').find((s) => s.container.length === 0);
  assert.ok(module, 'module class Repo should be recorded');
  assert.equal(module!.kind, 'class');
  assert.equal(lines[module!.javaLine], 'public final class Repo {');

  const nestedClass = byName('Repo').find((s) => s.kind === 'class' && s.container.length === 1);
  assert.ok(nestedClass, 'nested class Repo should be recorded, distinct from the module class');
  assert.deepEqual(nestedClass!.container, ['Repo']);
  assert.match(lines[nestedClass!.javaLine], /static class Repo/);

  const ctor = byName('Repo').find((s) => s.kind === 'method');
  assert.ok(ctor, 'constructor should be recorded as a method named after the class');
  assert.deepEqual(ctor!.container, ['Repo', 'Repo']);

  const field = byName('url').find((s) => s.kind === 'field');
  assert.ok(field, 'field url should be recorded');
  assert.deepEqual(field!.container, ['Repo', 'Repo']);
  assert.match(lines[field!.javaLine], /String url;/);

  const method = byName('fetch').find((s) => s.kind === 'method');
  assert.ok(method, 'method fetch should be recorded');
  assert.match(lines[method!.javaLine], /fetch\(\)/);
  assert.equal(method!.pythonLine, 6);
});

test('control flow: if/elif/else, for range, for items, try/except/finally, with, raise', () => {
  const out = java(`
def f(items, d):
    for i in range(3):
        if i == 0:
            continue
        elif i == 1:
            pass
        else:
            break
    for k, v in d.items():
        print(k, v)
    try:
        risky()
    except (KeyError, ValueError) as e:
        raise RuntimeError("boom") from e
    except Exception:
        raise
    finally:
        cleanup()
    with open(p) as fh:
        data = fh.read()
    while not done:
        done = step()
`);
  contains(out, 'for (int i = 0; i < 3; i++) {');
  contains(out, 'if (i == 0) {');
  contains(out, '} else if (i == 1) {');
  contains(out, '} else {');
  contains(out, 'for (var entry : d.entrySet()) {');
  contains(out, 'var k = entry.getKey();');
  contains(out, 'try {');
  contains(out, '} catch (NoSuchElementException | IllegalArgumentException e) {');
  contains(out, 'throw new RuntimeException("boom"); // caused by e');
  contains(out, '} catch (Exception ignored) {');
  contains(out, 'throw ignored; // re-raise');
  contains(out, '} finally {');
  contains(out, 'try (var fh = new BufferedReader(new FileReader(p))) { // with');
  contains(out, 'var data = fh.read();');
  contains(out, 'while (!done /* falsy: null or empty */) {');
  contains(out, 'done = step();'); // second assignment: no re-declaration
});

test('blank lines never precede a closing brace and comments stay in place', () => {
  const out = java(`
def a():
    x = 1

    # trailing comment inside a
    return x


def b():
    if x:
        y = 2
    # after the if
    return y
`);
  assert.ok(!/\n\s*\n\s*\}/.test(out), `blank line before a closing brace:\n${out}`);
  contains(out, '        // trailing comment inside a\n        return x;');
  contains(out, '        }\n        // after the if\n        return y;');
});

test('source map points generated lines at Python lines', () => {
  const src = 'import os\n\ndef f():\n    return 1\n';
  const result = translateWithRules({ source: src, relativePath: 'm.py' });
  const lines = result.java.split('\n');
  const defIdx = lines.findIndex((l) => l.includes('f() {'));
  assert.equal(result.sourceMap[defIdx], 3);
  const retIdx = lines.findIndex((l) => l.includes('return 1;'));
  assert.equal(result.sourceMap[retIdx], 4);
  assert.equal(result.sourceMap.length, lines.length);
});

test('javadoc: "always" mode generates for undocumented members too, docstrings copied, @param/@return always extrapolated', () => {
  const src = `class Point:
    """A 2D point."""
    def __init__(self, x, y):
        self.x = x
        self.y = y

    def is_valid(self):
        return self.x is not None
`;
  const out = translateWithRules({ source: src, relativePath: 'pkg/mod.py', javadocMode: 'always' }).java;
  contains(out, '/** A 2D point. */\n    public static class Point {');
  contains(out, '         * Constructs a new Point.\n         *\n         * @param x the x\n         * @param y the y\n         */');
  contains(out, '         * Returns whether valid.\n         *\n         * @return true if valid, false otherwise\n         */');
});

test('javadoc: "docstringOnly" mode skips undocumented members but still documents and tags the rest', () => {
  const src = `class Point:
    """A 2D point."""
    def __init__(self, x, y):
        self.x = x
        self.y = y

    def is_valid(self):
        return self.x is not None
`;
  const out = translateWithRules({ source: src, relativePath: 'pkg/mod.py', javadocMode: 'docstringOnly' }).java;
  contains(out, '/** A 2D point. */\n    public static class Point {');
  assert.ok(!out.includes('Constructs a new Point'), `constructor should not get a generated Javadoc:\n${out}`);
  assert.ok(!out.includes('Returns whether valid'), `is_valid() should not get a generated Javadoc:\n${out}`);
  contains(out, 'public Point(Object x, Object y) {');
  contains(out, 'public Object is_valid() {');
});

test('javadoc: defaults to "docstringOnly" when javadocMode is not specified', () => {
  const src = `class Point:
    def __init__(self, x, y):
        self.x = x
        self.y = y
`;
  const out = java(src);
  assert.ok(!out.includes('/**'), `expected no generated Javadoc by default:\n${out}`);
});

test('javadoc: test code is never documented by default, even with a docstring and javadocMode "always"', () => {
  const src = `class TestPoint:
    """Tests for Point."""
    def test_addition(self):
        """Checks that addition works."""
        assert 1 + 1 == 2
`;
  for (const relativePath of ['pkg/tests/test_point.py', 'pkg/test_point.py', 'pkg/point_test.py', 'pkg/conftest.py']) {
    const out = translateWithRules({ source: src, relativePath, javadocMode: 'always' }).java;
    assert.ok(!out.includes('/**'), `expected no Javadoc for test file ${relativePath}:\n${out}`);
    contains(out, '/* Tests for Point. */');
  }
});

test('javadoc: "javadocTestCode: true" makes test code follow the same javadocMode as production code', () => {
  const src = `class TestPoint:
    """Tests for Point."""
    def test_addition(self):
        assert 1 + 1 == 2
`;
  const out = translateWithRules({ source: src, relativePath: 'pkg/tests/test_point.py', javadocMode: 'always', documentTestCode: true }).java;
  contains(out, '/** Tests for Point. */');
  contains(out, 'Tests addition.');
});

test('javadoc: non-test code is unaffected by documentTestCode', () => {
  const src = `class Point:
    def __init__(self, x, y):
        self.x = x
        self.y = y
`;
  const out = translateWithRules({ source: src, relativePath: 'pkg/point.py', javadocMode: 'always', documentTestCode: false }).java;
  contains(out, 'Constructs a new Point.');
});

test('javadoc: "none" mode emits no Javadoc; docstrings fall back to a plain comment', () => {
  const src = `class Point:
    """A 2D point."""
    def __init__(self, x, y):
        self.x = x
        self.y = y
`;
  const out = translateWithRules({ source: src, relativePath: 'pkg/mod.py', javadocMode: 'none' }).java;
  assert.ok(!out.includes('/**'), `expected no Javadoc block:\n${out}`);
  contains(out, '/* A 2D point. */\n        public Point(Object x, Object y) {');
});

test('lombok: off by default - boilerplate is spelled out as before', () => {
  const src = `class Person:
    def __init__(self, name, age):
        self.name = name
        self.age = age

    def __str__(self):
        return f"{self.name}"
`;
  const out = translateWithRules({ source: src, relativePath: 'pkg/mod.py' }).java;
  contains(out, 'public Person(Object name, Object age) {');
  contains(out, 'public String toString() {');
  assert.ok(!out.includes('@AllArgsConstructor'));
  assert.ok(!out.includes('@ToString'));
});

test('lombok: a pure self.x = x constructor becomes @AllArgsConstructor', () => {
  const src = `class Person:
    def __init__(self, name, age):
        self.name = name
        self.age = age
`;
  const out = translateWithRules({ source: src, relativePath: 'pkg/mod.py', lombokStyle: true }).java;
  contains(out, '@AllArgsConstructor');
  assert.ok(!out.includes('public Person('), `constructor should be collapsed away:\n${out}`);
  contains(out, 'public Object name;');
  contains(out, 'public Object age;');
});

test('lombok: a constructor with a default value or extra fields is left spelled out', () => {
  const src = `class Account:
    def __init__(self, owner, balance=0.0):
        self.owner = owner
        self.balance = balance

class Widget:
    def __init__(self, a):
        self.a = a
        self.b = 0
`;
  const out = translateWithRules({ source: src, relativePath: 'pkg/mod.py', lombokStyle: true }).java;
  contains(out, 'public Account(Object owner, double balance /* = 0.0 */) {');
  contains(out, 'public Widget(Object a) {');
  assert.ok(!out.includes('@AllArgsConstructor'));
});

test('lombok: trivial __str__/__repr__ and __eq__/__hash__ become @ToString/@EqualsAndHashCode', () => {
  const src = `class Person:
    def __init__(self, name):
        self.name = name

    def __str__(self):
        return self.name

    def __eq__(self, other):
        return self.name == other.name

    def __hash__(self):
        return hash(self.name)
`;
  const out = translateWithRules({ source: src, relativePath: 'pkg/mod.py', lombokStyle: true }).java;
  contains(out, '@ToString');
  contains(out, '@EqualsAndHashCode');
  assert.ok(!out.includes('public String toString()'));
  assert.ok(!out.includes('public boolean equals('));
  assert.ok(!out.includes('public int hashCode()'));
});

test('lombok: a non-trivial __str__ (multiple statements) is left spelled out', () => {
  const src = `class Person:
    def __init__(self, name):
        self.name = name

    def __str__(self):
        prefix = "Person: "
        return prefix + self.name
`;
  const out = translateWithRules({ source: src, relativePath: 'pkg/mod.py', lombokStyle: true }).java;
  assert.ok(!out.includes('@ToString'));
  contains(out, 'public String toString() {');
});

test('lombok: a trivial @property/@x.setter pair over a field becomes @Getter/@Setter', () => {
  const src = `class Account:
    def __init__(self, owner, balance):
        self._owner = owner
        self._balance = balance

    @property
    def owner(self):
        return self._owner

    @property
    def balance(self):
        return self._balance

    @balance.setter
    def balance(self, value):
        self._balance = value
`;
  const out = translateWithRules({ source: src, relativePath: 'pkg/mod.py', lombokStyle: true }).java;
  // The backing field is named after the property so Lombok generates getOwner()/setBalance(), not get_owner().
  contains(out, '@Getter\n        private Object owner; // assigned as self._owner in __init__()');
  contains(out, '@Getter @Setter\n        private Object balance; // assigned as self._balance in __init__()');
  contains(out, 'this.owner = owner;');
  assert.ok(!out.includes('owner()'), `getter method should be collapsed away:\n${out}`);
  assert.ok(!out.includes('balance()'), `getter/setter methods should be collapsed away:\n${out}`);
});

test('lombok: a property with non-trivial logic keeps its manual method', () => {
  const src = `class Account:
    def __init__(self, balance):
        self._balance = balance

    @property
    def balance(self):
        return max(self._balance, 0)
`;
  const out = translateWithRules({ source: src, relativePath: 'pkg/mod.py', lombokStyle: true }).java;
  assert.ok(!out.includes('@Getter'));
  contains(out, 'balance() {');
});

test('lombok: a dataclass becomes @Data', () => {
  const src = `from dataclasses import dataclass

@dataclass
class Point:
    x: int
    y: int
`;
  const out = translateWithRules({ source: src, relativePath: 'pkg/mod.py', lombokStyle: true }).java;
  contains(out, '@Data\n    public static class Point {');
  assert.ok(!out.includes('@Dataclass'));
});

test('mirror helpers: globs and line lookups', () => {
  assert.ok(globToRegExp('**/node_modules/**').test('a/node_modules/b.py'));
  assert.ok(isExcluded('.venv/lib/x.py', ['**/.venv/**']));
  assert.ok(!isExcluded('src/x.py', ['**/.venv/**']));
  const map = { python: 'a.py', java: '.java-view/a.java', engine: 'rules', generatedAt: '', lines: [0, 0, 1, 0, 3, 4, 0], symbols: [] };
  assert.equal(pythonLineFor(map, 3), 1);
  assert.equal(pythonLineFor(map, 6), 4);
  assert.equal(javaLineFor(map, 3), 4);
  assert.equal(javaLineFor(map, 2), 4); // nearest following mapped line
});

test('isPackageMarkerOnly: __init__.py with only docstring/comments/__all__ is a bare package marker', () => {
  assert.equal(isPackageMarkerOnly('pkg/__init__.py', ''), true);
  assert.equal(isPackageMarkerOnly('pkg/__init__.py', '\"\"\"Inventory domain package.\"\"\"\n'), true);
  assert.equal(isPackageMarkerOnly('pkg/__init__.py', '# nothing here\n\n\"\"\"Doc\nspanning lines.\"\"\"\n__all__ = [\n    "models",\n    "services",\n]\n'), true);
  assert.equal(isPackageMarkerOnly('pkg/__init__.py', '__all__: list[str] = ["models"]\n'), true);
  // Real content keeps the file.
  assert.equal(isPackageMarkerOnly('pkg/__init__.py', '\"\"\"Doc.\"\"\"\n__version__ = "0.1.0"\n__all__ = ["models"]\n'), false);
  assert.equal(isPackageMarkerOnly('pkg/__init__.py', 'from .models import Item\n'), false);
  assert.equal(isPackageMarkerOnly('pkg/__init__.py', 'def setup():\n    pass\n'), false);
  // Only __init__.py is ever a marker.
  assert.equal(isPackageMarkerOnly('pkg/mod.py', ''), false);
  assert.equal(isPackageMarkerOnly('pkg/mod.py', '\"\"\"Doc.\"\"\"\n'), false);
});

test('mirrorFile skips a bare __init__.py and removes its stale Java view', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pyrite-init-'));
  try {
    fs.mkdirSync(path.join(root, 'pkg'), { recursive: true });
    const { translator } = createTranslator({ engine: 'rules' });
    const init = path.join(root, 'pkg', '__init__.py');

    fs.writeFileSync(init, '__version__ = "1.0"\n', 'utf8');
    const first = await mirrorFile(translator, root, 'pkg/__init__.py');
    assert.equal(first.skipped, false);
    const javaAbs = path.join(root, '.java-view', 'pkg', 'pkgInit.java');
    assert.ok(fs.existsSync(javaAbs));
    contains(fs.readFileSync(javaAbs, 'utf8'), 'public final class Pkg {');
    // Leftovers from the names earlier versions used are cleaned up too.
    const legacy = ['__init__.java', 'Pkg.java', 'PkgPackage.java'].map((n) => path.join(root, '.java-view', 'pkg', n));
    for (const abs of legacy) fs.writeFileSync(abs, '// stale', 'utf8');
    await mirrorFile(translator, root, 'pkg/__init__.py');
    for (const abs of legacy) assert.equal(fs.existsSync(abs), false, `legacy ${path.basename(abs)} should be removed`);
    assert.ok(fs.existsSync(javaAbs), 'the current view must survive the cleanup');

    fs.writeFileSync(init, '\"\"\"Just a package.\"\"\"\n', 'utf8');
    const second = await mirrorFile(translator, root, 'pkg/__init__.py');
    assert.equal(second.skipped, true);
    assert.equal(fs.existsSync(javaAbs), false, 'stale Java view should be removed');
    assert.equal(fs.existsSync(path.join(root, '.java-view', '.pyrite', 'maps', 'pkg', 'pkgInit.java.json')), false, 'stale map should be removed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('package module: named after its folder, Javadoc names the original __init__.py', () => {
  assert.equal(moduleClassName('app/inventory/__init__.py'), 'Inventory');
  assert.equal(moduleClassName('app/order_service.py'), 'OrderService');
  assert.equal(moduleClassName('__init__.py'), 'Init');
  assert.equal(javaPathFor('app/inventory/__init__.py'), 'app/inventory/inventoryInit.java');
  assert.equal(javaPathFor('app/order_items/__init__.py'), 'app/order_items/orderItemsInit.java');
  assert.equal(moduleClassName('app/order_items/__init__.py'), 'OrderItems');
  assert.equal(javaPathFor('app/order_service.py'), 'app/order_service.java');
  // The Init suffix keeps the file distinct from a sibling module on a case-insensitive filesystem.
  assert.notEqual(
    javaPathFor('app/inventory/__init__.py').toLowerCase(),
    javaPathFor('app/inventory/inventory.py').toLowerCase(),
  );

  const src = '\"\"\"Inventory domain package.\"\"\"\n__version__ = "0.1.0"\n';
  const withDoc = java(src, 'app/inventory/__init__.py');
  contains(withDoc, 'public final class Inventory {');
  contains(withDoc, ' * Inventory domain package.');
  contains(withDoc, " * Translated from {@code app/inventory/__init__.py}, the {@code inventory} package's __init__ module.");
  assert.ok(!withDoc.includes('InventoryPackage'));

  // Without a docstring in docstringOnly mode there is no Javadoc, so the origin goes in a plain comment.
  const noDoc = java('__version__ = "0.1.0"\n', 'app/inventory/__init__.py');
  contains(noDoc, "// Translated from app/inventory/__init__.py, the package's __init__ module.\npublic final class Inventory {");
  const none = translateWithRules({ source: src, relativePath: 'app/inventory/__init__.py', javadocMode: 'none' }).java;
  contains(none, "// Translated from app/inventory/__init__.py, the package's __init__ module.\npublic final class Inventory {");
});

function lombok(source: string, relativePath = 'pkg/mod.py'): string {
  return translateWithRules({ source, relativePath, lombokStyle: true }).java;
}

/** Every `{` in the output has a matching `}` (comments and string literals are stripped first). */
function assertBracesBalanced(out: string): void {
  const code = out.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').replace(/"(?:[^"\\]|\\.)*"/g, '""');
  const opens = (code.match(/\{/g) ?? []).length;
  const closes = (code.match(/\}/g) ?? []).length;
  assert.equal(opens, closes, `unbalanced braces (${opens} open, ${closes} close):\n${out}`);
}

test('regression: a keyword-only or positional-only marker in __init__ no longer crashes Lombok style', () => {
  const src = `
class Service:
    def __init__(self, repo, *, currency: str = "EUR"):
        self.repo = repo
        self.currency = currency

class Point:
    def __init__(self, x, /, y):
        self.x = x
        self.y = y

class Bag:
    def __init__(self, *items, **options):
        self.items = items
        self.options = options
`;
  const out = lombok(src);
  contains(out, 'public Service(Object repo, String currency /* = "EUR" */) {');
  // The positional-only marker is just a separator: the constructor is still pure boilerplate.
  contains(out, '@AllArgsConstructor\n    public static class Point {');
  // Varargs/kwargs constructors have no @AllArgsConstructor shape and stay spelled out.
  contains(out, 'public Bag(Object... items, Map<String, Object> options /* **kwargs */) {');
  assert.ok(!/@AllArgsConstructor\n    public static class Bag/.test(out));
});

test('regression: every match/case arm is closed before the next one opens', () => {
  const out = java(`
def route(cmd):
    match cmd:
        case "go":
            return 1
        case ["x", y]:
            return y
        case _:
            return 0
`);
  contains(out, 'case "go" -> {\n                return 1;\n            }\n            case List.of("x", y) -> {');
  contains(out, 'return y;\n            }\n            default -> {');
  assertBracesBalanced(out);
});

test('regression: a docstring containing */ does not end the Javadoc or block comment early', () => {
  const src = ['def find():', '    """Match \'a*/b\' and end."""', '    return 1', ''].join('\n');
  const withJavadoc = java(src);
  contains(withJavadoc, "Match 'a*&#47;b' and end.");
  assert.ok(!withJavadoc.includes('a*/b'), withJavadoc);
  const plain = translateWithRules({ source: src, relativePath: 'pkg/mod.py', javadocMode: 'none' }).java;
  contains(plain, "/* Match 'a*&#47;b' and end. */");
});

test('regression: cls is the class inside method bodies, so cls(...) becomes new C(...)', () => {
  const out = java(`
class C:
    @classmethod
    def of(cls, a):
        return cls(a)

    def copy(self):
        def inner():
            return cls.of(1)
        return inner()
`);
  contains(out, 'return new C(a);');
  contains(out, 'return C.of(1);');
});

test('regression: negative slice bounds count from the end', () => {
  assert.equal(translateExpression('xs[-2:]'), 'xs.subList(xs.size() - 2, xs.size())');
  assert.equal(translateExpression('xs[1:-1]'), 'xs.subList(1, xs.size() - 1)');
  assert.equal(translateExpression('xs[:3]'), 'xs.subList(0, 3)');
  assert.equal(translateExpression('xs[-1]'), 'xs.get(xs.size() - 1)');
});

test('regression: < and > are comparisons, not brackets, when splitting at top level', () => {
  const out = java(`
def cmp(a, b):
    return a > b, a < b
`);
  contains(out, 'return Tuple.of(a > b, a < b);');
  // Generic type hints still translate: the [] brackets do the nesting.
  assert.equal(translateType('dict[str, list[int]]'), 'Map<String, List<Integer>>');
});

test('a failed translation writes a placeholder view instead of leaving the old one', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pyrite-fail-'));
  try {
    fs.mkdirSync(path.join(root, 'pkg'));
    fs.writeFileSync(path.join(root, 'pkg', 'mod.py'), 'x = 1\n', 'utf8');
    const { translator } = createTranslator({ engine: 'rules' });
    const first = await mirrorFile(translator, root, 'pkg/mod.py');
    assert.equal(first.skipped, false);
    const javaAbs = path.join(root, '.java-view', 'pkg', 'mod.java');
    contains(fs.readFileSync(javaAbs, 'utf8'), 'static int x = 1;');

    const broken: Translator = { name: 'rules', translate: async () => { throw new Error('boom on line 3'); } };
    await assert.rejects(mirrorFile(broken, root, 'pkg/mod.py'), /boom on line 3/);
    const view = fs.readFileSync(javaAbs, 'utf8');
    contains(view, FAILURE_MARKER);
    contains(view, 'boom on line 3');
    contains(view, 'package pkg;');
    contains(view, 'public final class Mod {');
    assert.ok(!view.includes('static int x = 1;'), 'the stale code must be gone');
    const map = JSON.parse(fs.readFileSync(path.join(root, '.java-view', '.pyrite', 'maps', 'pkg', 'mod.java.json'), 'utf8'));
    assert.deepEqual(map.symbols, []);
    assert.deepEqual(map.lines, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('removeMirroredFolder deletes the mirrored subtree and its maps, and nothing else', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pyrite-rmdir-'));
  try {
    fs.mkdirSync(path.join(root, 'app', 'old'), { recursive: true });
    fs.writeFileSync(path.join(root, 'app', 'old', 'a.py'), 'x = 1\n', 'utf8');
    fs.writeFileSync(path.join(root, 'app', 'keep.py'), 'y = 2\n', 'utf8');
    const { translator } = createTranslator({ engine: 'rules' });
    await mirrorFile(translator, root, 'app/old/a.py');
    await mirrorFile(translator, root, 'app/keep.py');
    removeMirroredFolder(root, 'app/old/');
    assert.equal(fs.existsSync(path.join(root, '.java-view', 'app', 'old')), false);
    assert.equal(fs.existsSync(path.join(root, '.java-view', '.pyrite', 'maps', 'app', 'old')), false);
    assert.ok(fs.existsSync(path.join(root, '.java-view', 'app', 'keep.java')));
    // Guard rails: never wipe the output root or escape it.
    removeMirroredFolder(root, '');
    removeMirroredFolder(root, '../elsewhere');
    assert.ok(fs.existsSync(path.join(root, '.java-view', 'app', 'keep.java')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('builtins: calls are rewritten with balanced arguments, nested and keyword-aware', () => {
  const e = (s: string) => translateExpression(s);
  assert.equal(e('len(a + b)'), '(a + b).size()');
  assert.equal(e('len(self.repo.orders())'), 'this.repo.orders().size()');
  assert.equal(e('sum(paid)'), 'paid.stream().mapToDouble(Number::doubleValue).sum()');
  assert.equal(e('sum(i for i in range(3))'), 'IntStream.range(0, 3).boxed().mapToDouble(Number::doubleValue).sum()');
  assert.equal(e('sorted(xs)'), 'xs.stream().sorted().toList()');
  assert.equal(e('sorted(xs, key=lambda o: o.x, reverse=True)'), 'xs.stream().sorted(Comparator.comparing(o -> o.x).reversed()).toList()');
  assert.equal(e('any(x > 1 for x in xs)'), 'xs.stream().anyMatch(x -> x > 1)');
  assert.equal(e('all(xs)'), 'xs.stream().allMatch(Boolean.TRUE::equals)');
  assert.equal(e('next(it)'), 'it.next()');
  assert.equal(e('next(it, None)'), 'it.hasNext() ? it.next() : null');
  assert.equal(e('iter(xs)'), 'xs.iterator()');
  assert.equal(e('round(x)'), 'Math.round(x)');
  assert.equal(e('round(x * y, 2)'), 'Math.round((x * y) * 100.0) / 100.0');
  assert.equal(e('list(map(str, r))'), 'r.stream().map(String::valueOf).toList()');
  assert.equal(e('filter(None, xs)'), 'xs.stream().filter(Objects::nonNull)');
  assert.equal(e('zip(a, b)'), 'Tuple.zip(a, b)');
  assert.equal(e('range(1, n)'), 'IntStream.range(1, n)');
  assert.equal(e('isinstance(x, (A, B))'), '(x instanceof A || x instanceof B)');
  assert.equal(e('isinstance(x, A)'), 'x instanceof A');
  assert.equal(e('getattr(o, "name")'), 'o.name /* getattr */');
  assert.equal(e('getattr(o, "name", 1)'), 'Objects.requireNonNullElse(o.name, 1)');
  assert.equal(e('getattr(o, attr)'), 'getattr(o, attr) /* reflective attribute access */');
  assert.equal(e('hasattr(o, "x")'), 'o.x != null /* hasattr */');
  assert.equal(e('open(p)'), 'new BufferedReader(new FileReader(p))');
  assert.equal(e('open(p, "w")'), 'new PrintWriter(p)');
  assert.equal(e('open(p, "rb")'), 'new FileInputStream(p)');
  assert.equal(e('min(xs)'), 'Collections.min(xs)');
  assert.equal(e('min(a, b, c)'), 'Math.min(a, Math.min(b, c))');
  assert.equal(e('max(xs, key=len)'), 'Collections.max(xs, Comparator.comparing(v -> v.size()))');
  assert.equal(e('list()'), 'new ArrayList<>()');
  assert.equal(e('list(xs)'), 'new ArrayList<>(xs)');
  assert.equal(e('set(x for x in xs)'), 'xs.stream().collect(Collectors.toSet())');
  assert.equal(e('dict()'), 'new HashMap<>()');
  // A method of the same name is not a builtin.
  assert.equal(e('obj.sum(xs)'), 'obj.sum(xs)');
});

test('builtins: `a or b` is a fallback in value position and a boolean in a condition', () => {
  const out = java(`
def f(note, buffer):
    label = note or "n/a"
    stream = buffer or io.StringIO()
    if note or buffer:
        return note or buffer
    return note is None or buffer
`);
  contains(out, 'var label = Objects.requireNonNullElse(note, "n/a");');
  contains(out, 'var stream = Objects.requireNonNullElse(buffer, new io.StringIO());');
  contains(out, 'if (note || buffer) {');
  contains(out, 'return Objects.requireNonNullElse(note, buffer);');
  contains(out, 'return note == null || buffer;');
});

test('builtins: file APIs pull in java.io', () => {
  const out = java(`
def read(p):
    with open(p) as fh:
        return fh.read()
`);
  contains(out, 'import java.io.*;');
  contains(out, 'try (var fh = new BufferedReader(new FileReader(p))) {');
});

test('properties: reads become accessor calls and writes become setter calls, consistently with how the accessor was emitted', () => {
  const src = `
class Order:
    def __init__(self, lines):
        self.lines = lines
        self._note = ""

    @property
    def total(self) -> float:
        return sum(l.price for l in self.lines)

    @property
    def note(self) -> str:
        return self._note

    @note.setter
    def note(self, value: str):
        self._note = value

    def describe(self):
        return f"{self.total} {self.note}"

class Report:
    def __init__(self, name):
        self.name = name

def run(order: Order, report):
    order.note = "paid"
    order.note += "!"
    print(order.total, report.name)
`;
  const plain = java(src);
  contains(plain, '@Property // Python property: read as obj.total, rendered as obj.total()');
  contains(plain, 'return this.total() + " " + this.note();');
  contains(plain, 'order.note("paid");');
  contains(plain, 'order.note(order.note() + "!");');
  contains(plain, 'System.out.println(order.total(), report.name);'); // `name` is a plain attribute: untouched

  const styled = lombok(src);
  // `total` is not trivial: still a method. `note` is trivial: field renamed, Lombok accessor names.
  contains(styled, 'public double total() {');
  contains(styled, '@Getter @Setter\n        private String note; // assigned as self._note in __init__()');
  contains(styled, 'return this.total() + " " + this.getNote();');
  contains(styled, 'order.setNote("paid");');
  contains(styled, 'order.setNote(order.getNote() + "!");');
  assert.ok(!styled.includes('this._note'), styled);
});

test('properties: a boolean trivial property gets an is-accessor in Lombok style', () => {
  const out = lombok(`
class Flag:
    def __init__(self, active: bool):
        self._active = active

    @property
    def active(self) -> bool:
        return self._active

def check(flag):
    return flag.active
`);
  contains(out, '@Getter\n        private boolean active;');
  contains(out, 'return flag.isActive();');
});

test('types: locals, fields and loop variables take their type from hints and calls', () => {
  const out = java(`
from typing import Dict, List

def load(path: str) -> Order:
    return Order()

class Repo:
    def order(self, order_id: int) -> "Order":
        return self._orders[order_id]

class Service:
    lines: List[OrderLine] = []
    prices: Dict[str, float] = {}

    def __init__(self, repo: Repo):
        self.repo = repo
        self.first = self.repo.order(1)
        self.loaded = load("x")

    def _require(self, order_id: int) -> Order:
        return self.repo.order(order_id)

    def run(self, orders: List[Order]):
        current = self._require(1)
        other = self.repo.order(2)
        fresh = load("y")
        for line in self.lines:
            print(line)
        for sku, price in self.prices.items():
            print(sku, price)
        for i, line in enumerate(self.lines):
            print(i, line)
        for o in orders:
            print(o)
        for k in self.prices:
            print(k)
`);
  contains(out, 'public Order first; // assigned as self.first in __init__()');
  contains(out, 'public Order loaded; // assigned as self.loaded in __init__()');
  contains(out, 'Order current = this._require(1);');
  contains(out, 'Order other = this.repo.order(2);');
  contains(out, 'Order fresh = load("y");');
  contains(out, 'for (OrderLine line : this.lines) {');
  contains(out, 'String sku = entry.getKey();');
  contains(out, 'double price = entry.getValue();');
  contains(out, 'OrderLine line = this.lines.get(i);');
  contains(out, 'for (Order o : orders) {');
  contains(out, 'for (String k : this.prices.keySet()) {');
});

test('types: return hints are inherited from a base class in the same file', () => {
  const out = java(`
class Base:
    def make(self) -> Widget:
        return Widget()

class Child(Base):
    def use(self):
        w = self.make()
        return w
`);
  contains(out, 'Widget w = this.make();');
});

test('cross-file knowledge: properties and return types from other modules flow through knownMembers', () => {
  const known = {
    properties: { total: { trivial: false, boolean: false, setter: false } },
    attributes: [],
    returnTypes: { 'Repo.order': 'Order /* nullable */', 'load': 'Config' },
    fieldTypes: { 'Repo.count': 'int' },
  };
  const out = translateWithRules({
    source: `
class Service:
    def __init__(self, repo: Repo):
        self.repo = repo

    def run(self):
        order = self.repo.order(1)
        cfg = load()
        n = self.repo.count
        return order.total
`,
    relativePath: 'pkg/mod.py',
    knownMembers: known,
  }).java;
  contains(out, 'Order /* nullable */ order = this.repo.order(1);');
  contains(out, 'Config cfg = load();');
  contains(out, 'int n = this.repo.count;');
  contains(out, 'return order.total();');
});

test('cross-file knowledge: the project mirror scans every file first and leaves members.json for single-file runs', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pyrite-members-'));
  try {
    fs.mkdirSync(path.join(root, 'app'));
    fs.writeFileSync(path.join(root, 'app', 'repo.py'), 'class Repo:\n    def order(self, i: int) -> "Order":\n        return None\n\n    @property\n    def size(self) -> int:\n        return 0\n', 'utf8');
    fs.writeFileSync(path.join(root, 'app', 'service.py'), 'class Service:\n    def __init__(self, repo: Repo):\n        self.repo = repo\n\n    def run(self):\n        o = self.repo.order(1)\n        return self.repo.size\n', 'utf8');
    const { translator } = createTranslator({ engine: 'rules' });
    const { mirrorProject } = await import('../mirror');
    await mirrorProject(translator, { root });
    const view = () => fs.readFileSync(path.join(root, '.java-view', 'app', 'service.java'), 'utf8');
    contains(view(), 'Order o = this.repo.order(1);');
    contains(view(), 'return this.repo.size();');
    assert.ok(fs.existsSync(path.join(root, '.java-view', '.pyrite', 'maps', 'members.json')));

    // A later single-file translation (a save in the editor) still knows about the other module.
    fs.writeFileSync(path.join(root, 'app', 'service.py'), 'class Service:\n    def __init__(self, repo: Repo):\n        self.repo = repo\n\n    def run(self):\n        first = self.repo.order(2)\n        return first\n', 'utf8');
    await mirrorFile(translator, root, 'app/service.py');
    contains(view(), 'Order first = this.repo.order(2);');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('regression: comments inside a multi-line literal do not cut the statement short', () => {
  const out = java(`
CODEC_MAP = {
    "gb2312": "eucgb2312_cn",  # main
    # Hack: no conversion for these
    "big5": "big5_tw",
    "hash": "#notacomment",
}
FLAGS = [  # leading
    1,
    2,  # two
]
`);
  const unwrapped = translateWithRules({ source: out === '' ? '' : `
CODEC_MAP = {
    "gb2312": "eucgb2312_cn",  # main
    # Hack: no conversion for these
    "big5": "big5_tw",
    "hash": "#notacomment",
}
`, relativePath: 'pkg/mod.py', lineWidth: 0 }).java;
  contains(unwrapped, '// main\n    // Hack: no conversion for these\n    public static final Map<String, Object> CODEC_MAP = Map.of("gb2312", "eucgb2312_cn", "big5", "big5_tw", "hash", "#notacomment");');
  contains(out, '// leading\n    // two\n    public static final List<Object> FLAGS = List.of(1, 2);');
  assertBracesBalanced(out);
});

test('regression: a huge literal without a comprehension translates quickly', () => {
  const entries = Array.from({ length: 1500 }, (_, i) => `    'key_${i}': 'value_${i}',`).join('\n');
  const started = Date.now();
  const out = java(`TABLE = {\n${entries}\n}\n`);
  contains(out, 'public static final Map<String, Object> TABLE = Map.of(\n            "key_0", "value_0",\n            "key_1", "value_1",');
  assert.ok(Date.now() - started < 1500, `took ${Date.now() - started} ms`);
});

test('a file with a Python syntax error is still translated but flagged at the top', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pyrite-syntax-'));
  try {
    fs.mkdirSync(path.join(root, 'pkg'));
    fs.writeFileSync(path.join(root, 'pkg', 'bad.py'), 'def ok():\n    return 1\n\ndef broken(:\n    pass\n', 'utf8');
    const { translator } = createTranslator({ engine: 'rules' });
    const outcome = await mirrorFile(translator, root, 'pkg/bad.py');
    assert.equal(outcome.skipped, false);
    const view = fs.readFileSync(path.join(root, '.java-view', 'pkg', 'bad.java'), 'utf8');
    contains(view, '// WARNING: pkg/bad.py has Python syntax errors');
    contains(view, 'line 4,');
    contains(view, 'public static Object ok() {');
    assert.ok(outcome.result!.warnings.some((w) => /pkg\/bad\.py:4: Python syntax error/.test(w)), outcome.result!.warnings.join('\n'));
    // Symbols still point at the right (shifted) lines.
    const lines = view.split('\n');
    const ok = outcome.result!.symbols.find((s) => s.name === 'ok')!;
    assert.match(lines[ok.javaLine], /ok\(\)/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('regression: a multi-line triple-quoted f-string renders as text blocks, never a string with raw newlines', () => {
  const out = java(['def page(title, body):', '    return f"""<html>', '<h1>{title}</h1>', '{body}', '</html>"""', ''].join('\n'));
  contains(out, 'return """\n<html>\n<h1>""" + title + """\n</h1>\n""" + body + """\n</html>""";');
  for (const line of out.split('\n')) {
    // No line may hold an unterminated ordinary string literal.
    const stripped = line.replace(/"""/g, '').replace(/"(?:[^"\\]|\\.)*"/g, '');
    assert.ok(!stripped.includes('"'), `unterminated string on: ${line}`);
  }
});

test('regression: source map and symbol lines stay aligned after a multi-line text block', () => {
  const result = translateWithRules({
    source: ['BANNER = """', 'line one', 'line two', '"""', '', 'def after():', '    return 1', ''].join('\n'),
    relativePath: 'pkg/mod.py',
  });
  const lines = result.java.split('\n');
  assert.equal(result.sourceMap.length, lines.length, 'one source-map entry per physical line');
  const after = result.symbols.find((s) => s.name === 'after')!;
  assert.match(lines[after.javaLine], /public static Object after\(\)/);
  assert.equal(result.sourceMap[after.javaLine], 6);
  assert.equal(javaLineFor({ python: '', java: '', engine: 'rules', generatedAt: '', lines: result.sourceMap, symbols: [] }, 7), lines.findIndex((l) => l.includes('return 1;')));
});

test('regression: one-line compound statements open a block and chain with the next clause', () => {
  const out = java(`
def classify(o, xs):
    if o == "-n": kind = 1
    elif o == "-t": kind = 2
    else: kind = 0
    try: xs.check()
    except: pass
    for x in xs: kind += x
    while kind > 100: kind -= 1
    with lock: kind += 1
    return kind

def one(): return 1
class Empty: pass
if __name__ == "__main__": classify("-n", [])
`);
  contains(out, 'if (o == "-n") {\n            int kind = 1;\n        } else if (o == "-t") {\n            kind = 2;\n        } else {\n            kind = 0;\n        }');
  contains(out, 'try {\n            xs.check();\n        } catch (Exception e) {\n            // pass\n        }');
  contains(out, 'for (var x : xs) {\n            kind += x;\n        }');
  contains(out, 'while (kind > 100) {\n            kind -= 1;\n        }');
  contains(out, 'synchronized (lock) { // with\n            kind += 1;\n        }');
  contains(out, 'public static Object one() {\n        return 1;\n    }');
  contains(out, 'public static class Empty {\n        // pass\n    }');
  contains(out, 'public static void main(String[] args) {\n        classify("-n", new ArrayList<>());\n    }');
  assertBracesBalanced(out);
});

test('PEP 695 type parameters on classes and functions become Java type parameters', () => {
  const out = java(`
class Box[T](Protocol):
    def get(self) -> T:
        ...

class Pair[K, V: Comparable]:
    def __init__(self, key: K, value: V):
        self.key = key
        self.value = value

def first[T](items: list[T], /) -> T:
    return items[0]
`);
  contains(out, 'public interface Box<T> {');
  contains(out, 'public static class Pair<K, V extends Comparable> {');
  contains(out, 'public static <T> T first(List<T> items) {');
  contains(out, 'T get();');
});

// ------------------------------------------------------------------ line width

function maxLineLength(out: string): number {
  return Math.max(...out.split('\n').map((l) => l.length));
}

test('layout: a signature that does not fit puts one parameter per line with an 8-space continuation', () => {
  const result = translateWithRules({
    source: `
class Job:
    def configure(self, reader: ItemReader, processor: ItemProcessor, writer: ItemWriter, chunk_size: int = 10, skip_limit: int = 3, retry_limit: int = 2, name: str = "job"):
        pass

    def short(self, a: int, b: int) -> int:
        return a + b
`,
    relativePath: 'pkg/mod.py',
  });
  const out = result.java;
  contains(
    out,
    [
      '        public void configure(',
      '                ItemReader reader,',
      '                ItemProcessor processor,',
      '                ItemWriter writer,',
      '                int chunk_size /* = 10 */,',
      '                int skip_limit /* = 3 */,',
      '                int retry_limit /* = 2 */,',
      '                String name /* = "job" */) {',
      '            // pass',
    ].join('\n'),
  );
  // A signature that fits stays on one line.
  contains(out, '        public int short(int a, int b) {');
  assert.ok(maxLineLength(out) <= 120);
  // Go to Definition and the source map still point at the declaration.
  const lines = out.split('\n');
  const configure = result.symbols.find((s) => s.name === 'configure')!;
  assert.match(lines[configure.javaLine], /public void configure\($/);
  assert.equal(result.sourceMap.length, lines.length);
  assert.equal(result.sourceMap[lines.indexOf('                ItemWriter writer,')], 3);
});

test('layout: calls chop down, a single call argument hugs, Map.of keeps pairs together', () => {
  const out = java(`
def build(repo, product, quantity, customer):
    repo.save(Order(customer=customer, product=product, quantity=quantity, unit_price=product.price, note="created by the nightly import job"))
    return {"orders": repo.count_orders_for(customer), "revenue": repo.revenue_for(customer), "average": repo.average_for(customer)}
`);
  contains(
    out,
    [
      '        repo.save(new Order(',
      '                /* customer = */ customer,',
      '                /* product = */ product,',
      '                /* quantity = */ quantity,',
      '                /* unit_price = */ product.price,',
      '                /* note = */ "created by the nightly import job"));',
    ].join('\n'),
  );
  contains(
    out,
    [
      '        return Map.of(',
      '                "orders", repo.count_orders_for(customer),',
      '                "revenue", repo.revenue_for(customer),',
      '                "average", repo.average_for(customer));',
    ].join('\n'),
  );
  assert.ok(maxLineLength(out) <= 120);
});

test('layout: conditions break before && and ||, concatenation before +, chains before each call', () => {
  const out = java(`
def check(order, customer, items):
    if order.status == "NEW" and customer.is_active_member_of_the_loyalty_program and len(items) < MAXIMUM_ITEMS_PER_ORDER:
        raise ValueError("order " + str(order.id) + " for customer " + customer.name + " cannot be placed because the basket is too big")
    return [line.product.sku.upper() for line in order.lines if line.quantity > 0 and line.product.sku is not None and line.product.active]
`);
  contains(
    out,
    [
      '        if (order.status == "NEW"',
      '                && customer.is_active_member_of_the_loyalty_program',
      '                && items.size() < MAXIMUM_ITEMS_PER_ORDER) {',
    ].join('\n'),
  );
  contains(out, '            throw new IllegalArgumentException(\n                    "order " + String.valueOf(order.id)');
  // The chain breaks before each call that follows a call; `order.lines.stream()` stays together.
  contains(out, '        return order.lines.stream()\n                .filter(line -> line.quantity > 0 && line.product.sku != null && line.product.active)\n                .map(');
  assert.ok(maxLineLength(out) <= 120, out);
});

test('layout: a trailing comment that makes a line too long moves above it, or into the block it opens', () => {
  const result = translateWithRules({
    source: `
class Account:
    def __init__(self, owner):
        self.owner_display_name_for_statements_and_reports = owner.first_name + owner.last_name  # shown on every monthly statement
`,
    relativePath: 'pkg/mod.py',
  });
  const out = result.java;
  contains(out, '            // shown on every monthly statement\n            this.owner_display_name_for_statements_and_reports = owner.first_name + owner.last_name;');
  const lines = out.split('\n');
  const field = result.symbols.find((s) => s.name === 'owner_display_name_for_statements_and_reports')!;
  assert.match(lines[field.javaLine], /public Object owner_display_name_for_statements_and_reports;|owner_display_name_for_statements_and_reports; \/\//);
  assert.ok(maxLineLength(out) <= 120, out);
});

test('layout: strings, comments and generics are never split, and long string literals are left alone', () => {
  const longText = 'x'.repeat(130);
  const out = java(`
def f(mapping: Dict[str, List[int]], other: Dict[str, List[int]], third: Dict[str, List[int]], fourth: Dict[str, int]):
    print("a, b, c // not a comment", mapping, other, third, fourth, "and some more text to overflow the line")
    message = "${longText}"
`);
  contains(out, '    public static void f(\n            Map<String, List<Integer>> mapping,\n            Map<String, List<Integer>> other,');
  contains(out, '"a, b, c // not a comment",');
  contains(out, `String message = "${longText}";`);
});

test('layout: Javadoc and comment prose re-flow to the width; a single overlong word is kept whole', () => {
  const doc = 'This method reconciles every open order against the warehouse stock levels and reports each mismatch it finds along the way to the audit log.';
  const url = `https://example.com/${'a'.repeat(120)}`;
  const out = java(['def reconcile():', `    """${doc}`, '', `    See ${url}`, '    """', '    # a plain comment that is also far too long to fit on one line of the generated Java view, so it has to be re-flowed onto a second line', '    pass', ''].join('\n'));
  contains(out, '     * This method reconciles every open order against the warehouse stock levels and reports each mismatch it finds\n     * along the way to the audit log.');
  contains(out, `     * See\n     * ${url}`);
  contains(out, '        // a plain comment that is also far too long to fit on one line of the generated Java view, so it has to be\n        // re-flowed onto a second line');
});

test('layout: lineWidth 0 turns wrapping off, and a narrower width is honoured', () => {
  const source = 'def f(alpha_value, beta_value, gamma_value, delta_value, epsilon_value, zeta_value, eta_value, theta_value):\n    pass\n';
  const off = translateWithRules({ source, relativePath: 'pkg/mod.py', lineWidth: 0 }).java;
  contains(off, 'public static void f(Object alpha_value, Object beta_value, Object gamma_value, Object delta_value, Object epsilon_value, Object zeta_value, Object eta_value, Object theta_value) {');
  const narrow = translateWithRules({ source: 'def f(alpha_value, beta_value, gamma_value):\n    pass\n', relativePath: 'pkg/mod.py', lineWidth: 60 }).java;
  contains(narrow, '    public static void f(\n            Object alpha_value,\n            Object beta_value,\n            Object gamma_value) {');
  // The fixed two-line file header is not wrapped; everything in the class body is.
  assert.ok(maxLineLength(narrow.slice(narrow.indexOf('public final class'))) <= 60, narrow);
});

test('Python adjacent string literals are joined with +', () => {
  assert.equal(translateExpression('"a " "b" \'c\''), '"a " + "b" + "c"');
  const out = java('raise ValueError("first part of the message " "second part")\n');
  contains(out, 'throw new IllegalArgumentException("first part of the message " + "second part");');
});

test('each sidecar map records how its translation went, for the status bar report', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pyrite-status-'));
  try {
    fs.mkdirSync(path.join(root, 'pkg'));
    fs.writeFileSync(path.join(root, 'pkg', 'ok.py'), 'class A:\n    def f(self):\n        return 1\n', 'utf8');
    fs.writeFileSync(path.join(root, 'pkg', 'bad.py'), 'def broken(:\n    pass\n', 'utf8');
    const { translator } = createTranslator({ engine: 'rules' });
    const readMap = (name: string) => JSON.parse(fs.readFileSync(path.join(root, '.java-view', '.pyrite', 'maps', 'pkg', `${name}.java.json`), 'utf8'));

    await mirrorFile(translator, root, 'pkg/ok.py');
    assert.equal(readMap('ok').status, 'ok');
    assert.equal(readMap('ok').warnings, 0);

    await mirrorFile(translator, root, 'pkg/bad.py');
    assert.equal(readMap('bad').status, 'syntax');
    assert.ok(readMap('bad').warnings >= 1);

    const broken: Translator = { name: 'rules', translate: async () => { throw new Error('boom'); } };
    await assert.rejects(mirrorFile(broken, root, 'pkg/ok.py'));
    assert.equal(readMap('ok').status, 'failed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
