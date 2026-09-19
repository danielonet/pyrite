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
import { RuleBasedTranslator } from '../rules/ruleTranslator';
import { SymbolInfo, TranslateInput, TranslateResult, Translator } from '../types';
import { findHardBlocks, PythonBlock } from './hardBlocks';
import { ChatFn, OllamaConnection, OllamaError, ollamaChat } from './ollamaClient';

export interface OllamaOptions extends OllamaConnection {
  /** Upper bound on functions sent to the model per file (the rest keep the rules output). */
  maxBlocksPerFile: number;
  /** JSON file caching model answers, so unchanged functions are not sent again. Optional. */
  cacheFile?: string;
}

export const DEFAULT_OLLAMA_OPTIONS: OllamaOptions = {
  url: 'http://localhost:11434',
  model: 'qwen2.5-coder:7b',
  timeoutMs: 300_000,
  maxBlocksPerFile: 10,
};

const UNREACHABLE_BACKOFF_MS = 60_000;
const MAX_CACHE_ENTRIES = 2000;

export const SYSTEM_PROMPT = `You rewrite ONE Python function as a Java-flavored *reading view* for Java developers who do not know Python.
You are given the Python function and a draft produced by a rule-based translator. The draft is right about names, types and structure but got this function wrong or left part of it untranslated. Fix that.

Rules:
1. Faithfulness first: keep every statement, name, string and comment. Do not summarize, reorder, drop code or add behavior.
2. Java syntax: braces, semicolons, explicit types (infer from hints and usage; use var or Object when unknown), comments as // comments.
3. Keep the function's name, parameters and modifiers exactly as in the draft. Output the single function only: no enclosing class, no imports.
4. Keep snake_case identifiers as in Python. Idioms: comprehensions -> streams, f-strings -> concatenation or String.format, dict -> Map, list -> List, None -> null, raise -> throw new, with -> try-with-resources, generators -> a comment plus the closest Java form, async/await kept as comments.
5. When something has no Java equivalent, keep it as close to Java as possible and add a short /* python: ... */ comment. Never silently drop it. The output does NOT need to compile.
6. End every method header, class header and control-flow header line (if/for/while/try/with/else/catch) with a marker comment "// py:N" where N is the 1-based Python line number shown to the left of the code. Add no other markers.
7. Output only the Java text, no Markdown fences and no explanations.`;

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
    const base = await this.rules.translate(input);
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
    if (!blocks.length) return { ...base, engine: 'hybrid' };

    const pyLines = input.source.split(/\r?\n/);
    let lines = javaLines;
    let map = base.sourceMap;
    let symbols: SymbolInfo[] = base.symbols;
    const warnings = [...base.warnings];
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
        const answer = await this.rewrite(input, block, pyLines, lines.slice(a, b + 1));
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
        const msg = err instanceof Error ? err.message : String(err);
        warnings.push(`${input.relativePath}:${block.defLine}: kept the rules translation of ${block.name}(): ${msg}`);
        if (err instanceof OllamaError && err.unreachable) {
          this.unreachableUntil = Date.now() + UNREACHABLE_BACKOFF_MS;
          break;
        }
      }
    }

    if (rewritten && lines[1]) lines[1] = lines[1].replace('(rules engine)', `(rules engine + ${this.options.model})`);
    return { java: lines.join('\n'), sourceMap: map, symbols, warnings, engine: 'hybrid' };
  }

  /** The model's cleaned answer for one function, from the cache when possible. */
  private async rewrite(input: TranslateInput, block: PythonBlock, pyLines: string[], draft: string[]): Promise<string> {
    const numbered = pyLines
      .slice(block.start - 1, block.end)
      .map((l, i) => `${String(block.start + i).padStart(4)} | ${l}`)
      .join('\n');
    const draftText = draft.join('\n');
    const user = `File: ${input.relativePath}\nReason for rewrite: ${block.reason}\n\nPython function:\n${numbered}\n\nRule-based draft:\n${draftText}`;

    const key = crypto.createHash('sha1').update(`${this.options.model}\n${SYSTEM_PROMPT}\n${user}`).digest('hex');
    this.loadCache();
    const cached = this.cache.get(key);
    if (cached) return cached;

    const answer = cleanAnswer(await this.chat(this.options, SYSTEM_PROMPT, user));
    if (!looksLikeJava(answer)) throw new Error('the model returned text that is not usable Java');
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
