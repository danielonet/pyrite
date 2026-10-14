/**
 * Tests for real Java imports in the hybrid engine: the JDK index, project classes, and the
 * model's answer for the rest (a fake chat function, so no Ollama server is needed).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acceptModelImports, codeOnly, isJdkClass, jdkClassFor, planImports } from '../translator/imports/javaImports';
import { DEFAULT_OLLAMA_OPTIONS, HybridTranslator } from '../translator/ollama/hybridTranslator';
import { OllamaError } from '../translator/ollama/ollamaClient';
import { RuleBasedTranslator } from '../translator/rules/ruleTranslator';
import { KnownMembers, TranslateInput } from '../translator/types';

const SOURCE = `from fractions import Fraction
from typing import List
from .models import Order, MAX_ITEMS
from .utils import money

class Basket:
    def __init__(self, image: BufferedImage):
        self.ratio = Fraction(1, 3)
        self.orders: List[Order] = []
        self.label = "Deque of Fraction"  # Optional in a comment

    def first(self) -> Customer:
        return money(self.orders[0])
`;

const KNOWN: KnownMembers = {
  properties: {},
  attributes: [],
  returnTypes: {},
  fieldTypes: {},
  modules: { 'app.basket': 'app.Basket', 'app.models': 'app.Models', 'app.utils': 'app.Utils' },
  classes: { Basket: 'app.Basket.Basket', Order: 'app.Models.Order', Customer: 'app.Models.Customer' },
};

const INPUT: TranslateInput = { source: SOURCE, relativePath: 'app/basket.py', knownMembers: KNOWN };

function hybrid(chat: (system: string, user: string) => Promise<string>, options: Partial<typeof DEFAULT_OLLAMA_OPTIONS> = {}): HybridTranslator {
  return new HybridTranslator(new RuleBasedTranslator(), { ...DEFAULT_OLLAMA_OPTIONS, model: 'fake', ...options }, (_conn, system, user) => chat(system, user));
}

function importLines(java: string): string[] {
  return java.split('\n').filter((l) => /^import /.test(l));
}

test('the JDK index knows real classes and only real classes', () => {
  assert.ok(isJdkClass('java.util.logging.Logger'));
  assert.ok(isJdkClass('java.awt.image.BufferedImage'));
  assert.ok(!isJdkClass('java.util.Fraction'));
  assert.equal(jdkClassFor('List'), 'java.util.List', 'java.util wins over java.awt');
  assert.equal(jdkClassFor('Logger'), 'java.util.logging.Logger');
  assert.equal(jdkClassFor('String'), 'java.lang.String');
  assert.equal(jdkClassFor('BufferedImage'), undefined, 'outside the everyday packages: left to the model');
});

test('names inside strings and comments are not code', () => {
  assert.deepEqual(codeOnly(['String s = "List"; // Map', '/* Set', 'Deque */ Queue q;']), ['String s = ""; ', '', ' Queue q;']);
});

test('the plan resolves JDK, project and static imports without the model', async () => {
  const rules = await new RuleBasedTranslator().translate(INPUT);
  const plan = planImports(rules, SOURCE, KNOWN.modules, KNOWN.classes);
  assert.deepEqual(plan.jdk, ['java.util.ArrayList', 'java.util.List']);
  assert.deepEqual(plan.project, ['app.Models.Customer', 'app.Models.Order']);
  assert.deepEqual(plan.projectStatic, ['app.Models.MAX_ITEMS', 'app.Utils.money']);
  assert.deepEqual(plan.unresolved.map((u) => u.name), ['Fraction', 'BufferedImage']);
  assert.deepEqual(plan.pythonOnly.map((l) => l.text), ['// python: from fractions import Fraction', '// python: from typing import List']);
  assert.ok(!plan.unresolved.some((u) => ['Deque', 'Optional'].includes(u.name)), 'strings and comments are ignored');
});

test('the model is asked only for the leftover names, and its answer is checked', async () => {
  const prompts: string[] = [];
  const result = await hybrid(async (system, user) => {
    prompts.push(user);
    assert.match(system, /Java imports/);
    return [
      'import java.awt.image.BufferedImage;',
      'import java.util.Fraction;', // not a JDK class
      'import org.apache.commons.lang3.math.Fraction;', // a library: kept, flagged
      'import java.util.logging.Logger;', // the code does not use Logger
    ].join('\n');
  }).translate(INPUT);

  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /- Fraction: /);
  assert.match(prompts[0], /- BufferedImage: /);
  assert.doesNotMatch(prompts[0], /- (List|Order|Customer):/, 'resolved names are not sent');
  assert.match(prompts[0], /from fractions import Fraction/);

  const imports = importLines(result.java);
  assert.deepEqual(imports, [
    'import java.awt.image.BufferedImage; // found by fake',
    'import java.util.ArrayList;',
    'import java.util.List;',
    'import org.apache.commons.lang3.math.Fraction; // suggested by fake; not in the JDK, needs this library on the classpath',
    'import app.Models.Customer;',
    'import app.Models.Order;',
    'import static app.Models.MAX_ITEMS;',
    'import static app.Utils.money;',
  ]);
  assert.doesNotMatch(result.java, /import (java|typing)\.\*|import fractions|import typing/, 'no Python-shaped or wildcard imports are left');
  assert.match(result.java, /Generated by Pyrite \(rules engine \+ fake\)/);
  assert.ok(result.warnings.some((w) => w.includes('java.util.Fraction (no such class in the JDK)')));
  assert.ok(result.warnings.some((w) => w.includes('java.util.logging.Logger (the code does not use Logger)')));

  // The source map and symbols still line up with the text.
  const lines = result.java.split('\n');
  assert.equal(lines.length, result.sourceMap.length);
  assert.equal(result.sourceMap[lines.indexOf('// python: from typing import List')], 2);
  for (const s of result.symbols) assert.ok(lines[s.javaLine].includes(s.name), `${s.name} -> ${lines[s.javaLine]}`);
});

test('a model answer for imports is cached', async () => {
  let calls = 0;
  const translator = hybrid(async () => {
    calls += 1;
    return 'import java.awt.image.BufferedImage;';
  });
  await translator.translate(INPUT);
  await translator.translate(INPUT);
  assert.equal(calls, 1);
});

test('without Ollama the JDK and project imports are still resolved, and the rest is reported', async () => {
  const result = await hybrid(async () => {
    throw new OllamaError('Could not reach Ollama at http://localhost:11434: fetch failed', true);
  }).translate(INPUT);
  assert.ok(importLines(result.java).includes('import java.util.List;'));
  assert.match(result.java, /\/\/ No Java import found for: Fraction, BufferedImage/);
  assert.ok(result.warnings.some((w) => w.includes('could not ask for the missing Java imports')));
  assert.ok(result.warnings.some((w) => w.includes('no Java import found for Fraction, BufferedImage')));
  assert.match(result.java, /Generated by Pyrite \(rules engine\)/);
});

test('a file whose names all resolve makes no request', async () => {
  const source = 'import logging\nfrom typing import Dict\n\nlogger = logging.getLogger(__name__)\n\ndef counts(xs) -> Dict[str, int]:\n    return {}\n';
  const result = await hybrid(async () => assert.fail('the model must not be asked')).translate({ source, relativePath: 'app/c.py' });
  assert.deepEqual(importLines(result.java), ['import java.util.HashMap;', 'import java.util.Map;', 'import java.util.logging.Logger;']);
  assert.match(result.java, /\/\/ python: import logging/);
});

test('decorators kept as annotations are listed but not sent to the model', async () => {
  const source = 'import pytest\n\n@pytest.fixture\ndef repo():\n    return 1\n';
  const result = await hybrid(async () => assert.fail('the model must not be asked')).translate({ source, relativePath: 'tests/test_x.py' });
  assert.match(result.java, /\/\/ No Java import found for: @Fixture/);
  assert.ok(!result.warnings.some((w) => w.includes('no Java import found')));
});

test('resolveImports: false keeps the rules imports', async () => {
  const rules = await new RuleBasedTranslator().translate(INPUT);
  const result = await hybrid(async () => assert.fail('the model must not be asked'), { resolveImports: false }).translate(INPUT);
  assert.equal(result.java, rules.java);
});

test('model suggestions are limited to the names asked for', () => {
  const plan = { unresolved: [{ name: 'Fraction', usage: '', annotation: false }] } as unknown as Parameters<typeof acceptModelImports>[1];
  const got = acceptModelImports('```\nimport static java.lang.Math.max;\nimport org.apache.commons.math3.fraction.Fraction;\nimport org.other.Fraction;\nimport List;\n```', plan);
  assert.deepEqual(got.library, ['org.apache.commons.math3.fraction.Fraction'], 'the first import for a name wins');
  assert.ok(got.rejected.some((r) => r.includes('static')));
});

test('the project scan records each module class and its top-level classes', async () => {
  const { scanProjectMembers } = await import('../mirror');
  const root = require('path').join(__dirname, '..', '..', 'sample-python-project');
  const known = await scanProjectMembers(root, ['inventory/models.py', 'inventory/utils/formatting.py', 'inventory/__init__.py']);
  assert.equal(known.modules?.['inventory.models'], 'inventory.Models');
  assert.equal(known.modules?.['inventory.utils.formatting'], 'inventory.utils.Formatting');
  assert.equal(known.modules?.['inventory'], 'inventory.InventoryInit');
  assert.equal(known.classes?.Order, 'inventory.Models.Order');
});

test('a class named like its module is imported as the module class itself', async () => {
  const source = 'from .order_service import OrderService\n\ndef make() -> OrderService:\n    return OrderService()\n';
  const rules = await new RuleBasedTranslator().translate({ source, relativePath: 'app/main.py' });
  const plan = planImports(rules, source, { 'app.order_service': 'app.OrderService' });
  assert.deepEqual(plan.project, ['app.OrderService']);
});
