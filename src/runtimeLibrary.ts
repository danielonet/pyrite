/**
 * Pyrite's Java runtime library (`runtime/src/main/java/pyrite/runtime`): the classes translated
 * code calls for Python semantics with no one-line Java equivalent (`Py.truthy`, `Py.slice`,
 * `Tuple`, ...). Its sources are copied into every Java view project, next to the views, so the
 * project has what it needs to compile.
 */

import * as fs from 'fs';
import * as path from 'path';
import { RUNTIME_PACKAGE } from './translator/imports/javaImports';

/** Where the runtime's sources sit in this extension (`out/` and `src/` are both one level down). */
const RUNTIME_SOURCES = path.join(__dirname, '..', 'runtime', 'src', 'main', 'java', ...RUNTIME_PACKAGE.split('.'));

/** The runtime's source files, by file name. */
export function runtimeSources(): Map<string, string> {
  const files = new Map<string, string>();
  if (!fs.existsSync(RUNTIME_SOURCES)) return files;
  for (const name of fs.readdirSync(RUNTIME_SOURCES).filter((f) => f.endsWith('.java')).sort()) {
    files.set(name, fs.readFileSync(path.join(RUNTIME_SOURCES, name), 'utf8'));
  }
  return files;
}

/**
 * Write the runtime's sources under `sourceRoot` (a view project's `src/main/java`), in their
 * package folder. Files already up to date are left alone, so watchers see no change.
 * Returns the paths written.
 */
export function writeRuntimeLibrary(sourceRoot: string): string[] {
  const dir = path.join(sourceRoot, ...RUNTIME_PACKAGE.split('.'));
  const written: string[] = [];
  for (const [name, text] of runtimeSources()) {
    const target = path.join(dir, name);
    const content = `// Pyrite runtime library, copied into the Java view: do not edit.\n${text}`;
    if (fs.existsSync(target) && fs.readFileSync(target, 'utf8') === content) continue;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
    written.push(target);
  }
  return written;
}
