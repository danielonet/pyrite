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
import { JavadocMode, KnownMembers, SymbolInfo, TranslateResult, Translator, isInitModule, javaFileBaseName, moduleClassName, packageFromPath } from './translator';
import { knownMembersOf, mergeKnownMembers } from './translator/rules/members';
import { checkSyntax } from './parser/pythonParser';
import { splitLogicalLines } from './translator/rules/logicalLines';
import { isSingleLiteral, maskStrings } from './translator/rules/strings';

export interface MirrorOptions {
  /** Absolute path of the Python project root. */
  root: string;
  /** Output folder, relative to root (default ".java-view"). */
  outputFolder?: string;
  /** Glob-like patterns (minimal: supports ** and *) of paths to skip, relative to root. */
  exclude?: string[];
  /**
   * Only mirror Python files under this folder (relative to root, forward slashes, e.g. "app/services").
   * Output paths stay relative to root, so a scoped run writes the same files a full run would.
   */
  subfolder?: string;
  /** Javadoc generation mode for classes/methods (default "docstringOnly"). */
  javadocMode?: JavadocMode;
  /** Whether test code follows the same javadocMode as production code (default false: never documented). */
  documentTestCode?: boolean;
  /** Render idiomatic Lombok-style Java instead of boilerplate (default false). See `TranslateInput.lombokStyle`. */
  lombokStyle?: boolean;
  /** Maximum line length of the generated Java; 0 disables wrapping (default 120). See `TranslateInput.lineWidth`. */
  lineWidth?: number;
  /** Progress callback: called once per file with the relative path and index. */
  onProgress?: (relativePath: string, index: number, total: number) => void;
  /** Cooperative cancellation. */
  isCancelled?: () => boolean;
}

export interface MirrorSummary {
  /** Java files written. */
  files: number;
  /** True when the run was stopped through `isCancelled` before every file was processed. */
  cancelled: boolean;
  /** `__init__.py` files that only mark a package and therefore got no Java file (see `isPackageMarkerOnly`). */
  skipped: number;
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

/**
 * Let the event loop run whatever is waiting (progress UI, cancel requests, other
 * extensions' callbacks) before continuing. The translator is synchronous, so without
 * this a large project would hold the thread until the very last file is written.
 */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Normalize a subfolder scope to a root-relative path with forward slashes and no
 * leading/trailing slash ("" means the whole root). Throws when it points outside root.
 */
export function normalizeSubfolder(root: string, subfolder: string | undefined): string {
  if (!subfolder) return '';
  const abs = path.resolve(root, subfolder);
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`Subfolder is outside the project root: ${subfolder}`);
  return rel.split(path.sep).join('/');
}

/**
 * Non-blocking variant of `listPythonFiles`: reads directories asynchronously, so walking
 * a huge tree never stalls the thread, and stops early once `isCancelled` returns true.
 * With `subfolder`, only that part of the tree is read; returned paths stay relative to root.
 */
export async function listPythonFilesAsync(root: string, exclude: string[] = DEFAULT_EXCLUDES, isCancelled?: () => boolean, subfolder?: string): Promise<string[]> {
  const results: string[] = [];
  const scope = normalizeSubfolder(root, subfolder);
  // A scope that is itself excluded (e.g. node_modules/pkg) has nothing to mirror.
  if (scope && scope.split('/').some((_part, i, parts) => {
    const prefix = parts.slice(0, i + 1).join('/');
    return isExcluded(`${prefix}/`, exclude) || isExcluded(prefix, exclude);
  })) return results;
  const walk = async (dir: string): Promise<void> => {
    if (isCancelled?.()) return;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (entry.isDirectory()) {
        if (isExcluded(`${rel}/`, exclude) || isExcluded(rel, exclude)) continue;
        await walk(abs);
      } else if (entry.isFile() && entry.name.endsWith('.py')) {
        if (isExcluded(rel, exclude)) continue;
        results.push(rel);
      }
    }
  };
  await walk(scope ? path.join(root, scope) : root);
  return results.sort();
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

/**
 * Java view path for a Python file: `app/order_service.py` -> `app/order_service.java`.
 * A package module is named after its folder in lowerCamelCase plus an `Init` suffix,
 * `app/inventory/__init__.py` -> `app/inventory/inventoryInit.java`: the suffix hints at the
 * `__init__.py` origin and keeps the file from colliding with a sibling `inventory.py` on
 * Windows/macOS, where file names are case-insensitive.
 */
export function javaPathFor(relativePython: string): string {
  const dir = relativePython.slice(0, relativePython.lastIndexOf('/') + 1);
  return `${dir}${javaFileBaseName(relativePython)}.java`;
}

export function mapPathFor(relativePython: string): string {
  return `${MAP_DIR}/${javaPathFor(relativePython)}.json`;
}

/**
 * True when `relativePython` is an `__init__.py` that exists only to make its folder a
 * Python package: nothing in it but an optional docstring, comments and an `__all__` list.
 * Java packages are plain folders, so such a file has no counterpart worth generating;
 * an `__init__.py` with real content (constants, re-exports, setup code) is still mirrored.
 */
export function isPackageMarkerOnly(relativePython: string, source: string): boolean {
  if (relativePython.split('/').pop() !== '__init__.py') return false;
  let sawCode = false;
  for (const line of splitLogicalLines(source)) {
    if (line.kind !== 'code') continue;
    const masked = maskStrings(line.text).text.trim();
    const isDocstring = !sawCode && isSingleLiteral(masked);
    sawCode = true;
    if (isDocstring) continue;
    if (/^__all__\s*(?::\s*[^=]+)?=/.test(masked)) continue;
    return false;
  }
  return true;
}

export interface MirrorFileOptions {
  outputFolder?: string;
  javadocMode?: JavadocMode;
  documentTestCode?: boolean;
  lombokStyle?: boolean;
  lineWidth?: number;
  /** Project-wide declarations; when omitted, the `members.json` a previous project run left behind is used. */
  knownMembers?: KnownMembers;
}

/** Where the project-wide member scan is persisted, relative to the output folder. */
export const MEMBERS_FILE = `${MAP_DIR}/members.json`;

function readMembersFile(root: string, outputFolder: string): KnownMembers | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, outputFolder, MEMBERS_FILE), 'utf8')) as KnownMembers;
  } catch {
    return undefined;
  }
}

/**
 * Scan every listed file for what it declares and merge the results, so each translation
 * can see properties, attribute names and typed signatures from the rest of the project.
 */
export async function scanProjectMembers(root: string, files: string[], isCancelled?: () => boolean): Promise<KnownMembers> {
  const parts: KnownMembers[] = [];
  for (const rel of files) {
    if (isCancelled?.()) break;
    await yieldToEventLoop();
    try {
      parts.push(knownMembersOf(await fs.promises.readFile(path.join(root, rel), 'utf8')));
    } catch {
      // unreadable file: it will be reported when it is translated
    }
  }
  return mergeKnownMembers(parts);
}

export type MirrorFileOutcome =
  | { skipped: false; javaAbs: string; result: TranslateResult }
  /** The file only marks a Python package (see `isPackageMarkerOnly`); any stale Java view for it was removed. */
  | { skipped: true; javaAbs?: undefined; result?: undefined };

/** Translate one Python file and write its Java view + source map. Returns the absolute Java path, or `skipped` for a bare package marker. */
export async function mirrorFile(translator: Translator, root: string, relativePython: string, options: MirrorFileOptions = {}): Promise<MirrorFileOutcome> {
  const outputFolder = options.outputFolder ?? '.java-view';
  const pyAbs = path.join(root, relativePython);
  const source = fs.readFileSync(pyAbs, 'utf8');
  if (isPackageMarkerOnly(relativePython, source)) {
    removeMirroredFile(root, relativePython, outputFolder);
    return { skipped: true };
  }
  // Earlier versions wrote package modules under other names; drop those so they don't linger next to the current file.
  if (isInitModule(relativePython)) removeLegacyInitViews(root, relativePython, outputFolder);
  let result: TranslateResult;
  const knownMembers = options.knownMembers ?? readMembersFile(root, outputFolder);
  try {
    result = await translator.translate({ source, relativePath: relativePython, javadocMode: options.javadocMode, documentTestCode: options.documentTestCode, lombokStyle: options.lombokStyle, lineWidth: options.lineWidth, knownMembers });
  } catch (err) {
    // Never leave the previous view in place: a reader would take outdated code for current.
    writeView(root, relativePython, outputFolder, failureView(relativePython, translator.name, err), [], [], translator.name);
    throw err;
  }
  // A file that does not even parse still gets a view (the rules engine is line-based and
  // survives), but the reader must know the view is built on broken input.
  const issues = await checkSyntax(source);
  if (issues.length) {
    const shown = issues.slice(0, 5).map((i) => `//   line ${i.line}, column ${i.column + 1}: ${i.message}`);
    const header = [
      `// WARNING: ${relativePython} has Python syntax errors; this view may be wrong around them.`,
      ...shown,
      ...(issues.length > 5 ? [`//   ... and ${issues.length - 5} more`] : []),
      '',
    ];
    result = prependLines(result, header);
    result.warnings.push(`${relativePython}:${issues[0].line}: Python syntax error (${issues[0].message}); the Java view is flagged`);
  }
  const javaAbs = writeView(root, relativePython, outputFolder, result.java, result.sourceMap, result.symbols, result.engine);
  return { skipped: false, javaAbs, result };
}

/** Put extra lines at the top of a translation, keeping the source map and symbol lines right. */
function prependLines(result: TranslateResult, lines: string[]): TranslateResult {
  return {
    ...result,
    java: `${lines.join('\n')}\n${result.java}`,
    sourceMap: [...lines.map(() => 0), ...result.sourceMap],
    symbols: result.symbols.map((s) => ({ ...s, javaLine: s.javaLine + lines.length })),
  };
}

/** Write the Java view and its sidecar map; returns the absolute Java path. */
function writeView(root: string, relativePython: string, outputFolder: string, java: string, lines: number[], symbols: SymbolInfo[], engine: string): string {
  const outRoot = path.join(root, outputFolder);
  const javaRel = javaPathFor(relativePython);
  const javaAbs = path.join(outRoot, javaRel);
  fs.mkdirSync(path.dirname(javaAbs), { recursive: true });
  fs.writeFileSync(javaAbs, java, 'utf8');
  const map: SourceMapFile = { python: relativePython, java: `${outputFolder}/${javaRel}`, engine, generatedAt: new Date().toISOString(), lines, symbols };
  const mapAbs = path.join(outRoot, mapPathFor(relativePython));
  fs.mkdirSync(path.dirname(mapAbs), { recursive: true });
  fs.writeFileSync(mapAbs, JSON.stringify(map), 'utf8');
  return javaAbs;
}

/** Marker text written when a file fails to translate. */
export const FAILURE_MARKER = 'TRANSLATION FAILED';

/** The Java view written for a file the translator could not handle: says so instead of showing stale code. */
export function failureView(relativePython: string, engine: string, err: unknown): string {
  const message = (err instanceof Error ? err.message : String(err)).replace(/\*\//g, '*&#47;').split('\n')[0];
  const pkg = packageFromPath(relativePython);
  return [
    `// Java view of ${relativePython}`,
    `// Generated by Pyrite (${engine} engine). Read-only reading aid: edit the Python source instead.`,
    '//',
    `// ${FAILURE_MARKER}: this file could not be translated, so no code is shown rather than an outdated view.`,
    `// ${message}`,
    '// Fix or simplify the Python construct on the line the error points at, or report it as a Pyrite bug.',
    ...(pkg ? [`package ${pkg};`] : []),
    '',
    `public final class ${moduleClassName(relativePython)} {`,
    `    // ${FAILURE_MARKER}: ${message}`,
    '}',
    '',
  ].join('\n');
}

/**
 * Remove every Java view + map under a deleted Python folder (relative to root, forward slashes).
 * Nothing happens when the folder had no mirrored files.
 */
export function removeMirroredFolder(root: string, relativeDir: string, outputFolder = '.java-view'): void {
  const dir = relativeDir.replace(/\/+$/, '');
  if (!dir || dir === '.' || dir.startsWith('..')) return;
  const outRoot = path.join(root, outputFolder);
  for (const rel of [dir, `${MAP_DIR}/${dir}`]) {
    const abs = path.join(outRoot, rel);
    if (fs.existsSync(abs)) fs.rmSync(abs, { recursive: true, force: true });
  }
}

/** Remove the Java view + map for a deleted Python file. */
export function removeMirroredFile(root: string, relativePython: string, outputFolder = '.java-view'): void {
  const outRoot = path.join(root, outputFolder);
  for (const rel of [javaPathFor(relativePython), mapPathFor(relativePython)]) {
    const abs = path.join(outRoot, rel);
    if (fs.existsSync(abs)) fs.rmSync(abs);
  }
  if (isInitModule(relativePython)) removeLegacyInitViews(root, relativePython, outputFolder);
}

/**
 * Remove views + maps a package module was written to by earlier versions of Pyrite:
 * `__init__.java`, `Inventory.java` and `InventoryPackage.java`.
 */
function removeLegacyInitViews(root: string, relativePython: string, outputFolder: string): void {
  const outRoot = path.join(root, outputFolder);
  const dir = relativePython.slice(0, relativePython.lastIndexOf('/') + 1);
  const current = javaPathFor(relativePython);
  const cls = moduleClassName(relativePython);
  const legacy = [relativePython.replace(/\.py$/, '.java'), `${dir}${cls}.java`, `${dir}${cls}Package.java`];
  for (const javaRel of legacy) {
    if (javaRel === current) continue;
    for (const rel of [javaRel, `${MAP_DIR}/${javaRel}.json`]) {
      const abs = path.join(outRoot, rel);
      if (fs.existsSync(abs)) fs.rmSync(abs);
    }
  }
}

export async function mirrorProject(translator: Translator, options: MirrorOptions): Promise<MirrorSummary> {
  const outputFolder = options.outputFolder ?? '.java-view';
  const exclude = options.exclude ?? DEFAULT_EXCLUDES;
  const files = await listPythonFilesAsync(options.root, exclude, options.isCancelled, options.subfolder);
  const outputRoot = path.join(options.root, outputFolder);
  // Cross-file knowledge: a full run scans the whole project; a subfolder run refreshes its part on top of the last full scan.
  const scanned = await scanProjectMembers(options.root, files, options.isCancelled);
  const previous = options.subfolder ? readMembersFile(options.root, outputFolder) : undefined;
  const knownMembers = previous ? mergeKnownMembers([previous, scanned]) : scanned;
  await fs.promises.mkdir(path.join(outputRoot, MAP_DIR), { recursive: true });
  await fs.promises.writeFile(path.join(outputRoot, MEMBERS_FILE), JSON.stringify(knownMembers), 'utf8');
  const warnings: string[] = [];
  let count = 0;
  let skipped = 0;
  for (const [index, rel] of files.entries()) {
    // Give the event loop a turn between files so progress, cancellation and the rest of the host keep running.
    await yieldToEventLoop();
    if (options.isCancelled?.()) break;
    options.onProgress?.(rel, index, files.length);
    try {
      const outcome = await mirrorFile(translator, options.root, rel, { outputFolder, javadocMode: options.javadocMode, documentTestCode: options.documentTestCode, lombokStyle: options.lombokStyle, lineWidth: options.lineWidth, knownMembers });
      if (outcome.skipped) {
        skipped += 1;
        continue;
      }
      warnings.push(...outcome.result.warnings);
      count += 1;
    } catch (err) {
      warnings.push(`${rel}: failed to translate: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  await fs.promises.mkdir(outputRoot, { recursive: true });
  await fs.promises.writeFile(path.join(outputRoot, 'README.md'), readmeText(outputFolder, translator.name), 'utf8');
  await fs.promises.writeFile(path.join(outputRoot, '.gitignore'), '# Generated by Pyrite - do not commit.\n*\n', 'utf8');
  return { files: count, cancelled: options.isCancelled?.() ?? false, skipped, warnings, outputRoot, engine: translator.name };
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
- A file the translator could not handle gets a placeholder marked \`TRANSLATION FAILED\` with the
  reason, never an outdated view of an earlier version.
- An \`__init__.py\` that only marks a package (docstring, comments, \`__all__\`) gets no Java file:
  Java packages are plain folders. One with real content (constants, re-exports, setup code) is mirrored
  as a class named after its folder, e.g. \`inventory/__init__.py\` -> \`public final class Inventory\`;
  its Javadoc names the original file. The file itself is named in lowerCamelCase with an \`Init\`
  suffix (\`inventory/inventoryInit.java\`), hinting at \`__init__.py\` and keeping it from colliding
  with a sibling \`inventory.py\` on Windows/macOS, where file names are case-insensitive.
- \`${outputFolder}/.pyrite/maps/\` holds line maps used for navigation between the two views.
`;
}
