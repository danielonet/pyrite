/**
 * Parse gate: generated statements that are not valid Java become stubs that parse.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyParseGate } from '../translator/parseGate';
import { javaErrorRows } from '../parser/javaParser';
import { TranslateResult } from '../translator/types';

function result(java: string, sourceMap: number[] = []): TranslateResult {
  return { java, sourceMap, symbols: [], warnings: [], engine: 'rules' };
}

const PY = ['def f(pair, xs):', '    a, b = pair', '    for x in xs:', '        pass', '    else:', '        done()'].join('\n');

test('parse gate: valid Java is left untouched', async () => {
  const java = 'class A {\n    void f() {\n        int x = 1;\n    }\n}';
  const gate = await applyParseGate(result(java), '');
  assert.equal(gate.result.java, java);
  assert.equal(gate.stubbed, 0);
  assert.equal(gate.remaining, 0);
});

test('parse gate: an invalid statement becomes a stub naming its Python source, line count unchanged', async () => {
  const java = [
    'class A {',
    '    static void f(Object pair) {',
    '        var (a, b) = pair; // tuple unpacking',
    '        int x = 1;',
    '    }',
    '}',
  ].join('\n');
  const gate = await applyParseGate(result(java, [0, 1, 2, 0, 0, 0]), PY, 'stub', 0);
  const lines = gate.result.java.split('\n');
  assert.equal(lines.length, 6);
  assert.equal(lines[2], '        if (true) throw new UnsupportedOperationException("TODO(pyrite): a, b = pair"); // was: var (a, b) = pair; // tuple unpacking');
  assert.equal(lines[3], '        int x = 1;');
  assert.equal(gate.stubbed, 1);
  assert.equal(gate.remaining, 0);
  assert.deepEqual(await javaErrorRows(gate.result.java), []);
});

test('parse gate: a wrapped statement is stubbed as a whole, its original text moves to the continuation lines', async () => {
  const java = [
    'class A {',
    '    static void f() {',
    '        g(a,',
    '                b c);',
    '    }',
    '}',
  ].join('\n');
  const gate = await applyParseGate(result(java), '');
  const lines = gate.result.java.split('\n');
  assert.equal(lines[2], '        if (true) throw new UnsupportedOperationException("TODO(pyrite): see the Python source");');
  assert.equal(lines[3], '                // was: g(a, b c);');
  assert.equal(gate.remaining, 0);
});

test('parse gate: Python loop-else keeps its body in a plain block', async () => {
  const java = [
    'class A {',
    '    static void f(java.util.List<Object> xs) {',
    '        for (var x : xs) {',
    '        } else { // loop-else: runs when the loop was not broken out of',
    '            done();',
    '        }',
    '    }',
    '}',
  ].join('\n');
  const gate = await applyParseGate(result(java), PY);
  const lines = gate.result.java.split('\n');
  assert.equal(lines[3], '        } { // was: } else { // loop-else: runs when the loop was not broken out of');
  assert.equal(lines[4], '            done();');
  assert.equal(gate.remaining, 0);
});

test('parse gate: an invalid block header opens a plain block with a stub, the body is kept', async () => {
  const java = [
    'class A {',
    '    static void f(Object pairs) {',
    '        for (var (a, b) : pairs) { // tuple unpacking',
    '            use(a);',
    '        }',
    '    }',
    '}',
  ].join('\n');
  const gate = await applyParseGate(result(java, [0, 1, 3, 4, 0, 0, 0]), PY, 'stub', 0);
  const lines = gate.result.java.split('\n');
  assert.equal(lines[2], '        { if (true) throw new UnsupportedOperationException("TODO(pyrite): for x in xs:"); // was: for (var (a, b) : pairs) { // tuple unpacking');
  assert.equal(lines[3], '            use(a);');
  assert.equal(gate.remaining, 0);
});

test('parse gate: an invalid field at class level is commented out', async () => {
  const java = ['class A {', '    static Object x = (a, b);', '    int y = 1;', '}'].join('\n');
  const gate = await applyParseGate(result(java), '');
  const lines = gate.result.java.split('\n');
  assert.equal(lines[1], '    // TODO(pyrite): not valid Java: static Object x = (a, b);');
  assert.equal(gate.remaining, 0);
});

test('parse gate: keep mode reports without changing the text', async () => {
  const java = 'class A {\n    void f() {\n        var (a, b) = p;\n    }\n}';
  const gate = await applyParseGate(result(java), '', 'keep');
  assert.equal(gate.result.java, java);
  assert.equal(gate.stubbed, 0);
  assert.ok(gate.remaining > 0);
});

test('parse gate: the stub message escapes quotes, backslashes and unicode escapes', async () => {
  const py = 's = "a\\u00e9" if q else \'"\'';
  const java = 'class A {\n    void f() {\n        var s = q ? "a\\u00e9" : "\\"" ) ;\n    }\n}';
  const gate = await applyParseGate(result(java, [0, 0, 1, 0, 0]), py);
  assert.deepEqual(await javaErrorRows(gate.result.java), []);
  assert.match(gate.result.java, /TODO\(pyrite\): s = \\"a\\\\u00e9\\" if q else '\\"'"\)/);
});

test('parse gate: stub lines stay within the line width', async () => {
  const py = `x = ${'a + '.repeat(60)}b`;
  const java = `class A {\n    void f() {\n        var x = (${'a + '.repeat(30)}b, c);\n    }\n}`;
  const gate = await applyParseGate(result(java, [0, 0, 1, 0, 0]), py, 'stub', 120);
  const line = gate.result.java.split('\n')[2];
  assert.ok(line.length <= 120, `${line.length} columns: ${line}`);
  assert.match(line, /^ {8}if \(true\) throw new UnsupportedOperationException\("TODO\(pyrite\): x = a \+ a/);
  assert.deepEqual(await javaErrorRows(gate.result.java), []);
});

test('parse gate: a deeply indented stub that cannot fit is left long rather than cut into invalid Java', async () => {
  const deep = ' '.repeat(100);
  const py = `x = ${'value + '.repeat(20)}1`;
  const java = `class A {\n    void f() {\n${deep}var x = (a,\n${deep}        b);\n    }\n}`;
  const gate = await applyParseGate(result(java, [0, 0, 1, 1, 0, 0]), py, 'stub', 120);
  assert.deepEqual(await javaErrorRows(gate.result.java), []);
  assert.match(gate.result.java.split('\n')[2], /"\);$/);
});
