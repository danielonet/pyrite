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
import { MAP_DIR, SourceMapFile, mapPathFor } from './mirror';
import { SymbolInfo, isInitModule } from './translator';

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

/** How many sidecar maps are read at once while (re)building a `SymbolIndexCache`. */
const READ_CONCURRENCY = 64;

/**
 * Cached, non-blocking symbol index for one output folder.
 *
 * `buildSymbolIndex` re-reads every sidecar map synchronously, which on a large project
 * freezes the extension host on each "Go to Definition". This cache reads the maps
 * asynchronously once, then re-reads only the maps it is told changed. Callers report
 * changes with `invalidateMap` / `invalidatePython`, or `invalidateAll` after a bulk run.
 */
export class SymbolIndexCache {
  /** Symbols per sidecar map, keyed by the map's absolute path. */
  private readonly byMap = new Map<string, IndexedSymbol[]>();
  private readonly stale = new Set<string>();
  private needsFullScan = true;
  /** Bumped on every invalidation, so a build that raced with a change is not cached as current. */
  private generation = 0;
  private current?: IndexedSymbol[];
  private building?: Promise<IndexedSymbol[]>;

  constructor(
    readonly root: string,
    readonly outputFolder = '.java-view',
  ) {}

  /** Absolute folder holding the sidecar maps this cache reads. */
  get mapsRoot(): string {
    return path.join(this.root, this.outputFolder, MAP_DIR);
  }

  /** Every symbol in the output folder. Concurrent callers share one build. */
  get(): Promise<IndexedSymbol[]> {
    if (this.current) return Promise.resolve(this.current);
    if (!this.building) {
      this.building = this.refresh().finally(() => {
        this.building = undefined;
      });
    }
    return this.building;
  }

  /** Forget everything; the next `get` rescans the whole maps folder (e.g. after generating or clearing the view). */
  invalidateAll(): void {
    this.needsFullScan = true;
    this.touch();
  }

  /** One sidecar map (absolute path) was written or deleted. */
  invalidateMap(mapAbs: string): void {
    this.stale.add(mapAbs);
    this.touch();
  }

  /** The Java view of one Python file (relative to root) was regenerated or removed. */
  invalidatePython(relativePython: string): void {
    // A package module may also have dropped maps under older file names; rescan rather than track them all.
    if (isInitModule(relativePython)) this.invalidateAll();
    else this.invalidateMap(path.join(this.root, this.outputFolder, mapPathFor(relativePython)));
  }

  private touch(): void {
    this.generation += 1;
    this.current = undefined;
  }

  private async refresh(): Promise<IndexedSymbol[]> {
    const generation = this.generation;
    let toRead: string[];
    if (this.needsFullScan) {
      this.needsFullScan = false;
      this.stale.clear();
      this.byMap.clear();
      toRead = await listMapFiles(this.mapsRoot);
    } else {
      toRead = [...this.stale];
      this.stale.clear();
    }
    for (let i = 0; i < toRead.length; i += READ_CONCURRENCY) {
      const batch = toRead.slice(i, i + READ_CONCURRENCY);
      const read = await Promise.all(batch.map((abs) => readMapSymbols(abs)));
      batch.forEach((abs, j) => {
        const symbols = read[j];
        if (symbols) this.byMap.set(abs, symbols);
        else this.byMap.delete(abs);
      });
    }
    const all = [...this.byMap.values()].flat();
    if (generation === this.generation) this.current = all;
    return all;
  }
}

/** Absolute paths of every sidecar map under `mapsRoot`, read without blocking. */
async function listMapFiles(mapsRoot: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(abs);
      else if (entry.isFile() && entry.name.endsWith('.json')) files.push(abs);
    }
  };
  await walk(mapsRoot);
  return files;
}

/** Symbols of one sidecar map, or undefined when it is missing, partially written or corrupt. */
async function readMapSymbols(mapAbs: string): Promise<IndexedSymbol[] | undefined> {
  try {
    const map = JSON.parse(await fs.promises.readFile(mapAbs, 'utf8')) as SourceMapFile;
    return (map.symbols ?? []).map((sym) => ({ ...sym, javaFile: map.java }));
  } catch {
    return undefined;
  }
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
