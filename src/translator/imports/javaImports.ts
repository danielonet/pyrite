/**
 * Real Java imports for a Java view, so that it can one day compile and run.
 *
 * The rules engine writes Python's imports as Java-looking lines (`import logging;`,
 * `import typing.Dict;`) plus `java.util.*` wildcards: fine to read, but not one of them names a
 * class `javac` could find. This module replaces that block with explicit imports of real classes:
 *
 *  1. Every type name the Java code uses is looked up in an index of the real JDK
 *     (`jdkClasses.ts`, generated from a JDK by `scripts/build-jdk-index.js`): `List` ->
 *     `java.util.List`, `Logger` -> `java.util.logging.Logger`. `java.lang` needs no import.
 *  2. Imports of the project's own modules point at the classes Pyrite generates for them:
 *     `from .models import Order` -> `import app.Models.Order;`, a function or constant ->
 *     `import static app.Formatting.money;`.
 *  3. Lombok-style annotations the rules engine emits (`@Getter`, `@Data`, ...) import `lombok.*`.
 *  4. The names left over are given to the local LLM (see `HybridTranslator`), and each class it
 *     suggests is checked: a JDK class must exist in the index, and an import must be for a name
 *     the code actually uses. Anything that fails the check is dropped with a warning.
 *
 * Python imports with no Java counterpart are kept as `// python: ...` comments, and names nobody
 * could resolve are listed in a comment, so the view stays honest about what is missing.
 */

import { SymbolInfo } from '../types';
import { JDK_CLASSES } from './jdkClasses';
import { RUNTIME_MODULE_CLASSES, runtimeImportFor } from './pythonModules';
import { ASSERTJ_CLASS, ASSERTJ_STATICS, JUNIT_CLASSES } from '../rules/junit';
import { RUNTIME_PACKAGE } from './runtimePackage';

/** One line of the new import block, with the Python line it came from (0 when synthetic). */
export interface ImportLine {
  text: string;
  py: number;
}

/** A type name the Java code uses that no rule could import, and one line showing it in use. */
export interface UnresolvedName {
  name: string;
  usage: string;
  /**
   * Used as `@Name`: a Python decorator the rules engine kept as an annotation (`@Property`,
   * `@Fixture`). There is no Java class to find, so it is listed but not sent to the model.
   */
  annotation: boolean;
}

export { RUNTIME_PACKAGE };
/** Classes of the runtime library the rules engine writes calls to (module classes too: `Os`, `Re`, ...). */
export const RUNTIME_CLASSES = new Set(['Py', 'Tuple', 'Property', 'PropertySetter', ...RUNTIME_MODULE_CLASSES]);

export interface ImportPlan {
  /** Index range [start, end) of the import block in the Java lines (empty when there is none). */
  start: number;
  end: number;
  jdk: string[];
  library: string[];
  project: string[];
  projectStatic: string[];
  /** `// python: ...` lines for Python imports that became no Java import. */
  pythonOnly: ImportLine[];
  unresolved: UnresolvedName[];
  /** Python import lines, as written, for the model prompt. */
  pythonImports: string[];
}

/** What a Java view looks like before and after its imports are resolved. */
export interface JavaView {
  java: string;
  sourceMap: number[];
  symbols: SymbolInfo[];
}

/**
 * Packages searched, in this order, for a type name used without a qualifier. Kept to the
 * packages everyday code uses, so a common name never resolves to `java.awt.List` or the like.
 */
export const PREFERRED_PACKAGES = [
  'java.util',
  'java.util.function',
  'java.util.stream',
  'java.io',
  'java.nio.file',
  'java.nio.charset',
  'java.math',
  'java.time',
  'java.time.format',
  'java.time.temporal',
  'java.util.regex',
  'java.util.concurrent',
  'java.util.concurrent.atomic',
  'java.util.concurrent.locks',
  'java.util.logging',
  'java.net',
  'java.net.http',
  'java.text',
];

/** The Lombok annotations the rules engine writes in Lombok style. */
const LOMBOK_ANNOTATIONS = new Set(['Getter', 'Setter', 'Data', 'ToString', 'EqualsAndHashCode', 'AllArgsConstructor', 'NoArgsConstructor', 'RequiredArgsConstructor', 'Value', 'Builder']);

let jdkIndex: Map<string, Set<string>> | undefined;
let simpleNameIndex: Map<string, string> | undefined;

function jdk(): Map<string, Set<string>> {
  jdkIndex ??= new Map(Object.entries(JDK_CLASSES).map(([pkg, names]) => [pkg, new Set(names.split(' '))]));
  return jdkIndex;
}

/** True when `pkg.Simple` is a public top-level class of the JDK. */
export function isJdkClass(fqn: string): boolean {
  const dot = fqn.lastIndexOf('.');
  return dot > 0 && (jdk().get(fqn.slice(0, dot))?.has(fqn.slice(dot + 1)) ?? false);
}

/** Fully qualified JDK class for a simple name, searching `java.lang` and then `PREFERRED_PACKAGES`. */
export function jdkClassFor(simple: string): string | undefined {
  if (!simpleNameIndex) {
    simpleNameIndex = new Map();
    for (const pkg of ['java.lang', ...PREFERRED_PACKAGES]) {
      for (const name of jdk().get(pkg) ?? []) if (!simpleNameIndex.has(name)) simpleNameIndex.set(name, `${pkg}.${name}`);
    }
  }
  return simpleNameIndex.get(simple);
}

/** The Java text with string/char literals and comments blanked out, line structure kept. */
export function codeOnly(lines: string[]): string[] {
  const out: string[] = [];
  let inBlock = false;
  let inTextBlock = false;
  for (const line of lines) {
    let code = '';
    let i = 0;
    while (i < line.length) {
      if (inBlock) {
        const end = line.indexOf('*/', i);
        if (end < 0) break;
        inBlock = false;
        i = end + 2;
        continue;
      }
      if (inTextBlock) {
        const end = line.indexOf('"""', i);
        if (end < 0) break;
        inTextBlock = false;
        i = end + 3;
        code += '""';
        continue;
      }
      const rest = line.slice(i);
      if (rest.startsWith('//')) break;
      if (rest.startsWith('/*')) {
        inBlock = true;
        i += 2;
        continue;
      }
      if (rest.startsWith('"""')) {
        inTextBlock = true;
        i += 3;
        continue;
      }
      const ch = line[i];
      if (ch === '"' || ch === "'") {
        let j = i + 1;
        while (j < line.length && line[j] !== ch) j += line[j] === '\\' ? 2 : 1;
        code += ch + ch;
        i = j + 1;
        continue;
      }
      code += ch;
      i += 1;
    }
    out.push(code);
  }
  return out;
}

interface RulesImport {
  /** Dotted target as the rules engine wrote it, without `.*`. */
  target: string;
  wildcard: boolean;
  alias?: string;
  py: number;
}

function parseRulesImport(line: string, py: number): RulesImport | undefined {
  const m = /^import\s+(?:static\s+)?([\w.]+?)(\.\*)?\s*;\s*(?:\/\/\s*as\s+(\w+))?/.exec(line.trim());
  if (!m) return undefined;
  return { target: m[1], wildcard: Boolean(m[2]), alias: m[3], py };
}

/** The project module a dotted name belongs to: the longest module key it equals or starts with, also matching keys by suffix (absolute imports from a nested root). */
function projectModule(target: string, modules: Record<string, string>): { key: string; javaClass: string; rest: string } | undefined {
  const parts = target.split('.');
  for (let n = parts.length; n > 0; n -= 1) {
    const head = parts.slice(0, n).join('.');
    const rest = parts.slice(n).join('.');
    if (modules[head]) return { key: head, javaClass: modules[head], rest };
    const bySuffix = Object.keys(modules).filter((k) => k.endsWith(`.${head}`));
    if (bySuffix.length === 1) return { key: bySuffix[0], javaClass: modules[bySuffix[0]], rest };
  }
  return undefined;
}

/** Index range [start, end) of the import lines at the top of the file. */
function importBlock(lines: string[]): [number, number] {
  let start = -1;
  let end = -1;
  let insertAt = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const t = lines[i].trim();
    if (/^import\s/.test(t)) {
      if (start < 0) start = i;
      end = i + 1;
    } else if (t.startsWith('package ')) {
      insertAt = i + 1;
    } else if (t !== '' && !t.startsWith('//')) {
      break;
    }
  }
  return start < 0 ? [insertAt, insertAt] : [start, end];
}

/**
 * Work out the import block for a Java view: everything the rules and the JDK index can resolve
 * on their own, plus the names that are left for the model.
 */
export function planImports(view: JavaView, pythonSource: string, modules: Record<string, string> = {}, projectClasses: Record<string, string> = {}, basePackage = ''): ImportPlan {
  const lines = view.java.split('\n');
  const [start, end] = importBlock(lines);
  const pyLines = pythonSource.split(/\r?\n/);

  const jdkImports = new Set<string>();
  const library = new Set<string>();
  const project = new Set<string>();
  const projectStatic = new Set<string>();
  const imported = new Set<string>();
  const pythonOnlyLines = new Set<number>();
  const usefulPyLines = new Set<number>();
  const pythonImportLines = new Set<number>();

  for (let i = start; i < end; i += 1) {
    const py = view.sourceMap[i] ?? 0;
    const imp = parseRulesImport(lines[i], py);
    if (!imp || !py) continue; // the rules' own `java.util.*` lines: replaced by explicit imports below
    pythonImportLines.add(py);
    // The rules put the base package in front of the project's own modules; the module keys are Python's.
    const unprefixed = basePackage && imp.target.startsWith(`${basePackage}.`) ? imp.target.slice(basePackage.length + 1) : '';
    const mod = (unprefixed && projectModule(unprefixed, modules)) || projectModule(imp.target, modules);
    // `from os.path import join`: a static import of the runtime library's function. (Module
    // references, `os.path.join`, are rewritten to the runtime class and imported where used.)
    const runtime = !mod && !imp.wildcard ? runtimeImportFor(imp.target) : undefined;
    if (runtime?.isStatic) {
      projectStatic.add(runtime.fqn);
      usefulPyLines.add(py);
      continue;
    }
    if (!mod) {
      pythonOnlyLines.add(py);
      continue;
    }
    usefulPyLines.add(py);
    if (imp.wildcard) {
      // `from .models import *`: the module's nested classes and its static members.
      const owner = mod.rest ? `${mod.javaClass}.${mod.rest}` : mod.javaClass;
      project.add(`${owner}.*`);
      projectStatic.add(`${owner}.*`);
    } else if (!mod.rest) {
      // `import app.models` / `from . import models`: the module class itself.
      project.add(mod.javaClass);
      imported.add(mod.javaClass.split('.').pop()!);
    } else {
      const name = mod.rest.split('.').pop()!;
      // A class named like its module is the module's class itself (OrderService in order_service.py).
      const fqn = mod.rest === mod.javaClass.split('.').pop() ? mod.javaClass : `${mod.javaClass}.${mod.rest}`;
      // A capitalized name is a class (nested in the module class); anything else, functions
      // and ALL_CAPS constants, is a static member of it.
      if (/^[A-Z]/.test(name) && !/^[A-Z0-9_]+$/.test(name)) {
        project.add(fqn);
        imported.add(name);
      } else {
        projectStatic.add(fqn);
      }
      if (imp.alias) imported.add(imp.alias);
    }
  }

  // Type names the code uses: capitalized identifiers not after a `.` (so `Map.Entry` counts `Map` only).
  const declared = new Set(view.symbols.filter((s) => s.kind === 'class').map((s) => s.name));
  const body = codeOnly(lines.slice(end));
  const unresolved = new Map<string, UnresolvedName>();
  const typeParams = new Set<string>();
  for (const code of body) {
    for (const m of code.matchAll(/<\s*([A-Z]\w*)\s+extends\b/g)) typeParams.add(m[1]);
  }
  body.forEach((code, k) => {
    for (const m of code.matchAll(/(^|[^\w.$])(@?)([A-Z][A-Za-z0-9_]*)\b/g)) {
      const name = m[3];
      const annotation = m[2] === '@';
      if (declared.has(name) || imported.has(name) || typeParams.has(name) || /^[A-Z]\d*$/.test(name)) continue;
      if (annotation && LOMBOK_ANNOTATIONS.has(name)) {
        library.add(`lombok.${name}`);
        continue;
      }
      if (annotation && Object.prototype.hasOwnProperty.call(JUNIT_CLASSES, name)) {
        library.add(JUNIT_CLASSES[name]);
        continue;
      }
      if (RUNTIME_CLASSES.has(name)) {
        library.add(`${RUNTIME_PACKAGE}.${name}`);
        continue;
      }
      const fqn = jdkClassFor(name);
      if (fqn) {
        if (!fqn.startsWith('java.lang.')) jdkImports.add(fqn); // java.lang needs no import
        continue;
      }
      // A class another project module defines, used without a Python import (type hints, inferred types).
      const own = Object.prototype.hasOwnProperty.call(projectClasses, name) ? projectClasses[name] : '';
      if (own && !annotation) {
        project.add(own);
        continue;
      }
      // ALL_CAPS names are constants (module-level or enum members), not types.
      if (/^[A-Z0-9_]+$/.test(name)) continue;
      if (!unresolved.has(name)) unresolved.set(name, { name, usage: lines[end + k].trim().slice(0, 160), annotation });
    }
  });

  // AssertJ's static entry points, called by the translated pytest asserts.
  for (const fn of ASSERTJ_STATICS) {
    if (body.some((code) => new RegExp(`(^|[^\\w.$])${fn}\\(`).test(code))) projectStatic.add(`${ASSERTJ_CLASS}.${fn}`);
  }

  const pythonOnly: ImportLine[] = [...pythonOnlyLines]
    .filter((py) => !usefulPyLines.has(py))
    .sort((a, b) => a - b)
    .map((py) => ({ text: `// python: ${(pyLines[py - 1] ?? '').trim()}`, py }));

  return {
    start,
    end,
    jdk: [...jdkImports].sort(),
    library: [...library].sort(),
    project: [...project].sort(),
    projectStatic: [...projectStatic].sort(),
    pythonOnly,
    unresolved: [...unresolved.values()],
    pythonImports: [...pythonImportLines].sort((a, b) => a - b).map((py) => (pyLines[py - 1] ?? '').trim()),
  };
}

export const IMPORTS_SYSTEM_PROMPT = `You find the Java imports for a Java file that was translated from Python.
You are given the Python module's imports and the type names the Java code uses that have no import yet, each with a line that uses it.
For each name, answer with the import of the real Java class that the code means: from the JDK when it has one (for example java.util.logging.Logger or java.time.LocalDateTime), otherwise from a widely used library.
Rules:
1. One line per name, exactly in the form: import package.ClassName;
2. The class's simple name must be exactly the name you were given. Never invent a class: if no real Java class with that name fits, leave the name out.
3. No static imports, no wildcards, no explanations, no Markdown.`;

/** The unresolved names worth asking the model about (not the decorators kept as annotations). */
export function askable(plan: ImportPlan): UnresolvedName[] {
  return plan.unresolved.filter((u) => !u.annotation);
}

/** The user message asking the model for the imports `plan` could not resolve. */
export function importsPrompt(relativePath: string, plan: ImportPlan): string {
  const python = plan.pythonImports.length ? plan.pythonImports.join('\n') : '(none)';
  const names = askable(plan).map((u) => `- ${u.name}: ${u.usage}`).join('\n');
  return `File: ${relativePath}\n\nPython imports:\n${python}\n\nNames without an import:\n${names}`;
}

export interface ModelImports {
  /** Accepted fully qualified class names. */
  jdk: string[];
  library: string[];
  /** Why each rejected suggestion was rejected, for warnings. */
  rejected: string[];
}

/** JDK namespaces: a class claimed in them must be in the index to be accepted. */
const JDK_NAMESPACES = /^(java|javax|jdk|org\.w3c|org\.xml|org\.ietf)\./;

/**
 * Check the model's answer against what it was asked: each import must name a requested type,
 * and a JDK one must exist in the JDK. Library imports cannot be checked offline and are
 * accepted as long as they look like a real package.
 */
export function acceptModelImports(answer: string, plan: ImportPlan, modules: Record<string, string> = {}): ModelImports {
  const wanted = new Set(askable(plan).map((u) => u.name));
  const done = new Set<string>();
  const result: ModelImports = { jdk: [], library: [], rejected: [] };
  for (const raw of answer.split('\n')) {
    const line = raw.trim().replace(/^[-*]\s+/, '').replace(/^`|`$/g, '');
    if (!line || line.startsWith('```')) continue;
    const m = /^import\s+(static\s+)?([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)\s*;?\s*(?:\/\/.*)?$/.exec(line);
    if (!m || m[1]) {
      if (/^import\b/.test(line)) result.rejected.push(`${line} (not a single-class import)`);
      continue;
    }
    const fqn = m[2];
    const simple = fqn.split('.').pop()!;
    if (!wanted.has(simple)) {
      result.rejected.push(`${fqn} (the code does not use ${simple})`);
      continue;
    }
    if (done.has(simple)) continue;
    if (JDK_NAMESPACES.test(fqn)) {
      if (!isJdkClass(fqn)) {
        result.rejected.push(`${fqn} (no such class in the JDK)`);
        continue;
      }
      result.jdk.push(fqn);
    } else if (Object.values(modules).some((cls) => fqn.startsWith(`${cls}.`))) {
      result.library.push(fqn);
    } else if (/^[a-z][\w]*(\.[a-z_][\w]*)+\.[A-Z][\w$]*$/.test(fqn)) {
      result.library.push(fqn);
    } else {
      result.rejected.push(`${fqn} (not a valid package and class name)`);
      continue;
    }
    done.add(simple);
  }
  return result;
}

/** Lines of the new import block, mapped to the Python lines they stand for where possible. */
export function renderImports(plan: ImportPlan, fromModel: ModelImports | undefined, modelName: string): ImportLine[] {
  const modelJdk = new Set(fromModel?.jdk ?? []);
  const modelLib = new Set(fromModel?.library ?? []);
  const groups: ImportLine[][] = [
    [...new Set([...plan.jdk, ...modelJdk])].sort().map((fqn) => ({ text: `import ${fqn};${modelJdk.has(fqn) ? ` // found by ${modelName}` : ''}`, py: 0 })),
    plan.library.map((fqn) => ({ text: `import ${fqn};`, py: 0 })),
    [...modelLib].sort().map((fqn) => ({ text: `import ${fqn}; // suggested by ${modelName}; not in the JDK, needs this library on the classpath`, py: 0 })),
    plan.project.map((fqn) => ({ text: `import ${fqn};`, py: 0 })),
    plan.projectStatic.map((fqn) => ({ text: `import static ${fqn};`, py: 0 })),
    plan.pythonOnly,
  ];
  const found = new Set([...modelJdk, ...modelLib].map((f) => f.split('.').pop()!));
  const missing = plan.unresolved.filter((u) => !found.has(u.name)).map((u) => (u.annotation ? `@${u.name}` : u.name));
  if (missing.length) groups.push([{ text: `// No Java import found for: ${missing.join(', ')}`, py: 0 }]);

  const out: ImportLine[] = [];
  for (const group of groups.filter((g) => g.length)) {
    if (out.length) out.push({ text: '', py: 0 });
    out.push(...group);
  }
  return out;
}

/** Replace the import block of `view` with `imports`, keeping the source map and symbols aligned. */
export function applyImports(view: JavaView, plan: ImportPlan, imports: ImportLine[]): JavaView {
  const lines = view.java.split('\n');
  let { start, end } = plan;
  let block = imports;
  // With no import block before, separate the new one from what follows.
  if (start === end && block.length && lines[start]?.trim() !== '') block = [...block, { text: '', py: 0 }];
  // Keep the single blank line that follows a block when the new block is empty.
  if (!block.length && start < end && lines[end]?.trim() === '') end += 1;
  const delta = block.length - (end - start);
  return {
    java: [...lines.slice(0, start), ...block.map((l) => l.text), ...lines.slice(end)].join('\n'),
    sourceMap: [...view.sourceMap.slice(0, start), ...block.map((l) => l.py), ...view.sourceMap.slice(end)],
    symbols: view.symbols.map((s) => (s.javaLine >= end ? { ...s, javaLine: s.javaLine + delta } : s)),
  };
}
