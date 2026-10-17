/**
 * Hybrid engine: the rules engine translates every file (fast, deterministic, offline), and a
 * local Ollama model rewrites only the functions the rules handle badly - ones it flagged
 * (warnings, untranslated statements) or that use constructs it only approximates.
 *
 * Fail soft, never fail silent: if Ollama is unreachable, slow or answers with something
 * unusable, the rules output for that function stays and a warning says why.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { IMPORTS_SYSTEM_PROMPT, JavaView, ModelImports, acceptModelImports, applyImports, askable, importsPrompt, planImports, renderImports } from '../imports/javaImports';
import { javaErrorRows } from '../../parser/javaParser';
import { runtimeCheatSheet } from '../../runtimeLibrary';
import { RuleBasedTranslator } from '../rules/ruleTranslator';
import { KnownMembers, SymbolInfo, TranslateInput, TranslateResult, Translator } from '../types';
import { findHardBlocks, PythonBlock } from './hardBlocks';
import { ChatFn, OllamaConnection, OllamaError, ollamaChat } from './ollamaClient';

export interface OllamaOptions extends OllamaConnection {
  /** Upper bound on functions sent to the model per file (the rest keep the rules output). */
  maxBlocksPerFile: number;
  /** JSON file caching model answers, so unchanged functions are not sent again. Optional. */
  cacheFile?: string;
  /**
   * Replace the rules engine's Python-shaped imports with real Java ones (JDK index, project
   * classes, then the model for what is left), a step towards a view that compiles. Default true.
   */
  resolveImports?: boolean;
}

export const DEFAULT_OLLAMA_OPTIONS: OllamaOptions = {
  url: 'http://localhost:11434',
  model: 'qwen2.5-coder:7b',
  timeoutMs: 300_000,
  maxBlocksPerFile: 10,
  resolveImports: true,
};

const UNREACHABLE_BACKOFF_MS = 60_000;
const MAX_CACHE_ENTRIES = 2000;

export const SYSTEM_PROMPT = `You rewrite ONE Python function as Java for Java developers who do not know Python. Aim for Java that compiles once the listed types exist.
You are given the Python function, a draft produced by a rule-based translator, and a list of what went wrong in that draft. The draft's names and structure are mostly right; fix the listed problems and keep the rest unless it is clearly broken.

Rules:
1. Faithfulness first: keep every statement, name, string and comment. Do not summarize, reorder, drop code or add behavior.
2. Java syntax: braces, semicolons, explicit types (take them from the class fields, the known signatures and the type hints; use var or Object only when unknown), comments as // comments.
3. Keep the function's name, parameters and modifiers exactly as in the draft. Output the single function only: no enclosing class, no imports. The Pyrite runtime classes below are already imported.
4. Keep snake_case identifiers as in Python. Idioms: comprehensions -> streams, f-strings -> concatenation or String.format, dict -> Map, list -> List, None -> null, raise -> throw new, with -> try-with-resources, generators -> a comment plus the closest Java form, async/await kept as comments.
5. When Python behavior has no one-line Java equivalent (truthiness, slices, negative indexes, tuples, string methods, os, re), call the Pyrite runtime library below instead of inventing Java. Use only the members listed there; never invent a helper class or method. Only if nothing fits, keep the construct as close to Java as possible with a short /* python: ... */ comment. Never silently drop it.
6. End every method header, class header and control-flow header line (if/for/while/try/with/else/catch) with a marker comment "// py:N" where N is the 1-based Python line number shown to the left of the code. Add no other markers.
7. Output only the Java text, no Markdown fences and no explanations.`;

/** The system prompt plus the runtime library's reference, built from its Java sources. */
export function systemPrompt(): string {
  const sheet = runtimeCheatSheet();
  return sheet ? `${SYSTEM_PROMPT}\n\nPyrite runtime library (package pyrite.runtime; for a class listed by member names only, the Python names are kept, e.g. Re.sub):\n${sheet}` : SYSTEM_PROMPT;
}

/** Most known signatures listed in one request, so the prompt stays inside the context window. */
const MAX_KNOWN_SIGNATURES = 24;

/** Name of the Python class whose body holds the line `defLine`, found by indentation. */
function enclosingClass(pyLines: string[], defLine: number): string | undefined {
  const indentOf = (l: string) => /^\s*/.exec(l)![0].length;
  let indent = indentOf(pyLines[defLine - 1] ?? '');
  for (let i = defLine - 2; i >= 0 && indent > 0; i -= 1) {
    if (!pyLines[i].trim() || indentOf(pyLines[i]) >= indent) continue;
    indent = indentOf(pyLines[i]);
    const m = /^\s*class\s+([A-Za-z_]\w*)/.exec(pyLines[i]);
    if (m) return m[1];
  }
  return undefined;
}

/** What the rest of the project says about the function's surroundings: the class's fields and the signatures it calls. */
export function contextFor(known: KnownMembers | undefined, cls: string | undefined, functionText: string): string {
  if (!known) return '';
  const parts: string[] = [];
  if (cls) {
    const fields = Object.entries(known.fieldTypes).filter(([k]) => k.startsWith(`${cls}.`)).map(([k, t]) => `${t} ${k.slice(cls.length + 1)}`);
    if (fields.length) parts.push(`Fields of ${cls}:\n${fields.map((f) => `  ${f}`).join('\n')}`);
  }
  const called = new Set([...functionText.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)].map((m) => m[1]));
  const signatures = Object.entries(known.returnTypes)
    .filter(([k]) => called.has(k.split('.').pop()!))
    .slice(0, MAX_KNOWN_SIGNATURES)
    .map(([k, t]) => `  ${t} ${k}(...)`);
  if (signatures.length) parts.push(`Return types of project functions this code calls:\n${signatures.join('\n')}`);
  return parts.join('\n\n');
}

interface CacheFile {
  [key: string]: string;
}

/** What one accepted model answer becomes once markers are stripped. */
export interface ParsedAnswer {
  lines: string[];
  /** Python line (1-based) per output line, 0 when unknown. */
  map: number[];
}

/** Strip a Markdown fence if the model added one, then trim trailing blank lines. */
function cleanAnswer(raw: string): string {
  let text = raw.replace(/\r\n/g, '\n').trim();
  const fence = /^```[\w-]*\n([\s\S]*?)\n?```$/.exec(text);
  if (fence) text = fence[1];
  return text.replace(/\s+$/, '');
}

/** Braces outside strings and `//` comments must balance, and there must be at least one pair or a `;`. */
function looksLikeJava(text: string): boolean {
  let depth = 0;
  for (const line of text.split('\n')) {
    const code = line.replace(/"(?:\\.|[^"\\])*"/g, '""').replace(/'(?:\\.|[^'\\])*'/g, "''").replace(/\/\/.*$/, '');
    for (const ch of code) {
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
      if (depth < 0) return false;
    }
  }
  return depth === 0 && text.trim().length > 0 && !text.includes('```');
}

/**
 * Turn the model's text into lines and a source map: `// py:N` markers are removed and each line
 * inherits the nearest marker above it (the first line defaults to the function's `def` line).
 * Every line is re-indented to `indent`, keeping the model's relative indentation.
 */
export function parseAnswer(answer: string, defLine: number, indent: string): ParsedAnswer {
  const raw = answer.split('\n');
  const base = Math.min(...raw.filter((l) => l.trim()).map((l) => /^\s*/.exec(l)![0].length));
  const lines: string[] = [];
  const map: number[] = [];
  let current = defLine;
  for (const l of raw) {
    const marker = /\s*\/\/\s*py:(\d+)\s*$/.exec(l);
    if (marker) current = Number(marker[1]);
    const text = marker ? l.slice(0, marker.index) : l;
    lines.push(text.trim() ? indent + text.slice(base).replace(/\s+$/, '') : '');
    // A marker names its own line; the lines after it (bodies, closing braces) follow it.
    map.push(marker ? current : lines.length === 1 ? defLine : text.trim() ? current : 0);
  }
  return { lines, map };
}

/** Index range [a, b] of the Java function whose Python lines are [block.start, block.end], or undefined. */
function locateJavaBlock(javaLines: string[], sourceMap: number[], block: PythonBlock): [number, number] | undefined {
  const a = sourceMap.findIndex((py) => py >= block.start && py <= block.end);
  if (a < 0) return undefined;
  let depth = 0;
  let opened = false;
  for (let i = a; i < javaLines.length; i += 1) {
    const code = javaLines[i].replace(/"(?:\\.|[^"\\])*"/g, '""').replace(/\/\/.*$/, '');
    for (const ch of code) {
      if (ch === '{') {
        depth += 1;
        opened = true;
      } else if (ch === '}') depth -= 1;
    }
    if (opened && depth <= 0) return depth === 0 ? [a, i] : undefined;
    if (!opened && depth === 0 && code.trim().endsWith(';')) return [a, i];
  }
  return undefined;
}

/**
 * The concrete problems the rules reported inside `block`: each warning, and each statement left
 * `untranslated`, with the Python line it came from. Tells the model where to look.
 */
function problemsFor(block: PythonBlock, warnings: string[], javaLines: string[], sourceMap: number[], pyLines: string[]): string[] {
  const out: string[] = [];
  for (const w of warnings) {
    const m = /:(\d+): (.*)$/.exec(w);
    if (m && Number(m[1]) >= block.start && Number(m[1]) <= block.end) out.push(`line ${m[1]}: ${m[2]}`);
  }
  javaLines.forEach((l, i) => {
    const py = sourceMap[i];
    if (l.includes('TODO: untranslated') && py >= block.start && py <= block.end) out.push(`line ${py} was not translated: ${pyLines[py - 1].trim()}`);
  });
  if (out.length === 0) out.push(block.reason);
  return [...new Set(out)].slice(0, 10);
}

/** What is wrong with a model answer, found without asking the model. */
export interface AnswerProblems {
  /** Lines that are not valid Java, as "answer line N: text". Empty when the answer parses (or no parser is available). */
  syntax: string[];
  /** Plain string literals of the Python that the answer does not contain. */
  missingStrings: string[];
}

const MAX_REPORTED = 5;

/** Plain "..." / '...' literals in the Python code (not f-strings, prefixed strings or docstrings), with their 1-based line within `pythonLines`. */
function pythonStringLiterals(pythonLines: string[]): { text: string; line: number }[] {
  const found: { text: string; line: number }[] = [];
  pythonLines.forEach((l, i) => {
    if (l.trimStart().startsWith('#') || l.includes('"""') || l.includes("'''")) return;
    for (const m of l.matchAll(/(?<![\w"'])(["'])((?:(?!\1)[^\\\n])+)\1/g)) {
      if (m[2].trim() && !found.some((f) => f.text === m[2])) found.push({ text: m[2], line: i + 1 });
    }
  });
  return found;
}

/**
 * Check a model answer for `block`: it must parse as a Java method, and keep every plain string
 * literal of the Python function (rule 1 of the prompt, "keep every string").
 */
export async function checkAnswer(answer: string, block: PythonBlock, pyLines: string[]): Promise<AnswerProblems> {
  const rows = await javaErrorRows(`class Wrapper {\n${answer}\n}`);
  const answerLines = answer.split('\n');
  const syntax = (rows ?? [])
    .map((row) => Math.min(Math.max(row - 1, 0), answerLines.length - 1))
    .filter((row, i, all) => all.indexOf(row) === i)
    .slice(0, MAX_REPORTED)
    .map((row) => `answer line ${row + 1}: ${answerLines[row].trim()}`);
  const missingStrings = pythonStringLiterals(pyLines.slice(block.start - 1, block.end))
    .filter((lit) => !answer.includes(lit.text))
    .slice(0, MAX_REPORTED)
    .map((lit) => `"${lit.text}" (Python line ${block.start + lit.line - 1})`);
  return { syntax, missingStrings };
}

/** The follow-up message that shows the model its own answer and what is wrong with it. */
function retryMessage(user: string, previous: string, problems: AnswerProblems): string {
  const items = [
    ...problems.syntax.map((p) => `not valid Java, ${p}`),
    ...problems.missingStrings.map((p) => `the string literal ${p} is missing`),
  ];
  return `${user}\n\nYour previous answer:\n${previous}\n\nProblems found in it:\n${items.map((i) => `- ${i}`).join('\n')}\n\nFix these problems and output the whole function again, in the same format.`;
}

export class HybridTranslator implements Translator {
  readonly name = 'hybrid' as const;
  private readonly cache = new Map<string, string>();
  private cacheLoaded = false;
  private unreachableUntil = 0;

  constructor(
    private readonly rules: Translator = new RuleBasedTranslator(),
    private readonly options: OllamaOptions = DEFAULT_OLLAMA_OPTIONS,
    private readonly chat: ChatFn = ollamaChat,
  ) {}

  async translate(input: TranslateInput): Promise<TranslateResult> {
    // The Python-shaped imports are resolved below, with the model for what the index cannot.
    const base = await this.rules.translate({ ...input, pythonImports: true });
    const warnings = [...base.warnings];
    let view: JavaView = base;
    let usedModel = false;

    const rewritten = await this.rewriteHardFunctions(input, base, warnings);
    if (rewritten) {
      view = rewritten;
      usedModel = true;
    }
    if (this.options.resolveImports !== false) {
      const resolved = await this.resolveImports(input, view, warnings);
      view = resolved.view;
      usedModel ||= resolved.usedModel;
    }

    const lines = view.java.split('\n');
    if (usedModel && lines[1]) lines[1] = lines[1].replace('(rules engine)', `(rules engine + ${this.options.model})`);
    return { java: lines.join('\n'), sourceMap: view.sourceMap, symbols: view.symbols, warnings, engine: 'hybrid' };
  }

  /** The rules output with each hard function replaced by the model's rewrite, or undefined when none was rewritten. */
  private async rewriteHardFunctions(input: TranslateInput, base: TranslateResult, warnings: string[]): Promise<JavaView | undefined> {
    const javaLines = base.java.split('\n');

    const warningLines = new Set<number>();
    for (const w of base.warnings) {
      const m = /:(\d+): /.exec(w);
      if (m) warningLines.add(Number(m[1]));
    }
    const todoLines = new Set<number>();
    javaLines.forEach((l, i) => {
      if (l.includes('TODO: untranslated') && base.sourceMap[i]) todoLines.add(base.sourceMap[i]);
    });

    const blocks = findHardBlocks(input.source, warningLines, todoLines);
    if (!blocks.length) return undefined;

    const pyLines = input.source.split(/\r?\n/);
    let lines = javaLines;
    let map = base.sourceMap;
    let symbols: SymbolInfo[] = base.symbols;
    let rewritten = 0;

    // Bottom-up, so earlier blocks keep their line numbers while later ones are spliced.
    for (const block of blocks.slice(0, this.options.maxBlocksPerFile).reverse()) {
      if (Date.now() < this.unreachableUntil) break;
      const range = locateJavaBlock(lines, map, block);
      if (!range) continue;
      const [a, b] = range;
      // Sanity: everything in the block must belong to this Python function (or be synthetic).
      if (map.slice(a, b + 1).some((py) => py !== 0 && (py < block.start || py > block.end))) continue;

      try {
        const answer = await this.rewrite(input, block, pyLines, lines.slice(a, b + 1), warnings, problemsFor(block, base.warnings, javaLines, base.sourceMap, pyLines));
        const indent = /^\s*/.exec(lines[a])![0];
        const parsed = parseAnswer(answer, block.defLine, indent);
        const note = `${indent}// Rewritten by ${this.options.model} (${block.reason}); check against the Python.`;
        const newLines = [note, ...parsed.lines];
        const newMap = [0, ...parsed.map];
        const delta = newLines.length - (b - a + 1);

        symbols = symbols.flatMap((s) => {
          if (s.javaLine < a) return [s];
          if (s.javaLine > b) return [{ ...s, javaLine: s.javaLine + delta }];
          const at = newMap.findIndex((py, k) => k > 0 && py === s.pythonLine);
          return at < 0 ? [] : [{ ...s, javaLine: a + at }];
        });
        lines = [...lines.slice(0, a), ...newLines, ...lines.slice(b + 1)];
        map = [...map.slice(0, a), ...newMap, ...map.slice(b + 1)];
        rewritten += 1;
      } catch (err) {
        this.recordFailure(err, warnings, `${input.relativePath}:${block.defLine}: kept the rules translation of ${block.name}()`);
        if (err instanceof OllamaError && err.unreachable) break;
      }
    }
    return rewritten ? { java: lines.join('\n'), sourceMap: map, symbols } : undefined;
  }

  /**
   * Swap the rules' Python-shaped imports for real Java ones. What the JDK index and the project
   * scan resolve needs no model; only the names left over are sent, and the answer is verified.
   */
  private async resolveImports(input: TranslateInput, view: JavaView, warnings: string[]): Promise<{ view: JavaView; usedModel: boolean }> {
    const modules = input.knownMembers?.modules ?? {};
    const plan = planImports(view, input.source, modules, input.knownMembers?.classes, input.basePackage);
    let fromModel: ModelImports | undefined;
    if (askable(plan).length && Date.now() >= this.unreachableUntil) {
      try {
        const answer = await this.ask(IMPORTS_SYSTEM_PROMPT, importsPrompt(input.relativePath, plan), (text) => text.trim().length > 0);
        fromModel = acceptModelImports(answer, plan, modules);
        if (fromModel.rejected.length) {
          warnings.push(`${input.relativePath}: ignored imports suggested by ${this.options.model}: ${fromModel.rejected.join('; ')}`);
        }
      } catch (err) {
        this.recordFailure(err, warnings, `${input.relativePath}: could not ask for the missing Java imports`);
      }
    }
    const found = new Set([...(fromModel?.jdk ?? []), ...(fromModel?.library ?? [])].map((f) => f.split('.').pop()!));
    // Decorators kept as annotations are only listed in the view; a warning per file would be noise.
    const missing = askable(plan).filter((u) => !found.has(u.name)).map((u) => u.name);
    if (missing.length) warnings.push(`${input.relativePath}: no Java import found for ${missing.join(', ')}`);
    const usedModel = Boolean(fromModel && fromModel.jdk.length + fromModel.library.length);
    return { view: applyImports(view, plan, renderImports(plan, fromModel, this.options.model)), usedModel };
  }

  /** Record a failed model call as a warning; an unreachable server pauses further calls for a while. */
  private recordFailure(err: unknown, warnings: string[], what: string): void {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`${what}: ${msg}`);
    if (err instanceof OllamaError && err.unreachable) this.unreachableUntil = Date.now() + UNREACHABLE_BACKOFF_MS;
  }

  /** The model's cleaned answer for one function, from the cache when possible. */
  private async rewrite(input: TranslateInput, block: PythonBlock, pyLines: string[], draft: string[], warnings: string[], problems: string[]): Promise<string> {
    const numbered = pyLines
      .slice(block.start - 1, block.end)
      .map((l, i) => `${String(block.start + i).padStart(4)} | ${l}`)
      .join('\n');
    const functionText = pyLines.slice(block.start - 1, block.end).join('\n');
    const context = contextFor(input.knownMembers, enclosingClass(pyLines, block.defLine), functionText);
    const wrong = problems.length ? problems.map((p) => `- ${p}`).join('\n') : `- ${block.reason}`;
    const user =
      `File: ${input.relativePath}\n` +
      (context ? `\n${context}\n` : '') +
      `\nWhat went wrong in the draft:\n${wrong}\n` +
      `\nPython function:\n${numbered}\n\nRule-based draft:\n${draft.join('\n')}`;

    const system = systemPrompt();
    const first = await this.ask(system, user, looksLikeJava);
    const found = await checkAnswer(first, block, pyLines);
    if (!found.syntax.length && !found.missingStrings.length) return first;

    // One retry, showing the model what is wrong with its own answer.
    const second = await this.ask(system, retryMessage(user, first, found), looksLikeJava);
    const left = await checkAnswer(second, block, pyLines);
    if (left.syntax.length) throw new Error(`the model's answer still is not valid Java (${left.syntax[0]})`);
    if (left.missingStrings.length) {
      warnings.push(`${input.relativePath}:${block.defLine}: ${block.name}() rewritten by ${this.options.model} lacks the string literal ${left.missingStrings.join(', ')}; check against the Python`);
    }
    return second;
  }

  /** The model's cleaned answer to one prompt, from the cache when possible; `usable` rejects bad answers before they are cached. */
  private async ask(system: string, user: string, usable: (answer: string) => boolean): Promise<string> {
    const key = crypto.createHash('sha1').update(`${this.options.model}\n${system}\n${user}`).digest('hex');
    this.loadCache();
    const cached = this.cache.get(key);
    if (cached) return cached;

    const answer = cleanAnswer(await this.chat(this.options, system, user));
    if (!usable(answer)) throw new Error('the model returned text that is not usable Java');
    this.cache.set(key, answer);
    this.saveCache();
    return answer;
  }

  private loadCache(): void {
    if (this.cacheLoaded) return;
    this.cacheLoaded = true;
    if (!this.options.cacheFile) return;
    try {
      const data = JSON.parse(fs.readFileSync(this.options.cacheFile, 'utf8')) as CacheFile;
      for (const [k, v] of Object.entries(data)) this.cache.set(k, v);
    } catch {
      // No cache yet, or unreadable: start empty.
    }
  }

  private saveCache(): void {
    const file = this.options.cacheFile;
    if (!file) return;
    try {
      // Drop the oldest entries (Map keeps insertion order) when the cache grows too large.
      while (this.cache.size > MAX_CACHE_ENTRIES) this.cache.delete(this.cache.keys().next().value as string);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.cache)), 'utf8');
      fs.renameSync(tmp, file);
    } catch {
      // The cache is an optimisation only.
    }
  }
}
