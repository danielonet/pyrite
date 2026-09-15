/**
 * Mirrors a Python source tree into a Java-view tree.
 *
 * Pure Node (no vscode dependency) so it can be used from the CLI and tests.
 *
 *   <root>/app/services/order_service.py
 *     -> <root>/.java-view/app/services/order_service.java
 *     -> <root>/.java-view/.pyrite/maps/app/services/order_service.java.json   (source map)
 */

import * as fs from 'fs';
import * as path from 'path';
import { JavadocMode, SymbolInfo, TranslateResult, Translator } from './translator';

export interface MirrorOptions {
  /** Absolute path of the Python project root. */
  root: string;
  /** Output folder, relative to root (default ".java-view"). */
  outputFolder?: string;
  /** Glob-like patterns (minimal: supports ** and *) of paths to skip, relative to root. */
  exclude?: string[];
  /** Javadoc generation mode for classes/methods (default "docstringOnly"). */
  javadocMode?: JavadocMode;
  /** Whether test code follows the same javadocMode as production code (default false: never documented). */
  documentTestCode?: boolean;
  /** Render idiomatic Lombok-style Java instead of boilerplate (default false). See `TranslateInput.lombokStyle`. */
  lombokStyle?: boolean;
  /** Progress callback: called once per file with the relative path and index. */
  onProgress?: (relativePath: string, index: number, total: number) => void;
  /** Cooperative cancellation. */
  isCancelled?: () => boolean;
}

export interface MirrorSummary {
  files: number;
  warnings: string[];
  outputRoot: string;
  engine: string;
}

export interface SourceMapFile {
  /** Python file, relative to the project root. */
  python: string;
  /** Java view file, relative to the project root. */
  java: string;
  engine: string;
  generatedAt: string;
  /** javaLine(0-based) -> pythonLine(1-based) or 0. */
  lines: number[];
  /** Classes, methods and fields declared in this file, for cross-file "Go to Definition". */
  symbols: SymbolInfo[];
}

export const DEFAULT_EXCLUDES = [
  '**/node_modules/**',
  '**/.git/**',
  '**/.venv/**',
  '**/venv/**',
  '**/__pycache__/**',
  '**/site-packages/**',
  '**/.java-view/**',
  '**/.mypy_cache/**',
  '**/.pytest_cache/**',
  '**/build/**',
  '**/dist/**',
  '**/.tox/**',
];

export const MAP_DIR = '.pyrite/maps';

/** Minimal glob matcher supporting `**`, `*` and `?` against forward-slash paths. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        // "**/" matches zero or more directories
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (ch === '?') {
      re += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(ch)) {
      re += `\\${ch}`;
    } else {
      re += ch;
    }
  }
  return new RegExp(`^${re}$`);
}

export function isExcluded(relativePath: string, patterns: string[]): boolean {
  const p = relativePath.split(path.sep).join('/');
  return patterns.some((g) => globToRegExp(g).test(p) || globToRegExp(g).test(`/${p}`));
}

/** Recursively list Python files under root (relative, forward slashes), honoring excludes. */
export function listPythonFiles(root: string, exclude: string[] = DEFAULT_EXCLUDES): string[] {
  const results: string[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (entry.isDirectory()) {
        if (isExcluded(`${rel}/`, exclude) || isExcluded(rel, exclude)) continue;
        walk(abs);
      } else if (entry.isFile() && entry.name.endsWith('.py')) {
        if (isExcluded(rel, exclude)) continue;
        results.push(rel);
      }
    }
  };
  walk(root);
  return results.sort();
}

export function javaPathFor(relativePython: string): string {
  return relativePython.replace(/\.py$/, '.java');
}

export function mapPathFor(relativePython: string): string {
  return `${MAP_DIR}/${javaPathFor(relativePython)}.json`;
}

export interface MirrorFileOptions {
  outputFolder?: string;
  javadocMode?: JavadocMode;
  documentTestCode?: boolean;
  lombokStyle?: boolean;
}

/** Translate one Python file and write its Java view + source map. Returns the absolute Java path. */
export async function mirrorFile(translator: Translator, root: string, relativePython: string, options: MirrorFileOptions = {}): Promise<{ javaAbs: string; result: TranslateResult }> {
  const outputFolder = options.outputFolder ?? '.java-view';
  const pyAbs = path.join(root, relativePython);
  const source = fs.readFileSync(pyAbs, 'utf8');
  const result = await translator.translate({ source, relativePath: relativePython, javadocMode: options.javadocMode, documentTestCode: options.documentTestCode, lombokStyle: options.lombokStyle });

  const outRoot = path.join(root, outputFolder);
  const javaRel = javaPathFor(relativePython);
  const javaAbs = path.join(outRoot, javaRel);
  fs.mkdirSync(path.dirname(javaAbs), { recursive: true });
  fs.writeFileSync(javaAbs, result.java, 'utf8');

  const map: SourceMapFile = {
    python: relativePython,
    java: `${outputFolder}/${javaRel}`,
    engine: result.engine,
    generatedAt: new Date().toISOString(),
    lines: result.sourceMap,
    symbols: result.symbols,
  };
  const mapAbs = path.join(outRoot, mapPathFor(relativePython));
  fs.mkdirSync(path.dirname(mapAbs), { recursive: true });
  fs.writeFileSync(mapAbs, JSON.stringify(map), 'utf8');
  return { javaAbs, result };
}

/** Remove the Java view + map for a deleted Python file. */
export function removeMirroredFile(root: string, relativePython: string, outputFolder = '.java-view'): void {
  const outRoot = path.join(root, outputFolder);
  for (const rel of [javaPathFor(relativePython), mapPathFor(relativePython)]) {
    const abs = path.join(outRoot, rel);
    if (fs.existsSync(abs)) fs.rmSync(abs);
  }
}

export async function mirrorProject(translator: Translator, options: MirrorOptions): Promise<MirrorSummary> {
  const outputFolder = options.outputFolder ?? '.java-view';
  const exclude = options.exclude ?? DEFAULT_EXCLUDES;
  const files = listPythonFiles(options.root, exclude);
  const warnings: string[] = [];
  let count = 0;
  for (const rel of files) {
    if (options.isCancelled?.()) break;
    options.onProgress?.(rel, count, files.length);
    try {
      const { result } = await mirrorFile(translator, options.root, rel, { outputFolder, javadocMode: options.javadocMode, documentTestCode: options.documentTestCode, lombokStyle: options.lombokStyle });
      warnings.push(...result.warnings);
    } catch (err) {
      warnings.push(`${rel}: failed to translate: ${err instanceof Error ? err.message : String(err)}`);
    }
    count += 1;
  }
  const outputRoot = path.join(options.root, outputFolder);
  fs.mkdirSync(outputRoot, { recursive: true });
  fs.writeFileSync(path.join(outputRoot, 'README.md'), readmeText(outputFolder, translator.name), 'utf8');
  fs.writeFileSync(path.join(outputRoot, '.gitignore'), '# Generated by Pyrite - do not commit.\n*\n', 'utf8');
  return { files: count, warnings, outputRoot, engine: translator.name };
}

/** Read the source map for a Java view file. Returns null when the file is not a generated view. */
export function readSourceMap(root: string, javaAbs: string, outputFolder = '.java-view'): SourceMapFile | null {
  const outRoot = path.join(root, outputFolder);
  const rel = path.relative(outRoot, javaAbs).split(path.sep).join('/');
  if (rel.startsWith('..') || !rel.endsWith('.java')) return null;
  const mapAbs = path.join(outRoot, MAP_DIR, `${rel}.json`);
  if (!fs.existsSync(mapAbs)) return null;
  try {
    return JSON.parse(fs.readFileSync(mapAbs, 'utf8')) as SourceMapFile;
  } catch {
    return null;
  }
}

/** Python line (1-based) for a Java view line (0-based); walks upward to the nearest mapped line. */
export function pythonLineFor(map: SourceMapFile, javaLine: number): number {
  for (let i = Math.min(javaLine, map.lines.length - 1); i >= 0; i -= 1) {
    if (map.lines[i] > 0) return map.lines[i];
  }
  return 1;
}

/** Java view line (0-based) for a Python line (1-based); nearest mapped line at or after it. */
export function javaLineFor(map: SourceMapFile, pythonLine: number): number {
  let best = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  map.lines.forEach((py, idx) => {
    if (py === 0) return;
    const distance = py >= pythonLine ? py - pythonLine : (pythonLine - py) * 4; // prefer lines after
    if (distance < bestDistance) {
      bestDistance = distance;
      best = idx;
    }
  });
  return best < 0 ? 0 : best;
}

function readmeText(outputFolder: string, engine: string): string {
  return `# Java view (generated)

This folder mirrors the Python sources of this workspace as Java-flavored files
so that Java developers can read and review them. It was generated by the
**Pyrite** extension using the \`${engine}\` engine.

- **Do not edit these files.** They are overwritten on every save of the Python source.
  Edit the \`.py\` file instead (use *Pyrite: Go to Python Source*, Ctrl+Alt+J).
- The code is a *reading aid*: it keeps Python names and structure and is not meant to compile.
- Constructs without a Java equivalent are kept and annotated with \`/* ... */\` comments.
- \`${outputFolder}/.pyrite/maps/\` holds line maps used for navigation between the two views.
`;
}
