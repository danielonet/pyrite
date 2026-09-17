/**
 * Corpus and snapshot tests. Run with `npm test`.
 *
 *  - Snapshot: the sample project must translate exactly as recorded under
 *    src/test/snapshots/. Regenerate with `UPDATE_SNAPSHOTS=1 npm test` after an
 *    intended output change, and review the diff.
 *  - Corpus: the rules engine is run over real-world Python (the local standard library
 *    by default; `PYRITE_CORPUS=dir1:dir2` to choose, `PYRITE_CORPUS_LIMIT=n` /
 *    `PYRITE_CORPUS_ALL=1` for the file budget). It must never throw, must always emit
 *    balanced braces, must stay fast, and every class and top-level or method `def` the
 *    real parser (tree-sitter) sees must come out as a symbol.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { mirrorProject } from '../mirror';
import { createTranslator } from '../translator';
import { translateWithRules } from '../translator/rules/ruleTranslator';
import { definitions, parsePython } from '../parser/pythonParser';

const REPO = path.resolve(__dirname, '..', '..');
const SAMPLE = path.join(REPO, 'sample-python-project');
const SNAPSHOTS = path.join(REPO, 'src', 'test', 'snapshots', 'sample-python-project');

/** `{` minus `}` in Java text, ignoring comments, string literals, text blocks and char literals. */
export function braceBalance(java: string): number {
  let depth = 0;
  let i = 0;
  const n = java.length;
  while (i < n) {
    const ch = java[i];
    if (ch === '/' && java[i + 1] === '/') {
      const e = java.indexOf('\n', i);
      i = e < 0 ? n : e;
      continue;
    }
    if (ch === '/' && java[i + 1] === '*') {
      const e = java.indexOf('*/', i + 2);
      i = e < 0 ? n : e + 2;
      continue;
    }
    if (ch === '"') {
      if (java.startsWith('"""', i)) {
        const e = java.indexOf('"""', i + 3);
        i = e < 0 ? n : e + 3;
        continue;
      }
      i += 1;
      while (i < n && java[i] !== '"' && java[i] !== '\n') i += java[i] === '\\' ? 2 : 1;
      i += 1;
      continue;
    }
    if (ch === "'") {
      i += 1;
      while (i < n && java[i] !== "'" && java[i] !== '\n') i += java[i] === '\\' ? 2 : 1;
      i += 1;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    i += 1;
  }
  return depth;
}

function walk(dir: string, out: string[], skip: RegExp): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!skip.test(abs)) walk(abs, out, skip);
    } else if (e.name.endsWith('.py')) out.push(abs);
  }
}

// ------------------------------------------------------------------ snapshot

test('snapshot: the sample project translates exactly as recorded', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pyrite-snapshot-'));
  try {
    fs.cpSync(SAMPLE, path.join(root, 'sample-python-project'), { recursive: true });
    const { translator } = createTranslator({ engine: 'rules' });
    const summary = await mirrorProject(translator, { root, lombokStyle: true });
    assert.deepEqual(summary.warnings, []);
    const produced: string[] = [];
    const collect = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory() && e.name !== '.pyrite') collect(abs);
        else if (e.name.endsWith('.java')) produced.push(abs);
      }
    };
    collect(path.join(root, '.java-view', 'sample-python-project'));
    assert.ok(produced.length >= 8, `expected the sample project's views, got ${produced.length}`);

    const update = Boolean(process.env.UPDATE_SNAPSHOTS);
    const mismatches: string[] = [];
    for (const abs of produced.sort()) {
      const rel = path.relative(path.join(root, '.java-view', 'sample-python-project'), abs);
      const snapshot = path.join(SNAPSHOTS, rel);
      const actual = fs.readFileSync(abs, 'utf8');
      if (update) {
        fs.mkdirSync(path.dirname(snapshot), { recursive: true });
        fs.writeFileSync(snapshot, actual, 'utf8');
        continue;
      }
      if (!fs.existsSync(snapshot)) {
        mismatches.push(`${rel}: no snapshot recorded`);
        continue;
      }
      const expected = fs.readFileSync(snapshot, 'utf8');
      if (expected !== actual) {
        const a = expected.split('\n');
        const b = actual.split('\n');
        const first = a.findIndex((line, i) => line !== b[i]);
        mismatches.push(`${rel}: first difference at line ${first + 1}\n    expected: ${a[first] ?? '<end>'}\n    actual:   ${b[first] ?? '<end>'}`);
      }
    }
    assert.deepEqual(mismatches, [], `snapshots differ (run UPDATE_SNAPSHOTS=1 npm test after reviewing the change):\n${mismatches.join('\n')}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------------- corpus

function corpusDirs(): string[] {
  const configured = process.env.PYRITE_CORPUS;
  if (configured) return configured.split(path.delimiter).filter((d) => d && fs.existsSync(d));
  const candidates: string[] = [];
  for (const base of ['/usr/lib', '/usr/local/lib', '/usr/lib64', '/opt/homebrew/lib', '/Library/Frameworks/Python.framework/Versions/Current/lib']) {
    try {
      for (const e of fs.readdirSync(base)) {
        if (/^python3\.\d+$/.test(e) && fs.existsSync(path.join(base, e, 'os.py'))) candidates.push(path.join(base, e));
      }
    } catch {
      // not there
    }
  }
  return candidates.sort().slice(-1);
}

const CORPUS = corpusDirs();
const LIMIT = process.env.PYRITE_CORPUS_ALL ? Number.POSITIVE_INFINITY : Number(process.env.PYRITE_CORPUS_LIMIT ?? 300);
/** Folders of deliberately broken or Python-2 era files that no reading aid needs to handle. */
const SKIP_DIRS = /site-packages|__pycache__|[\\/](lib2to3|idlelib|test|tests|testing)([\\/]|$)/;
/** Dunder methods are renamed (toString, equals, ...) or folded into Lombok annotations; everything else keeps its name. */
const RENAMED = /^__\w+__$/;

test(`corpus: the rules engine survives real-world Python (${CORPUS[0] ?? 'no corpus found'})`, { skip: CORPUS.length === 0 && 'no Python corpus found; set PYRITE_CORPUS' }, async (t) => {
  const files: string[] = [];
  for (const dir of CORPUS) walk(dir, files, SKIP_DIRS);
  files.sort();
  const selected = files.slice(0, LIMIT);
  const threw: string[] = [];
  const unbalanced: string[] = [];
  const slow: string[] = [];
  const missing: string[] = [];
  let checkedDefinitions = 0;
  let parserAvailable = true;
  for (const abs of selected) {
    const source = fs.readFileSync(abs, 'utf8');
    const rel = path.relative(CORPUS[0], abs);
    const started = Date.now();
    let result;
    try {
      result = translateWithRules({ source, relativePath: rel, lombokStyle: false });
    } catch (err) {
      threw.push(`${rel}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const ms = Date.now() - started;
    if (ms > 3000) slow.push(`${rel}: ${ms} ms`);
    const balance = braceBalance(result.java);
    if (balance !== 0) unbalanced.push(`${rel}: ${balance > 0 ? `${balance} unclosed` : `${-balance} extra closing`}`);

    // Oracle: every class and (non-dunder) def the real parser sees must be a symbol in the output.
    const tree = await parsePython(source);
    if (!tree) {
      parserAvailable = false;
      continue;
    }
    try {
      if (tree.rootNode.hasError) continue; // a file we cannot parse is no oracle
      const names = new Set(result.symbols.map((s) => `${s.kind === 'class' ? 'class' : 'function'}:${s.name}`));
      for (const d of definitions(tree)) {
        if (d.kind === 'function' && RENAMED.test(d.name)) continue;
        checkedDefinitions += 1;
        if (!names.has(`${d.kind}:${d.name}`)) missing.push(`${rel}:${d.line}: ${d.kind} ${d.name} has no symbol in the Java view`);
      }
    } finally {
      tree.delete();
    }
  }
  t.diagnostic(`corpus: ${selected.length} of ${files.length} files, ${checkedDefinitions} definitions cross-checked${parserAvailable ? '' : ' (tree-sitter unavailable: oracle skipped)'}`);
  assert.deepEqual(threw, [], `translator threw:\n${threw.join('\n')}`);
  assert.deepEqual(unbalanced, [], `unbalanced braces:\n${unbalanced.join('\n')}`);
  assert.deepEqual(slow, [], `slow files:\n${slow.join('\n')}`);
  assert.deepEqual(missing.slice(0, 40), [], `definitions lost in translation (${missing.length}):\n${missing.slice(0, 40).join('\n')}`);
});
