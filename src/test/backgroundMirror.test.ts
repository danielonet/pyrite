/**
 * Tests for running a project mirror without blocking the calling thread. Run with `npm test`.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runMirrorInBackground } from '../backgroundMirror';
import { listPythonFiles, listPythonFilesAsync, mirrorProject, normalizeSubfolder } from '../mirror';
import { createTranslator } from '../translator';

function makeProject(moduleCount: number): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pyrite-bg-'));
  fs.mkdirSync(path.join(root, 'pkg', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(root, 'pkg', '__init__.py'), '"""Just a package."""\n', 'utf8');
  for (let i = 0; i < moduleCount; i += 1) {
    const dir = i % 2 ? path.join(root, 'pkg', 'sub') : path.join(root, 'pkg');
    fs.writeFileSync(path.join(dir, `mod_${i}.py`), `class Thing${i}:\n    def size(self) -> int:\n        return ${i}\n`, 'utf8');
  }
  return root;
}

test('runMirrorInBackground translates the project on a worker thread and reports progress', async () => {
  const root = makeProject(6);
  try {
    const seen: number[] = [];
    let total = 0;
    const run = runMirrorInBackground({ engine: 'rules', options: { root } }, (_rel, index, t) => {
      seen.push(index);
      total = t;
    });
    const summary = await run.result;
    assert.equal(summary.cancelled, false);
    assert.equal(summary.files, 6);
    assert.equal(summary.skipped, 1, 'the bare __init__.py is skipped');
    assert.equal(total, 7);
    assert.equal(seen[seen.length - 1], 6, 'the last file is always reported, even with throttling');
    const java = fs.readFileSync(path.join(root, '.java-view', 'pkg', 'sub', 'mod_1.java'), 'utf8');
    assert.ok(java.includes('public static class Thing1'), java);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runMirrorInBackground stops early on cancel and still resolves', async () => {
  const root = makeProject(300);
  try {
    const run = runMirrorInBackground({ engine: 'rules', options: { root } });
    run.cancel();
    const summary = await run.result;
    assert.equal(summary.cancelled, true);
    assert.ok(summary.files < 300, `expected an early stop, got ${summary.files} files`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('mirrorProject gives the event loop a turn between files', async () => {
  const root = makeProject(5);
  try {
    const { translator } = createTranslator({ engine: 'rules' });
    let immediateRan = false;
    let ranBeforeNextFile: boolean | undefined;
    await mirrorProject(translator, {
      root,
      onProgress: (_rel, index) => {
        if (index === 0) setImmediate(() => (immediateRan = true));
        if (index === 1) ranBeforeNextFile = immediateRan;
      },
    });
    assert.equal(ranBeforeNextFile, true, 'a callback queued while file 1 was processed must run before file 2 starts');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('listPythonFilesAsync matches listPythonFiles and honors excludes', async () => {
  const root = makeProject(4);
  try {
    fs.mkdirSync(path.join(root, 'node_modules', 'x'), { recursive: true });
    fs.writeFileSync(path.join(root, 'node_modules', 'x', 'skip.py'), '', 'utf8');
    const async = await listPythonFilesAsync(root);
    assert.deepEqual(async, listPythonFiles(root));
    assert.ok(!async.some((f) => f.includes('node_modules')));
    assert.deepEqual(await listPythonFilesAsync(root, undefined, () => true), [], 'a cancelled walk returns nothing');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('subfolder scope: only that folder is read and translated, paths stay relative to root', async () => {
  const root = makeProject(6); // even modules in pkg/, odd modules in pkg/sub/
  try {
    const listed = await listPythonFilesAsync(root, undefined, undefined, 'pkg/sub');
    assert.deepEqual(listed, ['pkg/sub/mod_1.py', 'pkg/sub/mod_3.py', 'pkg/sub/mod_5.py']);
    assert.deepEqual(await listPythonFilesAsync(root, undefined, undefined, 'pkg\\sub/'.replace('\\', path.sep)), listed, 'separators and trailing slash are normalized');

    const run = runMirrorInBackground({ engine: 'rules', options: { root, subfolder: 'pkg/sub' } });
    const summary = await run.result;
    assert.equal(summary.files, 3);
    assert.ok(fs.existsSync(path.join(root, '.java-view', 'pkg', 'sub', 'mod_1.java')));
    assert.equal(fs.existsSync(path.join(root, '.java-view', 'pkg', 'mod_0.java')), false, 'files outside the subfolder are not translated');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('subfolder scope: an excluded or escaping subfolder is handled', async () => {
  const root = makeProject(2);
  try {
    fs.mkdirSync(path.join(root, 'node_modules', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(root, 'node_modules', 'lib', 'x.py'), '', 'utf8');
    assert.deepEqual(await listPythonFilesAsync(root, undefined, undefined, 'node_modules/lib'), []);
    assert.equal(normalizeSubfolder(root, ''), '');
    assert.throws(() => normalizeSubfolder(root, '../elsewhere'), /outside the project root/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runMirrorInBackground falls back to in-process work when the worker script is missing', async () => {
  const root = makeProject(3);
  try {
    const seen: number[] = [];
    const run = runMirrorInBackground({ engine: 'rules', options: { root } }, (_rel, index) => seen.push(index), path.join(root, 'no-such-worker.js'));
    const summary = await run.result;
    assert.equal(summary.files, 3);
    assert.deepEqual(seen, [0, 1, 2, 3]);
    assert.ok(fs.existsSync(path.join(root, '.java-view', 'pkg', 'mod_0.java')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
