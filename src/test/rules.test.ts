/**
 * Unit tests for the rule-based translator. Run with `npm test` (Node's built-in test runner).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { translateWithRules } from '../translator/rules/ruleTranslator';
import { translateExpression } from '../translator/rules/expressions';
import { translateType } from '../translator/rules/typeHints';
import { splitLogicalLines } from '../translator/rules/logicalLines';
import { globToRegExp, isExcluded, javaLineFor, pythonLineFor } from '../mirror';

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
  assert.equal(translateExpression('sum(x * 2 for x in xs)'), 'sum(xs.stream().map(x -> x * 2))');
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
  contains(out, 'try (var fh = open(p)) { // with');
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
