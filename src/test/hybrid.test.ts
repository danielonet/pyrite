/**
 * Tests for the hybrid engine (rules + local Ollama), using a fake chat function instead of a server.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_OLLAMA_OPTIONS, HybridTranslator, parseAnswer } from '../translator/ollama/hybridTranslator';
import { findHardBlocks } from '../translator/ollama/hardBlocks';
import { OllamaError, ollamaChat } from '../translator/ollama/ollamaClient';
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

test('the request tells the model the runtime library, the class fields and what went wrong', async () => {
  const src = 'class Box:\n    def __init__(self):\n        self.items: list[int] = []\n\n    def f(self, xs):\n        return [y for x in xs for y in x if helper(y)]\n';
  const seen: { system: string; user: string }[] = [];
  await hybrid(async (system, user) => {
    seen.push({ system, user });
    return ANSWER;
  }).translate({
    source: src,
    relativePath: 'box.py',
    knownMembers: { properties: {}, attributes: [], returnTypes: { helper: 'boolean', other: 'int' }, fieldTypes: { 'Box.items': 'List<Integer>' } },
  });
  const call = seen[0];
  assert.match(call.system, /Py\.truthy\(Object value\)/, 'signatures come from the runtime sources');
  assert.match(call.system, /Re: .*sub/, 'module classes are listed by member name');
  assert.match(call.user, /Fields of Box:\n {2}List<Integer> items/);
  assert.match(call.user, /boolean helper\(\.\.\.\)/);
  assert.doesNotMatch(call.user, /other\(/, 'only functions the code calls are listed');
  assert.match(call.user, /What went wrong in the draft:\n- /);
});

test('the Ollama request sets the context window', async () => {
  let body: { options: Record<string, number> } | undefined;
  const real = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init: { body: string }) => {
    body = JSON.parse(init.body);
    return new Response(JSON.stringify({ message: { content: 'x' } }), { status: 200 });
  }) as typeof fetch;
  try {
    await ollamaChat({ url: 'http://x', model: 'm', timeoutMs: 1000 }, 's', 'u');
  } finally {
    globalThis.fetch = real;
  }
  assert.equal(body!.options.num_ctx, 8192);
  assert.equal(body!.options.num_predict, 2048);
});

test('an answer with a syntax error is sent back once with the error, and the fixed answer is used', async () => {
  const calls: string[] = [];
  const result = await hybrid(async (_s, user) => {
    calls.push(user);
    return calls.length === 1 ? 'public Object flat(Object xs) { // py:2\n    return xs.stream( ; // py:3\n}' : ANSWER;
  }).translate({ source: SOURCE, relativePath: 'a.py' });
  assert.equal(calls.length, 2);
  assert.match(calls[1], /Your previous answer:/);
  assert.match(calls[1], /not valid Java, answer line \d+: /);
  assert.match(result.java, /flatMap/);
});

test('an answer that stays invalid after the retry keeps the rules output', async () => {
  const bad = 'public Object flat(Object xs) { // py:2\n    return xs.stream( ; // py:3\n}';
  let calls = 0;
  const result = await hybrid(async () => {
    calls += 1;
    return bad;
  }).translate({ source: SOURCE, relativePath: 'a.py' });
  assert.equal(calls, 2, 'one retry, not more');
  assert.doesNotMatch(result.java, /Rewritten by/);
  assert.ok(result.warnings.some((w) => w.includes('still is not valid Java')));
});

test('a model that drops a string literal is asked to put it back', async () => {
  const src = 'def f(x):\n    msg = "hello world"\n    return [y for a in x for y in a if y] + [msg]\n';
  const calls: string[] = [];
  await hybrid(async (_s, user) => {
    calls.push(user);
    return calls.length === 1 ? 'public Object f(Object x) { // py:1\n    return x; // py:3\n}' : 'public Object f(Object x) { // py:1\n    String msg = "hello world"; // py:2\n    return x; // py:3\n}';
  }).translate({ source: src, relativePath: 'a.py' });
  assert.equal(calls.length, 2);
  assert.match(calls[1], /the string literal "hello world" \(Python line 2\) is missing/);
});
