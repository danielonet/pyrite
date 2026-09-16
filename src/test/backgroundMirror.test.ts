/**
 * Tests for running a project mirror without blocking the calling thread. Run with `npm test`.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runMirrorInBackground } from '../backgroundMirror';
import { listPythonFiles, listPythonFilesAsync, mirrorProject } from '../mirror';
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
