/**
 * Cross-file symbol index for "Go to Definition" inside the generated Java view.
 *
 * Built from the sidecar source maps `mirror.ts` writes next to each generated
 * file (`<outputFolder>/.pyrite/maps/**\/*.json`); each one lists the classes,
 * methods and fields the rule translator emitted for that file (`SymbolInfo[]`,
 * see `translator/types.ts`). Pure Node so it can be unit tested without vscode.
 */

import * as fs from 'fs';
import * as path from 'path';
import { MAP_DIR, SourceMapFile } from './mirror';
import { SymbolInfo } from './translator';

export interface IndexedSymbol extends SymbolInfo {
  /** Java view file the symbol is declared in, relative to the project root (e.g. ".java-view/pkg/Foo.java"). */
  javaFile: string;
}

/** Read every sidecar map under `<root>/<outputFolder>/.pyrite/maps` and flatten their symbols. */
export function buildSymbolIndex(root: string, outputFolder = '.java-view'): IndexedSymbol[] {
  const mapsRoot = path.join(root, outputFolder, MAP_DIR);
  const result: IndexedSymbol[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile() && entry.name.endsWith('.json')) {
        try {
          const map = JSON.parse(fs.readFileSync(abs, 'utf8')) as SourceMapFile;
          for (const sym of map.symbols ?? []) {
            result.push({ ...sym, javaFile: map.java });
          }
        } catch {
          // Skip a partially-written or corrupt sidecar file rather than fail the whole lookup.
        }
      }
    }
  };
  walk(mapsRoot);
  return result;
}

/** The class whose body encloses `javaLine` in `javaFile`, i.e. the nearest class header at or above it. */
export function enclosingClassAt(symbols: IndexedSymbol[], javaFile: string, javaLine: number): string | undefined {
  let best: IndexedSymbol | undefined;
  for (const s of symbols) {
    if (s.javaFile !== javaFile || s.kind !== 'class' || s.javaLine > javaLine) continue;
    if (!best || s.javaLine > best.javaLine) best = s;
  }
  return best?.name;
}

/**
 * All symbols named `name`, ranked by how well they match the requesting
 * position, best first: a member of the class the request came from; then a
 * "real" (nested) class declaration - i.e. a Python class, as opposed to the
 * synthetic per-module wrapper class every generated file gets, which often
 * shares a name with the one Python class that file mostly exists for; then
 * any same-file match; then the module wrapper class itself; then anything
 * else. Ties (e.g. two same-scored matches) are all returned so the caller
 * can offer a picker instead of guessing.
 */
export function resolveDefinition(symbols: IndexedSymbol[], name: string, fromFile: string, fromLine: number): IndexedSymbol[] {
  const matches = symbols.filter((s) => s.name === name);
  if (matches.length <= 1) return matches;
  const currentClass = enclosingClassAt(symbols, fromFile, fromLine);
  const score = (s: IndexedSymbol): number => {
    if (currentClass && s.container[s.container.length - 1] === currentClass) return 0;
    if (s.kind === 'class' && s.container.length > 0) return 1;
    if (s.javaFile === fromFile) return 2;
    if (s.kind === 'class') return 3; // the module's own wrapper class: rarely the intended target
    return 4;
  };
  const best = Math.min(...matches.map(score));
  return matches.filter((s) => score(s) === best);
}
