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
import { FAILURE_MARKER, globToRegExp, isExcluded, isPackageMarkerOnly, javaLineFor, javaPathFor, mirrorFile, mirrorProject, projectBasePackage, pythonLineFor, removeMirroredFile, removeMirroredFolder } from '../mirror';
import { Translator, basePackageFor, createTranslator, moduleClassName, packageFromPath } from '../translator';

/** Absolute path in the main source root of the view of a project at `root` (package = its folder name). */
function mainView(root: string, ...parts: string[]): string {
  return path.join(root, '.java-view', 'src', 'main', 'java', ...projectBasePackage(root).split('.'), ...parts);
}

/** Same, for the sidecar map of a view in the main source root. */
function mainMap(root: string, ...parts: string[]): string {
  return path.join(root, '.java-view', '.pyrite', 'maps', 'src', 'main', 'java', ...projectBasePackage(root).split('.'), ...parts);
}

function java(source: string, relativePath = 'pkg/mod.py'): string {
  return translateWithRules({ source, relativePath }).java;
}

/** The view with Python's imports kept as Java-looking lines (`resolveImports: false`). */
function pythonImportsView(source: string, relativePath = 'pkg/mod.py'): string {
  return translateWithRules({ source, relativePath, pythonImports: true }).java;
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
  const out = pythonImportsView(
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

  // `class Repo` in repo.py is the module's class itself: Java forbids a nested Repo inside Repo.
  const classes = byName('Repo').filter((s) => s.kind === 'class');
  assert.equal(classes.length, 1, 'one Repo class, not a module class plus a nested one');
  assert.deepEqual(classes[0].container, []);
  assert.equal(classes[0].pythonClass, true);
  assert.equal(lines[classes[0].javaLine], 'public class Repo {');
  const fetch = byName('fetch')[0];
  assert.deepEqual(fetch.container, ['Repo']);
  assert.match(lines[fetch.javaLine], /^ {4}public \w+ fetch\(/, 'members are one level in');

  const ctor = byName('Repo').find((s) => s.kind === 'method');
  assert.ok(ctor, 'constructor should be recorded as a method named after the class');
  assert.deepEqual(ctor!.container, ['Repo']);

  const field = byName('url').find((s) => s.kind === 'field');
  assert.ok(field, 'field url should be recorded');
  assert.deepEqual(field!.container, ['Repo']);
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
  contains(out, 'while (!Py.truthy(done)) {');
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
    const javaAbs = mainView(root, 'pkg', 'PkgInit.java');
    assert.ok(fs.existsSync(javaAbs));
    contains(fs.readFileSync(javaAbs, 'utf8'), 'public final class PkgInit {');
    // Leftovers from the names and the flat layout earlier versions used are cleaned up too.
    const legacy = ['__init__.java', 'Pkg.java', 'PkgPackage.java', 'pkgInit.java', 'PkgInit.java'].map((n) => path.join(root, '.java-view', 'pkg', n));
    fs.mkdirSync(path.join(root, '.java-view', 'pkg'), { recursive: true });
    for (const abs of legacy) fs.writeFileSync(abs, '// stale', 'utf8');
    await mirrorFile(translator, root, 'pkg/__init__.py');
    for (const abs of legacy) assert.equal(fs.existsSync(abs), false, `legacy ${path.basename(abs)} should be removed`);
    assert.equal(fs.existsSync(path.join(root, '.java-view', 'pkg')), false, 'the emptied legacy folder is removed');
    assert.ok(fs.existsSync(javaAbs), 'the current view must survive the cleanup');

    fs.writeFileSync(init, '\"\"\"Just a package.\"\"\"\n', 'utf8');
    const second = await mirrorFile(translator, root, 'pkg/__init__.py');
    assert.equal(second.skipped, true);
    assert.equal(fs.existsSync(javaAbs), false, 'stale Java view should be removed');
    assert.equal(fs.existsSync(mainMap(root, 'pkg', 'PkgInit.java.json')), false, 'stale map should be removed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('package module: named after its folder, Javadoc names the original __init__.py', () => {
  assert.equal(moduleClassName('app/inventory/__init__.py'), 'InventoryInit');
  assert.equal(moduleClassName('app/order_service.py'), 'OrderService');
  assert.equal(moduleClassName('__init__.py'), 'Init');
  // A view file is named after its public class, as javac requires.
  assert.equal(javaPathFor('app/inventory/__init__.py', 'shop'), 'src/main/java/shop/app/inventory/InventoryInit.java');
  assert.equal(javaPathFor('app/order_items/__init__.py', 'shop'), 'src/main/java/shop/app/order_items/OrderItemsInit.java');
  assert.equal(moduleClassName('app/order_items/__init__.py'), 'OrderItemsInit');
  assert.equal(javaPathFor('app/order_service.py', 'shop'), 'src/main/java/shop/app/OrderService.java');
  // The Init suffix keeps the package module apart from a sibling module of the same name.
  assert.notEqual(
    javaPathFor('app/inventory/__init__.py', 'shop').toLowerCase(),
    javaPathFor('app/inventory/inventory.py', 'shop').toLowerCase(),
  );

  const src = '\"\"\"Inventory domain package.\"\"\"\n__version__ = "0.1.0"\n';
  const withDoc = java(src, 'app/inventory/__init__.py');
  contains(withDoc, 'public final class InventoryInit {');
  contains(withDoc, ' * Inventory domain package.');
  contains(withDoc, " * Translated from {@code app/inventory/__init__.py}, the {@code inventory} package's __init__ module.");
  assert.ok(!withDoc.includes('InventoryPackage'));

  // Without a docstring in docstringOnly mode there is no Javadoc, so the origin goes in a plain comment.
  const noDoc = java('__version__ = "0.1.0"\n', 'app/inventory/__init__.py');
  contains(noDoc, "// Translated from app/inventory/__init__.py, the package's __init__ module.\npublic final class InventoryInit {");
  const none = translateWithRules({ source: src, relativePath: 'app/inventory/__init__.py', javadocMode: 'none' }).java;
  contains(none, "// Translated from app/inventory/__init__.py, the package's __init__ module.\npublic final class InventoryInit {");
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
  contains(out, 'public Bag(Object[] items, Map<String, Object> options /* **kwargs */) {');
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
    const javaAbs = mainView(root, 'pkg', 'Mod.java');
    contains(fs.readFileSync(javaAbs, 'utf8'), 'static int x = 1;');

    const broken: Translator = { name: 'rules', translate: async () => { throw new Error('boom on line 3'); } };
    await assert.rejects(mirrorFile(broken, root, 'pkg/mod.py'), /boom on line 3/);
    const view = fs.readFileSync(javaAbs, 'utf8');
    contains(view, FAILURE_MARKER);
    contains(view, 'boom on line 3');
    contains(view, `package ${projectBasePackage(root)}.pkg;`);
    contains(view, 'public final class Mod {');
    assert.ok(!view.includes('static int x = 1;'), 'the stale code must be gone');
    const map = JSON.parse(fs.readFileSync(mainMap(root, 'pkg', 'Mod.java.json'), 'utf8'));
    assert.deepEqual(map.symbols, []);
    assert.deepEqual(map.lines, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('package names: the project name, then the Python folders, made valid for Java', () => {
  assert.equal(basePackageFor('sample-python-project'), 'sample_python_project');
  assert.equal(basePackageFor('My Shop'), 'my_shop');
  assert.equal(basePackageFor('com.Acme.shop'), 'com.acme.shop');
  assert.equal(basePackageFor('2fa'), '_2fa');
  assert.equal(packageFromPath('app/services/x.py', 'shop'), 'shop.app.services');
  assert.equal(packageFromPath('x.py', 'shop'), 'shop');
  assert.equal(packageFromPath('app/static/x.py', 'shop'), 'shop.app.static_', 'a Java keyword is not a package segment');
  assert.equal(projectBasePackage('/work/Order-Service'), 'order_service');
  assert.equal(projectBasePackage('/work/Order-Service', ' com.acme '), 'com.acme', 'a configured base package wins');
  assert.equal(projectBasePackage('/work/Order-Service', ''), 'order_service', 'blank means the folder name');
});

test('test modules go to src/test/java, the rest to src/main/java', () => {
  assert.equal(javaPathFor('app/models.py', 'shop'), 'src/main/java/shop/app/Models.java');
  assert.equal(javaPathFor('main.py', 'shop'), 'src/main/java/shop/Main.java');
  assert.equal(javaPathFor('tests/test_models.py', 'shop'), 'src/test/java/shop/tests/TestModels.java');
  assert.equal(javaPathFor('app/models_test.py', 'shop'), 'src/test/java/shop/app/ModelsTest.java');
  assert.equal(javaPathFor('conftest.py', 'shop'), 'src/test/java/shop/Conftest.java');
  assert.equal(javaPathFor('tests/helpers.py', 'com.acme'), 'src/test/java/com/acme/tests/Helpers.java');
});

test('the package line and the imports of project modules start with the base package', () => {
  const source = 'import os\nfrom typing import List\nfrom .models import Order\nfrom ..util import fmt\nfrom app.repo import Repo\nimport app.db as db\n';
  const knownMembers = { properties: {}, attributes: [], returnTypes: {}, fieldTypes: {}, modules: { 'app.repo': 'shop.app.Repo', 'app.db': 'shop.app.Db' } };
  const out = translateWithRules({ source, relativePath: 'app/services/x.py', basePackage: 'shop', knownMembers, pythonImports: true }).java;
  contains(out, 'package shop.app.services;');
  contains(out, 'import shop.app.services.models.Order;');
  contains(out, 'import shop.app.util.fmt;');
  contains(out, 'import shop.app.repo.Repo;');
  contains(out, 'import shop.app.db; // as db');
  // Modules from outside the project are left alone.
  contains(out, 'import os;');
  contains(out, 'import typing.List;');
  // Without a base package nothing changes.
  contains(translateWithRules({ source, relativePath: 'app/services/x.py', knownMembers, pythonImports: true }).java, 'import app.services.models.Order;');
});

test('mirrorProject writes a standard Java project layout under the project name', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pyrite-layout-'));
  const root = path.join(tmp, 'my-shop');
  try {
    fs.mkdirSync(path.join(root, 'app'), { recursive: true });
    fs.mkdirSync(path.join(root, 'tests'));
    fs.writeFileSync(path.join(root, 'app', 'models.py'), 'class Order:\n    pass\n', 'utf8');
    fs.writeFileSync(path.join(root, 'tests', 'test_models.py'), 'def test_order():\n    assert True\n', 'utf8');
    const { translator } = createTranslator({ engine: 'rules' });
    await mirrorProject(translator, { root });
    const out = path.join(root, '.java-view');
    const main = path.join(out, 'src', 'main', 'java', 'my_shop', 'app', 'Models.java');
    const testView = path.join(out, 'src', 'test', 'java', 'my_shop', 'tests', 'TestModels.java');
    contains(fs.readFileSync(main, 'utf8'), 'package my_shop.app;');
    contains(fs.readFileSync(testView, 'utf8'), 'package my_shop.tests;');
    assert.ok(fs.existsSync(path.join(out, '.pyrite', 'maps', 'src', 'test', 'java', 'my_shop', 'tests', 'TestModels.java.json')));

    // A deleted module takes its view, its map and the folders it leaves empty with it.
    removeMirroredFile(root, 'tests/test_models.py');
    assert.equal(fs.existsSync(path.join(out, 'src', 'test')), false);
    assert.ok(fs.existsSync(main));

    // With a configured base package, the layout follows it.
    await mirrorProject(translator, { root, basePackage: 'com.acme.shop' });
    contains(fs.readFileSync(path.join(out, 'src', 'main', 'java', 'com', 'acme', 'shop', 'app', 'Models.java'), 'utf8'), 'package com.acme.shop.app;');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('removeMirroredFolder clears a folder from both source roots', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pyrite-rmboth-'));
  const root = path.join(tmp, 'proj');
  try {
    fs.mkdirSync(path.join(root, 'app'), { recursive: true });
    fs.writeFileSync(path.join(root, 'app', 'a.py'), 'x = 1\n', 'utf8');
    fs.writeFileSync(path.join(root, 'app', 'test_a.py'), 'y = 2\n', 'utf8');
    const { translator } = createTranslator({ engine: 'rules' });
    await mirrorFile(translator, root, 'app/a.py');
    await mirrorFile(translator, root, 'app/test_a.py');
    const out = path.join(root, '.java-view');
    assert.ok(fs.existsSync(path.join(out, 'src', 'test', 'java', 'proj', 'app', 'TestA.java')));
    removeMirroredFolder(root, 'app');
    for (const sourceRoot of ['main', 'test']) {
      assert.equal(fs.existsSync(path.join(out, 'src', sourceRoot, 'java', 'proj', 'app')), false);
      assert.equal(fs.existsSync(path.join(out, '.pyrite', 'maps', 'src', sourceRoot, 'java', 'proj', 'app')), false);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
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
    assert.equal(fs.existsSync(mainView(root, 'app', 'old')), false);
    assert.equal(fs.existsSync(mainMap(root, 'app', 'old')), false);
    assert.ok(fs.existsSync(mainView(root, 'app', 'Keep.java')));
    // Guard rails: never wipe the output root or escape it.
    removeMirroredFolder(root, '');
    removeMirroredFolder(root, '../elsewhere');
    assert.ok(fs.existsSync(mainView(root, 'app', 'Keep.java')));
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
  contains(out, 'if (Py.truthy(note) || Py.truthy(buffer)) {');
  contains(out, 'return Objects.requireNonNullElse(note, buffer);');
  contains(out, 'return note == null || buffer;');
});

test('builtins: file APIs pull in java.io', () => {
  const out = pythonImportsView(`
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
    const view = () => fs.readFileSync(mainView(root, 'app', 'Service.java'), 'utf8');
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
    const view = fs.readFileSync(mainView(root, 'pkg', 'Bad.java'), 'utf8');
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
  // `kind` is used after the chain, so it is declared before it (a Java local lives in its block).
  contains(out, 'int kind = 0;\n        if (o == "-n") {\n            kind = 1;\n        } else if (o == "-t") {\n            kind = 2;\n        } else {\n            kind = 0;\n        }');
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
  contains(out, '        public int short_(int a, int b) {');
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
    const readMap = (name: string) => JSON.parse(fs.readFileSync(mainMap(root, 'pkg', `${name}.java.json`), 'utf8'));

    await mirrorFile(translator, root, 'pkg/ok.py');
    assert.equal(readMap('Ok').status, 'ok');
    assert.equal(readMap('Ok').warnings, 0);

    await mirrorFile(translator, root, 'pkg/bad.py');
    assert.equal(readMap('Bad').status, 'syntax');
    assert.ok(readMap('Bad').warnings >= 1);

    const broken: Translator = { name: 'rules', translate: async () => { throw new Error('boom'); } };
    await assert.rejects(mirrorFile(broken, root, 'pkg/ok.py'));
    assert.equal(readMap('Ok').status, 'failed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a class named like its module becomes the module class, keeping its header, annotations and members', () => {
  const result = translateWithRules({
    source: `from dataclasses import dataclass

LIMIT = 3


@dataclass
class Point(Shape):
    """A point."""
    x: int

    def norm(self) -> float:
        return self.x


ORIGIN = Point(0)
`,
    relativePath: 'app/point.py',
    lombokStyle: true,
  });
  const lines = result.java.split('\n');
  assert.equal(lines.length, result.sourceMap.length);
  contains(result.java, '/** A point. */\n@Data\npublic class Point extends Shape {\n    public static final int LIMIT = 3;');
  contains(result.java, '\n    public int x;');
  contains(result.java, '\n    public static final Point ORIGIN = new Point(0);\n}');
  assert.doesNotMatch(result.java, /class Point \{|static class Point/);
  for (const s of result.symbols) assert.ok(lines[s.javaLine].includes(s.name), `${s.name} -> ${lines[s.javaLine]}`);
  assert.equal(result.sourceMap[lines.indexOf('public class Point extends Shape {')], 7);
});

test('an enum named like its module comes first, and its constants end with ";" before other members', () => {
  const out = java('from enum import Enum\n\nDEFAULT = "new"\n\nclass Status(Enum):\n    NEW = 1\n    DONE = 2\n\ndef parse(s):\n    return s\n', 'app/status.py');
  contains(out, 'public enum Status {\n    NEW(1),\n    DONE(2);\n\n    public static final String DEFAULT = "new";');
  const nested = java('from enum import Enum\nclass S(Enum):\n    A = 1\n\n    def f(self):\n        return 1\nclass T(Enum):\n    C = 1\n', 'app/x.py');
  contains(nested, '        A(1);\n');
  contains(nested, '        C(1),\n    }');
});

test('a view left under the old file name is removed when the module is regenerated', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pyrite-rename-'));
  try {
    fs.mkdirSync(path.join(root, 'app'));
    fs.writeFileSync(path.join(root, 'app', 'order_service.py'), 'X = 1\n', 'utf8');
    const old = ['order_service.java', '.pyrite/maps/app/order_service.java.json'].map((r) => path.join(root, '.java-view', ...(r.startsWith('.pyrite') ? [r] : ['app', r])));
    for (const abs of old) {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, '// stale', 'utf8');
    }
    await mirrorFile(createTranslator({ engine: 'rules' }).translator, root, 'app/order_service.py');
    for (const abs of old) assert.equal(fs.existsSync(abs), false, `${abs} should be removed`);
    assert.ok(fs.existsSync(mainView(root, 'app', 'OrderService.java')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('nullable primitives: Optional hints box the primitive', () => {
  assert.equal(translateType('Optional[int]'), 'Integer /* nullable */');
  assert.equal(translateType('float | None'), 'Double /* nullable */');
  assert.equal(translateType('Union[bool, None]'), 'Boolean /* nullable */');
  assert.equal(translateType('Optional[str]'), 'String /* nullable */');
});

test('nullable primitives: parameters, returns and locals the code flow sets to None are boxed', () => {
  const out = java(`
def find(key: str, default: int = None) -> int:
    if key == "x":
        return None
    return 3

def scan(limit: int, flag: bool) -> float:
    if limit is None:
        limit = 10
    found = None
    for i in range(limit):
        found = 0
    n = 0
    if flag:
        n = None
    k = 5
    total: int = None
    return 1.0
`);
  contains(out, 'public static Integer /* nullable */ find(String key, Integer /* nullable */ default_ /* = null */)');
  contains(out, 'public static double scan(Integer /* nullable */ limit, boolean flag)');
  contains(out, 'Integer /* nullable */ found = null;');
  contains(out, 'Integer /* nullable */ n = 0;');
  contains(out, 'int k = 5;');
  contains(out, 'Integer /* nullable */ total = null;');
});

test('nullable primitives: fields set to or checked against None are boxed', () => {
  const out = java(`
class Counter:
    limit: float = None

    def __init__(self, start: int):
        self.count = start
        self.best = 0
        self.ratio = 1.5

    def reset(self):
        self.count = None

    def has_best(self) -> bool:
        return self.best is not None
`);
  contains(out, 'public Integer /* nullable */ count;');
  contains(out, 'public Integer /* nullable */ best;');
  contains(out, 'public double ratio;');
  contains(out, 'Double /* nullable */ limit = null;');
  contains(out, 'public boolean has_best()');
});

test('nullable primitives: a nested function does not leak its None flow into the outer one', () => {
  const out = java(`
def outer() -> int:
    n = 1
    def inner():
        n = None
        return None
    return n
`);
  contains(out, 'public static int outer()');
  contains(out, 'int n = 1;');
});

test('compilable 1.7: a trailing comma in a call is dropped, a one-element tuple stays a tuple', () => {
  const out = java(`
def f(a, b):
    g(a, b, )
    t = (a,)
`);
  contains(out, 'g(a, b);');
  contains(out, 'Tuple t = Tuple.of(a);');
});

test('compilable 1.8: Python names that are Java reserved words are renamed everywhere', () => {
  const out = java(`
import enum
from dataclasses import dataclass, field

@dataclass
class Item:
    count: int = field(default=3)

def short(new, char="x"):
    default = new + 1
    abstract = default
    return abstract

class Color(enum.Enum):
    RED = enum.auto()
`);
  contains(out, 'public static Object short_(Object new_, String char_ /* = "x" */)');
  contains(out, 'var default_ = new_ + 1;');
  contains(out, 'return abstract_;');
  // keyword arguments the translator reads, and imported module names, are left alone
  contains(out, 'public int count = 3;');
  contains(out, '// python: import enum');
  contains(out, 'RED(enum.auto()),');
});

test('compilable 1.9: `_` is renamed, and `for _ in range` gets a counter name that is free', () => {
  const out = java(`
def f(n, pair):
    for _ in range(n):
        for _ in range(2):
            work()
    for _ in range(3):
        print(_)
    a, _ = pair
    match n:
        case _:
            pass
`);
  contains(out, 'for (int i = 0; i < n; i++) {');
  contains(out, 'for (int j = 0; j < 2; j++) {');
  contains(out, 'for (int unused = 0; unused < 3; unused++) {');
  contains(out, 'System.out.println(unused);');
  contains(out, 'var a = pair.get(0);');
  assert.ok(!out.includes('pair.get(1)'), 'the `_` target is skipped');
  contains(out, 'default -> {');
});

test('compilable 1.10: chained comparisons become && chains', () => {
  const out = java(`
def f(a, xs, n):
    if 0 <= a < 10:
        pass
    ok = not 0 < n < 10
    pick = [x for x in xs if 1 < x <= 5]
    s = n << 2 >> 1
    return a < g(1) <= 3
`);
  contains(out, 'if (0 <= a && a < 10) {');
  contains(out, 'var ok = !(0 < n && n < 10);');
  contains(out, '.filter(x -> 1 < x && x <= 5)');
  contains(out, 'var s = n << 2 >> 1;');
  contains(out, 'return a < g(1) && g(1) <= 3;');
});

test('compilable 1.15: integer literals are sized to int, long or BigInteger; literal powers are folded', () => {
  const out = java(`
SMALL = 2**10
BIG_LONG = -3000000000
MASK = 0xFFFFFFFFFFFFFFFF
HUGE = 18446744073709551615
POW = 2**64
OCT = 0o17
`);
  contains(out, 'public static final int SMALL = 1024;');
  contains(out, 'public static final long BIG_LONG = -3000000000L;');
  contains(out, 'public static final long MASK = 0xFFFFFFFFFFFFFFFFL;');
  contains(out, 'public static final BigInteger HUGE = new BigInteger("18446744073709551615");');
  contains(out, 'public static final BigInteger POW = new BigInteger("18446744073709551616");');
  contains(out, 'public static final int OCT = 15;');
});

test('compilable 1.20: more Python exceptions map to Java ones, and a multi-catch never repeats a type', () => {
  const out = java(`
def f():
    try:
        work()
    except (ValueError, TypeError) as e:
        raise AttributeError("x") from e
    except LookupError:
        pass
    except UnicodeDecodeError:
        pass
    except ImportError:
        pass
`);
  contains(out, '} catch (IllegalArgumentException e) {');
  contains(out, 'throw new IllegalStateException("x"); // caused by e');
  contains(out, '} catch (NoSuchElementException ignored) {');
  contains(out, '} catch (CharacterCodingException ignored) {');
  contains(out, '} catch (NoClassDefFoundError ignored) {');
});

test('tuples: tuple literals become Tuple.of, except call arguments, format operands and `in` collections', () => {
  const out = java(`
VERSION = (3, 1, 0, "alpha", 2)
EMPTY = ()

def f(a, b, xs, o):
    q = 1, 2
    if isinstance(o, (int, str)):
        pass
    if a in (1, 2, 3):
        pass
    for x in (a, b):
        pass
    msg = "%s and %s" % (a, b)
    pairs = [(x, x * 2) for x in xs]
    g((a, b), c=(1, 2))
    return (a, b)
`);
  contains(out, 'public static final Tuple VERSION = Tuple.of(3, 1, 0, "alpha", 2);');
  contains(out, 'public static final Tuple EMPTY = Tuple.of();');
  contains(out, 'Tuple q = Tuple.of(1, 2);');
  contains(out, 'if ((o instanceof Integer || o instanceof String)) {');
  contains(out, 'if (List.of(1, 2, 3).contains(a)) {');
  contains(out, 'for (var x : List.of(a, b)) {');
  contains(out, 'var msg = String.format("%s and %s", a, b);');
  contains(out, '.map(x -> Tuple.of(x, x * 2))');
  contains(out, 'g(Tuple.of(a, b), /* c = */ Tuple.of(1, 2));');
  contains(out, 'return Tuple.of(a, b);');
});

test('tuples: unpacking becomes one statement per name; swaps and calls go through a temporary', () => {
  const out = java(`
def f(pair, xs, d, o):
    a, b = pair
    a, b = b, a
    first, *rest = xs
    *init, last = xs
    v, _, w = o.split(".")
    d["k"], c = compute()
    (s, t) = [1, 2]
`);
  contains(out, 'var a = pair.get(0);\n        var b = pair.get(1);');
  contains(out, 'var tuple = Tuple.of(b, a); // tuple unpacking\n        a = tuple.get(0);\n        b = tuple.get(1);');
  contains(out, 'var rest = xs.subList(1, xs.size());');
  contains(out, 'var init = xs.subList(0, xs.size() - 1);');
  contains(out, 'var last = xs.get(xs.size() - 1);');
  contains(out, 'var tuple2 = o.split("."); // tuple unpacking\n        var v = tuple2.get(0);\n        var w = tuple2.get(2);');
  contains(out, 'd.put("k", tuple3.get(0));');
  contains(out, 'var s = 1;\n        var t = 2;');
});

test('tuples: loops unpack at the top of the body, and the names are scoped to the loop', () => {
  const out = java(`
def f(xs):
    for k, v in xs:
        print(k)
    for k, v in xs:
        for m, n in v:
            pass
`);
  contains(out, 'for (var item : xs) { // tuple unpacking\n            var k = item.get(0);\n            var v = item.get(1);');
  contains(out, 'for (var item2 : xs) { // tuple unpacking\n            var k = item2.get(0);');
  contains(out, 'for (var item3 : v) { // tuple unpacking\n                var m = item3.get(0);');
});

test('tuples: module and class level unpacking declares one field per name; unpacked self fields are declared', () => {
  const out = java(`
A, B = 1, 2
X, Y = divmod(7, 2)

class P:
    def __init__(self, pair):
        self.x, self.y = pair
`);
  contains(out, 'public static final int A = 1;');
  contains(out, 'public static final int B = 2;');
  contains(out, 'static Object tuple = Tuple.of(Math.floorDiv(7, 2), Math.floorMod(7, 2)); // tuple unpacking');
  contains(out, 'public static final Object X = tuple.get(0);');
  contains(out, 'public Object x; // assigned as self.x in __init__()');
  contains(out, 'this.y = pair.get(1);');
});

test('static blocks: module-level statements run in a static initializer, in Python order', () => {
  const out = java(`
REGISTRY = {}
COUNT = 0

try:
    import zstd
    HAS_ZSTD = True
except ImportError:
    HAS_ZSTD = False

REGISTRY["a"] = 1
COUNT += 1

def helper():
    return COUNT

Iterator.register(helper)
LIMIT = 10
`);
  // a field the static block assigns again is not final
  contains(out, '    public static int COUNT = 0;\n');
  contains(out, '    public static final Map<String, Object> REGISTRY = new HashMap<>();');
  // a name first assigned inside the block is declared just before it
  contains(out, '    static boolean HAS_ZSTD;\n    static {\n        try {\n            HAS_ZSTD = true;');
  contains(out, '        REGISTRY.put("a", 1);\n        COUNT += 1;\n    }\n\n    public static Object helper() {');
  contains(out, '    static {\n        Iterator.register(helper);\n    }\n    public static final int LIMIT = 10;');
});

test('static blocks: class bodies get one too, enums and interfaces do not', () => {
  const out = java(`
from enum import Enum

class Box:
    size = 3
    for _i in range(2):
        size += 1
    label = "box"

class Color(Enum):
    RED = 1
    GREEN = 2
`);
  contains(out, '        public static int size = 3;\n        static {\n            for (int _i = 0; _i < 2; _i++) {\n                size += 1;\n            }\n        }\n        public static String label = "box";');
  contains(out, 'RED(1),');
  assert.ok(!/enum Color[\s\S]*static \{/.test(out), 'no static block in the enum');
});

test('loop-else: a flag the loop sets when it breaks; nested loops keep their own breaks', () => {
  const out = java(`
def find(xs, target):
    for x in xs:
        for y in x:
            if y: break
        if x == target:
            break
    else:
        return None
    while cond():
        if done(): break
    else:
        cleanup()
`);
  contains(out, '        boolean broke = false;\n        for (var x : xs) {');
  contains(out, '                if (Py.truthy(y)) {\n                    break;\n');
  contains(out, '                broke = true;\n                break;\n            }\n        }\n        if (!broke) { // loop-else: runs when the loop did not break\n            return null;\n        }');
  contains(out, '        boolean broke2 = false;\n        while (');
  contains(out, '        if (!broke2) { // loop-else: runs when the loop did not break\n            cleanup();');
});

test('try-else: every except sets a flag; with a finally, a wrapping try holds it', () => {
  const out = java(`
def f():
    try:
        v = load()
    except ValueError:
        v = None
    else:
        use(v)
    try:
        w = load()
    except KeyError as e:
        log(e)
    else:
        use(w)
    finally:
        close()
`);
  contains(out, '        Object v = null;\n        boolean raised = false;\n        try {\n            v = load();\n        } catch (IllegalArgumentException ignored) {\n            raised = true;');
  contains(out, '        }\n        if (!raised) { // try-else: runs when no exception was raised\n            use(v);\n        }');
  contains(out, '        try { // try / except / else / finally\n            boolean raised2 = false;\n            try {');
  contains(out, '            if (!raised2) { // try-else: runs when no exception was raised\n                use(w);\n            }\n        } finally {\n            close();\n        }');
});

test('nested def: a lambda typed by its shape, and calls to it use the interface method', () => {
  const out = java(`
def outer(a, xs):
    def log(msg):
        print(msg)
    def key(o):
        return o.x
    def add(x, y):
        return x + y
    def three(p, q, r=0):
        return p
    def tick():
        pass
    log("hi")
    tick()
    total = add(a, 2) + three(1, 2)
    return sorted(xs, key=key)
`);
  contains(out, 'Consumer<Object> log = (msg) -> { // nested function\n            System.out.println(msg);\n        };');
  contains(out, 'Function<Object, Object> key = (o) -> { // nested function');
  contains(out, 'BiFunction<Object, Object, Object> add = (x, y) -> { // nested function');
  contains(out, 'Function<Object[], Object> three = (Object[] argv) -> { // nested function\n            var p = argv[0];\n            var q = argv[1];\n            var r = argv.length > 2 ? argv[2] : 0;');
  contains(out, 'Runnable tick = () -> { // nested function');
  contains(out, 'log.accept("hi");\n        tick.run();\n        var total = add.apply(a, 2) + three.apply(new Object[] {1, 2});');
  contains(out, 'Comparator.comparing(key)');
});

test('nested def: *args / **kwargs wrappers and decorators; a class in a function is a local class', () => {
  const out = java(`
def deco(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        return f(args)
    return wrapper

def g():
    class Local:
        pass
    return Local()
`);
  contains(out, '        // @wraps(f)\n        Function<Object[], Object> wrapper = (Object[] argv) -> { // nested function');
  contains(out, 'var args = Arrays.copyOfRange(argv, 0, argv.length); // *args');
  contains(out, 'Map<String, Object> kwargs = new HashMap<>(); // **kwargs: Java has no keyword arguments');
  contains(out, '        };\n        return wrapper;');
  contains(out, '        class Local {');
});

test('star-unpacking: calls pass one array, literals concatenate streams', () => {
  const out = java(`
def f(xs, ys, a, b):
    g(*xs)
    g(a, *xs, b)
    g(*xs, key=1)
    t = (*xs, a)
    l = [*xs, *ys, a]
    s = {*xs, "x"}
`);
  contains(out, 'g(xs.toArray());');
  contains(out, 'g(Stream.of(Stream.of(a), xs.stream(), Stream.of(b)).flatMap(Function.identity()).toArray());');
  contains(out, 'g(xs.toArray(), /* key = */ 1);');
  contains(out, 'Tuple t = Tuple.of(Stream.of(xs.stream(), Stream.of(a)).flatMap(Function.identity()).toArray());');
  contains(out, 'List<Object> l = Stream.of(xs.stream(), ys.stream(), Stream.of(a)).flatMap(Function.identity()).toList();');
  contains(out, 'Set<Object> s = Stream.of(xs.stream(), Stream.of("x")).flatMap(Function.identity()).collect(Collectors.toSet());');
});

test('star-unpacking: dict merges keep every map, later keys win', () => {
  const out = translateWithRules({ source: `
def f(d, kw):
    m = {**d, "k": 1}
    n = {**d, **kw}
`, relativePath: 'pkg/mod.py', lineWidth: 0 }).java;
  contains(out, 'Map<String, Object> m = Stream.of(d, Map.of("k", 1)).map(Map::entrySet).flatMap(Set::stream).collect(Collectors.toMap(Map.Entry::getKey, Map.Entry::getValue, (older, newer) -> newer, LinkedHashMap::new));');
  contains(out, 'Map<String, Object> n = Stream.of(d, kw).map(Map::entrySet)');
});

test('star-unpacking: a nested *args function takes the array as it is', () => {
  const out = java(`
def deco(f):
    def wrapper(*args):
        return f(args)
    def call(*args):
        return wrapper(*args)
    return call
`);
  contains(out, 'return wrapper.apply(args.toArray());');
});

test('subscripts: a subscripted key stays whole; UPPER_CASE[...] is an index, not a generic type', () => {
  const out = java(`
def f(d, lnum, fmt, i):
    d[PROTO[0]] = load
    d[lnum[0]] += 1
    del d[fmt[i]]
    e = {"E": "E", "e": "e"}[fmt]
    x: List[int] = []
    c: Callable[[int], str] = g
`);
  contains(out, 'd.put(PROTO.get(0), load);');
  contains(out, 'd.put(lnum.get(0), d.get(lnum.get(0)) + 1);');
  contains(out, 'd.remove(fmt.get(i));');
  contains(out, 'var e = Map.of("E", "E", "e", "e").get(fmt);');
  contains(out, 'List<Integer> x');
});

test('calls on values: called through a functional interface; type(self)(...) constructs', () => {
  const out = java(`
class Point:
    def f(self, event, frame, args):
        self.dispatch[event](self, frame)
        self.dispatch["call"](self, frame, 0)
        enc = factory(event)(frame)
        y = lookup("stat")()
        z = _caches[event](*args)
        return type(self)(event, frame)
    def g(self):
        return self.__class__(1, 2)
`);
  contains(out, '((BiFunction<Object, Object, Object>) this.dispatch.get(event)).apply(this, frame);');
  contains(out, '((Function<Object[], Object>) this.dispatch.get("call")).apply(new Object[] {this, frame, 0});');
  contains(out, 'var enc = ((Function<Object, Object>) factory(event)).apply(frame);');
  contains(out, 'var y = ((Supplier<Object>) lookup("stat")).get();');
  contains(out, 'var z = ((Function<Object[], Object>) _caches.get(event)).apply(args.toArray());');
  contains(out, 'return new Point(event, frame);');
  contains(out, 'return new Point(1, 2);');
});

test('operators: %, ** and in take whole operands, nested calls and subscripts included', () => {
  const out = java(`
def f(data, k, lines, start, dump, s, kind):
    a = '<td>%s</td>' % small(grey(', '.join(dump)))
    b = '{%s}' % data[1:-1]
    c = 4 ** _ceil(_log(k * 3, 4))
    d = s.CONTEXT % (data, k)
    if not s.lower() in ['deb', 'unix']:
        pass
    while start < len(lines) and lines[start].strip() in ('', '#'):
        pass
    return k % 2
`);
  contains(out, 'var a = String.format("<td>%s</td>", small(grey(String.join(", ", dump))));');
  contains(out, 'var b = String.format("{%s}", data.subList(1, data.size() - 1));');
  contains(out, 'var c = Math.pow(4, _ceil(_log(k * 3, 4)));');
  contains(out, 'var d = String.format(s.CONTEXT, data, k);');
  contains(out, 'if (!List.of("deb", "unix").contains(s.toLowerCase())) {');
  contains(out, 'List.of("", "#").contains(lines.get(start).trim())');
  contains(out, 'return k % 2;');
});

test('builtin types: int(s, base) parses; types used as values are classes', () => {
  const out = java(`
def f(s, d, T, v):
    a = int(s, 16)
    b = int(s, 0)
    d[int] = g
    if issubclass(T, int) and type(v.x) in (int, float):
        pass
    obj = super(Fraction, cls).__new__(cls)
`);
  contains(out, 'var a = Integer.parseInt(s, 16);');
  contains(out, 'var b = Integer.decode(s);');
  contains(out, 'd.put(Integer.class, g);');
  contains(out, 'if (Integer.class.isAssignableFrom(T) && List.of(Integer.class, Double.class).contains(v.x.getClass())) {');
  contains(out, 'super.__new__(');
});

test('tuples: nested targets unpack through a named inner tuple', () => {
  const out = java(`
def f(x, pairs):
    name, (a, b) = x
    for k, (c, d) in pairs:
        print(c)
`);
  contains(out, 'var name = x.get(0);\n        var inner = x.get(1);\n        var a = inner.get(0);\n        var b = inner.get(1);');
  contains(out, 'for (var item : pairs) { // tuple unpacking\n            var k = item.get(0);\n            var inner2 = item.get(1);\n            var c = inner2.get(0);');
});

test('slices: plain names use subList; calls, subscripts and steps go through Py.slice', () => {
  const out = java(`
def f(xs, s, lines, idx, n):
    a = xs[1:]
    b = xs[-n:]
    c = xs[:]
    d = s.readline()[:-1]
    e = lines[idx][len('-x'):]
    g = xs[::2]
    h = s.get_breaks()[-1]
    i = lines[0][-2]
`);
  contains(out, 'var a = xs.subList(1, xs.size());');
  contains(out, 'var b = xs.subList(xs.size() - n, xs.size());');
  contains(out, 'var c = new ArrayList<>(xs);');
  contains(out, 'var d = Py.slice(s.readline(), null, -1);');
  contains(out, 'var e = Py.slice(lines.get(idx), "-x".length(), null);');
  contains(out, 'var g = Py.slice(xs, null, null, 2);');
  contains(out, 'var h = s.get_breaks().getLast();');
  contains(out, 'var i = Py.at(lines.get(0), -2);');
});

test('slices: assignment replaces the range, del clears it', () => {
  const out = java(`
def f(xs, n, data, pos, i):
    del xs[n:]
    del xs[-2:]
    xs[pos:pos + n] = data
    xs[:] = data
    xs[:] = xs[n:]
    xs[-6:] = data
    xs[:1] = []
    xs[-3:-1] = data
`);
  contains(out, 'xs.subList(n, xs.size()).clear();');
  contains(out, 'xs.subList(xs.size() - 2, xs.size()).clear();');
  contains(out, 'xs.subList(pos, pos + n).clear(); xs.addAll(pos, data);');
  contains(out, 'xs.clear(); xs.addAll(data);');
  contains(out, 'var items = new ArrayList<>(xs.subList(n, xs.size())); xs.clear(); xs.addAll(items);');
  contains(out, 'xs.subList(xs.size() - 6, xs.size()).clear(); xs.addAll(data);');
  contains(out, 'xs.subList(0, 1).clear();\n');
  contains(out, 'int at = xs.size() - 3; xs.subList(xs.size() - 3, xs.size() - 1).clear(); xs.addAll(at, data);');
});

test('logical lines: a backslash continuation after a "#" inside a string still joins', () => {
  const out = java(`
def f(lines, end):
    if lines[end] == '#' and \\
            g(end):
        pass
`);
  contains(out, 'if (lines.get(end) == "#" && Py.truthy(g(end))) {');
});

test('comprehensions: tuple targets, nesting, several clauses and dict(pairs)', () => {
  const out = java(`
def f(d, theweek, paths, traps, xs, ys, fields, result, name):
    s = " ".join(fmt(a, b) for (a, b) in theweek)
    items = [(v, k) for (k, v) in d.items()]
    sp = [[c for c in p if c] for p in paths]
    t = dict((x, x in traps) for x in xs)
    prod = [x * y for x in xs for y in ys if y]
    fo = {n: i for (i, n) in enumerate(fields)}
    last = [e for (k, o, e) in result]
    if any((0 <= ord(ch) <= 9) for ch in name):
        pass
`);
  contains(out, 'var s = String.join(" ", theweek.stream().map(item -> fmt(item.get(0), item.get(1))));');
  contains(out, 'd.entrySet().stream().map(item -> Tuple.of(item.getValue(), item.getKey())).toList();');
  contains(out, 'paths.stream().map(p -> p.stream().filter(c -> c).toList()).toList();');
  contains(out, 'xs.stream().collect(Collectors.toMap(x -> x, x -> traps.contains(x)));');
  contains(out, 'xs.stream().flatMap(x -> ys.stream().filter(y -> y).map(y -> x * y)).toList();');
  contains(out, '.map(item -> Map.entry(item.get(1), item.get(0)))');
  contains(out, '.collect(Collectors.toMap(Map.Entry::getKey, Map.Entry::getValue));');
  contains(out, 'result.stream().map(item -> item.get(2)).toList();');
  contains(out, 'name.stream().anyMatch(ch -> (0 <= (int) ch && (int) ch <= 9))');
});

test('loops: a bare tuple is walked as a list; nested targets unpack under enumerate and items()', () => {
  const out = java(`
def f(d, ops):
    for j in 1, 2, 5:
        print(j)
    for i, (op, arg) in enumerate(ops):
        print(op)
    for (a, b), (c, e) in d.items():
        print(c)
`);
  contains(out, 'for (var j : List.of(1, 2, 5)) {');
  contains(out, 'var op = ops.get(i).get(0);\n            var arg = ops.get(i).get(1);');
  contains(out, 'var a = entry.getKey().get(0);');
  contains(out, 'var e = entry.getValue().get(1);');
});

test('generators: yields collect into a list that the function returns', () => {
  const out = java(`
from typing import Iterator

def evens(xs):
    for x in xs:
        if x % 2 == 0:
            yield x

def pairs(d) -> Iterator[int]:
    if not d:
        return
    for k, v in d.items():
        yield k, v
    yield from (x for x in d)

def outer():
    def inner():
        yield 1
    return inner

def endless():
    n = 0
    while True:
        yield n
        n += 1

def plain(yielded, name):
    yielded[name] = 1
`);
  contains(out, 'public static List<Object> evens(Object xs) {\n        List<Object> yielded = new ArrayList<>(); // generator, collected eagerly');
  contains(out, '                yielded.add(x);\n            }\n        }\n        return yielded;\n    }');
  contains(out, 'public static Iterator<Integer> pairs(Object d) {');
  contains(out, '            return yielded.iterator();\n        }');
  contains(out, 'yielded.add(Tuple.of(k, v));');
  contains(out, 'yielded.addAll((d.stream()).toList());\n        return yielded.iterator();');
  contains(out, 'Supplier<List<Object>> inner = () -> { // nested function\n            List<Object> yielded = new ArrayList<>();');
  contains(out, '            n += 1;\n        }\n    }');
  contains(out, 'public static void plain(Object yielded, Object name) {\n        yielded.put(name, 1);');
});

test('type hints: Generator keeps the yielded type; Callable with three parameters takes an array', () => {
  const out = java(`
from typing import Generator, Callable

def g() -> Generator[int, None, None]:
    yield 1

def h(f: Callable[[int, str, bool], int]):
    pass
`);
  contains(out, 'public static Iterator<Integer> g() {\n        List<Integer> yielded = new ArrayList<>();');
  contains(out, 'h(Function<Object[], Integer> f)');
});

test('strings: Python escapes become Java ones; unknown escapes keep their backslash', () => {
  assert.equal(translateExpression(String.raw`'\x00\x0a'`), String.raw`"\000\012"`);
  assert.equal(translateExpression(String.raw`'\a\v'`), String.raw`"\007\013"`);
  assert.equal(translateExpression(String.raw`'\d+\s'`), String.raw`"\\d+\\s"`);
  assert.equal(translateExpression(String.raw`r'\d+'`), String.raw`"\\d+"`);
  assert.equal(translateExpression(String.raw`'\U0001F600'`), '"\\ud83d\\ude00"');
  assert.equal(translateExpression(String.raw`'tab\t\"q\" \\ end\n'`), String.raw`"tab\t\"q\" \\ end\n"`);
});

test('javac: attributes named int/float, varargs before **kwargs, decorator arguments, class literals', () => {
  const out = java(`
import functools
class W:
    def __init__(self, a):
        self.int = a
    def f(self, *args, **kw):
        return self.int
    def g(self, *args, key=None):
        return issubclass(key, type)
    @functools.lru_cache(maxsize=128, typed=True)
    def h(self):
        pass
    @functools.wraps(f)
    def k(self):
        pass
`);
  contains(out, 'this.int_ = a;');
  contains(out, 'public Object f(Object[] args, Map<String, Object> kw /* **kwargs */) {');
  contains(out, 'public Object g(Object[] args, Object /* nullable */ key /* = null */) {');
  contains(out, 'return Class.class.isAssignableFrom(key);');
  contains(out, '@Lru_cache(maxsize = 128, typed = true)');
  contains(out, '// @functools.wraps(f)');
});

test('imports: real Java imports by default; Python modules stay as comments', () => {
  const source = 'import os\nfrom typing import List\nfrom app.repo import Repo\n\ndef f(p):\n    with open(p) as fh:\n        return Repo(fh)\n';
  const knownMembers = { properties: {}, attributes: [], returnTypes: {}, fieldTypes: {}, modules: { 'app.repo': 'shop.app.Repo' } };
  const out = translateWithRules({ source, relativePath: 'app/services/x.py', basePackage: 'shop', knownMembers }).java;
  contains(out, 'import java.io.BufferedReader;\nimport java.io.FileReader;\n\nimport shop.app.Repo;\n\n// python: import os\n// python: from typing import List\n');
  assert.ok(!/^import (os|typing)/m.test(out), 'no Python module is imported as if it were Java');
  assert.ok(!/import java\.util\.\*;/.test(out), 'wildcards are replaced by the classes used');
});

test('scoping: a local first assigned in a nested block but used outside it is declared ahead', () => {
  const out = java(`
def f(ok, xs, path, cmd):
    if ok:
        label = "yes"
    else:
        label = "no"
    print(label)
    for x in xs:
        if x > 1:
            last = x
            count = 1
    print(last)
    if ok: flag = True
    match cmd:
        case 1:
            r = 2
        case _:
            r = 3
    return flag, r

def g(ok):
    if ok:
        inner = 1
        print(inner)
`);
  contains(out, '        String label = null;\n        if (Py.truthy(ok)) {');
  contains(out, '            label = "yes";\n        } else {\n            label = "no";\n        }');
  // Never declared inside the loop: the value must survive iterations.
  contains(out, '        Object last = null;\n        for (var x : xs) {');
  contains(out, '                last = x;\n                int count = 1;');
  contains(out, '        boolean flag = false;\n        if (Py.truthy(ok)) {');
  // Not between `switch (...) {` and the first case.
  contains(out, '        int r = 0;\n        switch (cmd) {');
  // Used only where it is assigned: declared there.
  contains(out, '            int inner = 1;');
});

test('truthiness: values in conditions go through Py.truthy; booleans and predicates do not', () => {
  const out = java(`
def f(items, done: bool, params, node, flags, d, s, it, p):
    if items and not done:
        pass
    if not params or params[0] in (1, 2):
        pass
    if not isinstance(node, Constant) or flags & 4:
        pass
    if d.get("k") and s.startswith("x"):
        pass
    if is_valid(s) and it.has_next() and p.isdigit():
        pass
`);
  contains(out, 'if (Py.truthy(items) && !done) {');
  contains(out, 'if (!Py.truthy(params) || List.of(1, 2).contains(params.get(0))) {');
  contains(out, 'if (!(node instanceof Constant) || Py.truthy(flags & 4)) {');
  contains(out, 'if (Py.truthy(d.get("k")) && s.startsWith("x")) {');
  contains(out, 'if (is_valid(s) && it.has_next() && p.chars().allMatch(Character::isDigit)) {');
  contains(out, 'import pyrite.runtime.Py;');
});

test('python modules: os, sys, re, time map to the runtime library, math to java.lang.Math', () => {
  const out = java(`
import os
import sys
import re as regex
import math
import time
from os.path import join

def f(a, b, s):
    p = os.path.join(a, b)
    print(sys.argv[1], os.environ.get("HOME", "x"), join(a, b))
    st = os.stat(p)
    m = regex.match(r"(\\d+)", s)
    sys.stdout.write("hi")
    x = math.floor(math.sqrt(a)) + math.pi + math.log(a, 2)
    t = time.time()
`);
  contains(out, 'var p = Os.path.join(a, b);');
  contains(out, 'Sys.argv.get(1), Os.environ.getOrDefault("HOME", "x"), join(a, b)');
  // Not in the runtime: left as Python wrote it.
  contains(out, 'var st = os.stat(p);');
  contains(out, 'var m = Re.match("(\\\\d+)", s);');
  contains(out, 'Sys.stdout.write("hi");');
  contains(out, 'var x = (long) Math.floor(Math.sqrt(a)) + Math.PI + (Math.log(a) / Math.log(2));');
  contains(out, 'var t = Time.time();');
  contains(out, 'import pyrite.runtime.Os;\nimport pyrite.runtime.Re;\nimport pyrite.runtime.Sys;\nimport pyrite.runtime.Time;');
  contains(out, 'import static pyrite.runtime.Os.path.join;');
});

test('runtime library: a view that uses it gets its sources in the project, written once', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pyrite-runtime-'));
  try {
    const { translator } = createTranslator({ engine: 'rules' });
    fs.writeFileSync(path.join(root, 'plain.py'), 'def f(a):\n    return a + 1\n', 'utf8');
    await mirrorFile(translator, root, 'plain.py');
    const runtimeDir = path.join(root, '.java-view', 'src', 'main', 'java', 'pyrite', 'runtime');
    assert.equal(fs.existsSync(runtimeDir), false, 'a view that needs no runtime class writes none');

    fs.writeFileSync(path.join(root, 'uses.py'), 'def f(xs):\n    if xs:\n        return xs[1:-1]\n', 'utf8');
    await mirrorFile(translator, root, 'uses.py');
    for (const name of ['Py.java', 'Tuple.java', 'Os.java', 'Re.java']) {
      const text = fs.readFileSync(path.join(runtimeDir, name), 'utf8');
      contains(text, 'package pyrite.runtime;');
    }
    const before = fs.statSync(path.join(runtimeDir, 'Py.java')).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 20));
    await mirrorFile(translator, root, 'uses.py');
    assert.equal(fs.statSync(path.join(runtimeDir, 'Py.java')).mtimeMs, before, 'files already up to date are not rewritten');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
