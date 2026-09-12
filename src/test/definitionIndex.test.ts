/**
 * Unit tests for the "Go to Definition" symbol index. Run with `npm test`.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildSymbolIndex, enclosingClassAt, resolveDefinition } from '../definitionIndex';
import { MAP_DIR, SourceMapFile } from '../mirror';

function writeMap(root: string, outputFolder: string, map: SourceMapFile): void {
  const rel = map.java.slice(outputFolder.length + 1); // "<outputFolder>/pkg/Foo.java" -> "pkg/Foo.java"
  const mapAbs = path.join(root, outputFolder, MAP_DIR, `${rel}.json`);
  fs.mkdirSync(path.dirname(mapAbs), { recursive: true });
  fs.writeFileSync(mapAbs, JSON.stringify(map), 'utf8');
}

test('buildSymbolIndex flattens every sidecar map under the output folder', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pyrite-defidx-'));
  try {
    writeMap(root, '.java-view', {
      python: 'models.py',
      java: '.java-view/models.java',
      engine: 'rules',
      generatedAt: '',
      lines: [],
      symbols: [{ name: 'Order', kind: 'class', container: [], javaLine: 5, pythonLine: 1 }],
    });
    writeMap(root, '.java-view', {
      python: 'services/order_service.py',
      java: '.java-view/services/order_service.java',
      engine: 'rules',
      generatedAt: '',
      lines: [],
      symbols: [
        { name: 'OrderService', kind: 'class', container: [], javaLine: 5, pythonLine: 1 },
        { name: 'calculateTotal', kind: 'method', container: ['OrderService', 'OrderService'], javaLine: 10, pythonLine: 4 },
      ],
    });

    const index = buildSymbolIndex(root, '.java-view');
    assert.equal(index.length, 3);
    const total = index.find((s) => s.name === 'calculateTotal');
    assert.ok(total);
    assert.equal(total!.javaFile, '.java-view/services/order_service.java');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('enclosingClassAt finds the nearest class header at or above the given line', () => {
  const symbols = [
    { name: 'Foo', kind: 'class' as const, container: [], javaLine: 2, javaFile: 'a.java', pythonLine: 1 },
    { name: 'Bar', kind: 'class' as const, container: ['Foo'], javaLine: 8, javaFile: 'a.java', pythonLine: 1 },
  ];
  assert.equal(enclosingClassAt(symbols, 'a.java', 5), 'Foo');
  assert.equal(enclosingClassAt(symbols, 'a.java', 9), 'Bar');
  assert.equal(enclosingClassAt(symbols, 'a.java', 1), undefined);
  assert.equal(enclosingClassAt(symbols, 'other.java', 9), undefined);
});

test('resolveDefinition prefers a member of the requesting class, then a class, then same file', () => {
  const symbols = [
    { name: 'Foo', kind: 'class' as const, container: [], javaLine: 0, javaFile: 'foo.java', pythonLine: 1 },
    { name: 'get', kind: 'method' as const, container: ['Foo'], javaLine: 2, javaFile: 'foo.java', pythonLine: 2 },
    { name: 'get', kind: 'method' as const, container: ['Bar'], javaLine: 5, javaFile: 'bar.java', pythonLine: 3 },
  ];
  // Requesting from inside Foo (enclosing class header at line 0): should prefer Foo's own "get".
  const fromFoo = resolveDefinition(symbols, 'get', 'foo.java', 3);
  assert.equal(fromFoo.length, 1);
  assert.equal(fromFoo[0].container[0], 'Foo');

  // A single unambiguous match is returned as-is regardless of scope.
  const single = resolveDefinition(symbols, 'Foo', 'bar.java', 3);
  assert.equal(single.length, 1);
  assert.equal(single[0].kind, 'class');

  // Requesting from an unrelated file with no matching class in scope: both are equally
  // plausible (neither is "same class", neither is "same file"), so both come back.
  const symbolsNoOwnMatch = symbols.filter((s) => s.name === 'get');
  const fromElsewhere = resolveDefinition(symbolsNoOwnMatch, 'get', 'other.java', 0);
  assert.equal(fromElsewhere.length, 2);
});

test('resolveDefinition prefers the nested class over the module\'s own wrapper class of the same name', () => {
  // order_service.py -> module wrapper class "OrderService", which (very commonly) also
  // contains a Python class literally named OrderService - the two share a name.
  const symbols = [
    { name: 'OrderService', kind: 'class' as const, container: [], javaLine: 0, javaFile: 'order_service.java', pythonLine: 1 },
    { name: 'OrderService', kind: 'class' as const, container: ['OrderService'], javaLine: 5, javaFile: 'order_service.java', pythonLine: 3 },
  ];
  const resolved = resolveDefinition(symbols, 'OrderService', 'caller.java', 0);
  assert.equal(resolved.length, 1);
  assert.deepEqual(resolved[0].container, ['OrderService']);
});
