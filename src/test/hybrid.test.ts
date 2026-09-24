/**
 * Tests for the hybrid engine (rules + local Ollama), using a fake chat function instead of a server.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_OLLAMA_OPTIONS, HybridTranslator, parseAnswer } from '../translator/ollama/hybridTranslator';
import { findHardBlocks } from '../translator/ollama/hardBlocks';
import { OllamaError } from '../translator/ollama/ollamaClient';
import { RuleBasedTranslator } from '../translator/rules/ruleTranslator';

const SOURCE = `class A:
    def flat(self, xs):
        return [y for x in xs for y in x if y]

    def easy(self, a: int) -> int:
        return a + 1
`;

const ANSWER = `public Object flat(Object xs) { // py:2
    return xs.stream().flatMap(x -> x.stream()).filter(y -> y).toList(); // py:3
}`;

function hybrid(chat: (system: string, user: string) => Promise<string>): HybridTranslator {
  return new HybridTranslator(new RuleBasedTranslator(), { ...DEFAULT_OLLAMA_OPTIONS, model: 'fake' }, (_conn, system, user) => chat(system, user));
}

test('only functions with hard constructs are picked', () => {
  const blocks = findHardBlocks(SOURCE, new Set(), new Set());
  assert.deepEqual(blocks.map((b) => b.name), ['flat']);
  assert.equal(blocks[0].reason, 'nested comprehension');
});

test('constructs the rules already handle (generators, async, lambdas) are not sent to the model', () => {
  const src = 'def g(xs):\n    yield from xs\n\nasync def a(x):\n    return await x\n\ndef h():\n    return lambda a: (lambda b: a + b)\n';
  assert.deepEqual(findHardBlocks(src, new Set(), new Set()), []);
});

test('a function the rules flagged is picked even without a hard construct', () => {
  const blocks = findHardBlocks('def f(x):\n    return x\n', new Set([2]), new Set());
  assert.equal(blocks[0].reason, 'the rules reported a warning');
});

test('a hard function is replaced by the model answer and the source map follows', async () => {
  const prompts: string[] = [];
  const result = await hybrid(async (_s, user) => {
    prompts.push(user);
    return '```java\n' + ANSWER + '\n```';
  }).translate({ source: SOURCE, relativePath: 'a.py' });

  assert.equal(prompts.length, 1, 'only the hard function is sent');
  assert.match(prompts[0], /2 \|     def flat/);
  assert.equal(result.engine, 'hybrid');
  assert.match(result.java, /flatMap/);
  assert.match(result.java, /Rewritten by fake/);
  assert.match(result.java, /return a \+ 1;/, 'the easy method keeps the rules output');
  assert.doesNotMatch(result.java, /py:\d/, 'markers are stripped');
  const lines = result.java.split('\n');
  assert.equal(lines.length, result.sourceMap.length);
  assert.equal(result.sourceMap[lines.findIndex((l) => l.includes('flatMap'))], 3);
  const easy = result.symbols.find((s) => s.name === 'easy')!;
  assert.match(lines[easy.javaLine], /easy\(/, 'symbols after the rewrite are shifted');
});

test('an unreachable model keeps the rules output and says why', async () => {
  const result = await hybrid(async () => {
    throw new OllamaError('Could not reach Ollama', true);
  }).translate({ source: SOURCE, relativePath: 'a.py' });
  assert.equal(result.engine, 'hybrid');
  assert.doesNotMatch(result.java, /Rewritten by/);
  assert.ok(result.warnings.some((w) => w.includes('kept the rules translation of flat()')));
});

test('an unusable answer (unbalanced braces) is rejected', async () => {
  const result = await hybrid(async () => 'public Object flat(Object xs) {').translate({ source: SOURCE, relativePath: 'a.py' });
  assert.doesNotMatch(result.java, /Rewritten by/);
  assert.ok(result.warnings.some((w) => w.includes('not usable Java')));
});

test('parseAnswer strips markers and lets lines follow the nearest one above', () => {
  const p = parseAnswer('void f() { // py:4\n    g(); // py:5\n}', 4, '    ');
  assert.deepEqual(p.lines, ['    void f() {', '        g();', '    }']);
  assert.deepEqual(p.map, [4, 5, 5]);
});
