/**
 * Parse gate: one generated statement that is not valid Java must not poison the whole file.
 *
 * The Java view is parsed with tree-sitter-java. Each statement around a syntax error is
 * replaced by a stub that parses, keeps the original text as a comment and names the Python
 * source it came from:
 *
 *   var (a, b) = pair; // tuple unpacking
 *   ->
 *   if (true) throw new UnsupportedOperationException("TODO(pyrite): a, b = pair"); // was: var (a, b) = pair; // tuple unpacking
 *
 * The line count never changes, so the source map and the symbol lines stay right. The file is
 * parsed again after each round of stubs, because one error can hide the next.
 */

import { javaErrorRows } from '../parser/javaParser';
import { TranslateResult } from './types';

/** `stub` replaces invalid statements; `keep` leaves the text alone and only reports them. */
export type InvalidJavaMode = 'stub' | 'keep';

export interface ParseGateOutcome {
  result: TranslateResult;
  /** Statements replaced by a stub. */
  stubbed: number;
  /** Rows that are still not valid Java afterwards (all of them in `keep` mode). */
  remaining: number;
}

const MAX_ROUNDS = 12;
/** Error rows this close after a statement stubbed in the same round are usually its echo. */
const CASCADE_ROWS = 2;
/**
 * `super(...)` / `this(...)` after other statements in a constructor: tree-sitter-java follows
 * the pre-Java 25 rule, but flexible constructor bodies (JEP 513, Java 25) allow it.
 */
const CONSTRUCTOR_CALL = /^\s*(?:super|this)\(.*\);/;
const MAX_PYTHON_IN_STUB = 100;
/** Python text kept in a stub message even when the line gets long. */
const MIN_PYTHON_IN_STUB = 30;
const WAS = ' // was: ';

/**
 * Code of a Java line without comments: a trailing `//` comment and complete inline
 * `/* ... *\/` comments are dropped (string and char literals respected). An unclosed `/*`
 * is kept, so a line that opens a block comment still reads as a comment line.
 */
function codePart(line: string): string {
  let quote = '';
  let out = '';
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      if (ch === '\\') {
        out += ch + (line[i + 1] ?? '');
        i += 1;
        continue;
      }
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '/' && line[i + 1] === '/') return out;
    else if (ch === '/' && line[i + 1] === '*') {
      const close = line.indexOf('*/', i + 2);
      if (close < 0) return out + line.slice(i);
      i = close + 1;
      continue;
    }
    out += ch;
  }
  return out;
}

/** Whether a line completes a statement or a block boundary (so the next line starts a new one). */
function endsStatement(line: string): boolean {
  const code = codePart(line).trim();
  return code === '' || /[;{}]$/.test(code) || /^(\/\*|\*)/.test(code);
}

/** The first and last row of the (possibly wrapped) statement that contains `row`. */
function statementExtent(lines: string[], row: number): [number, number] {
  let start = row;
  while (start > 0 && !endsStatement(lines[start - 1])) start -= 1;
  let end = row;
  while (end < lines.length - 1 && !endsStatement(lines[end])) end += 1;
  return [start, end];
}

/** Whether `row` sits directly in a class/interface/enum body rather than in a method body. */
function atClassLevel(lines: string[], row: number): boolean {
  const indent = /^\s*/.exec(lines[row])![0].length;
  for (let r = row - 1; r >= 0; r -= 1) {
    const code = codePart(lines[r]).trim();
    if (code === '') continue;
    const ind = /^\s*/.exec(lines[r])![0].length;
    if (ind < indent && code.endsWith('{')) return /\b(class|interface|enum|record)\b/.test(code) && !/[=;]/.test(code);
  }
  return true; // top level of the file
}

/** Java string-literal escape. Doubling backslashes also defuses `\u` (Java pre-lexes unicode escapes). */
function javaString(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\u0000-\u001f\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** The Python statement behind rows `start..end`, from the source map, shortened to one line. */
function pythonOf(result: TranslateResult, pyLines: string[], start: number, end: number): string {
  for (let r = start; r <= end; r += 1) {
    const py = result.sourceMap[r];
    if (py > 0 && pyLines[py - 1] !== undefined) {
      const text = pyLines[py - 1].trim();
      return text.length > MAX_PYTHON_IN_STUB ? `${text.slice(0, MAX_PYTHON_IN_STUB)}...` : text;
    }
  }
  return 'see the Python source';
}

/** `text` cut to `max` characters with `...`, never ending in half a `\\uXXXX` escape. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3)).replace(/\\+u*[0-9a-fA-F]{0,3}$/, '')}...`;
}

/**
 * A stub line made to fit `width` columns (0 = no limit): its trailing `// was:` comment is
 * shortened, or dropped when even a short version does not fit; a comment-only line is cut.
 */
function fitWidth(line: string, width: number): string {
  if (width <= 0 || line.length <= width) return line;
  const at = line.indexOf(WAS);
  // Code is never cut: a stub that is still too long stays valid Java rather than short.
  if (at < 0) return /^\s*\/\//.test(line) ? cut(line, width) : line;
  const hasCode = line.slice(0, at).trim() !== '';
  if (!hasCode) return cut(line, width);
  if (at + WAS.length + 10 <= width) return cut(line, width);
  return line.slice(0, at);
}

/** The stub statement for `python`, with the Python text shortened so the line fits `room` columns. */
function todoStatement(python: string, room: number): string {
  const make = (py: string) => `throw new UnsupportedOperationException("TODO(pyrite): ${javaString(py)}");`;
  let py = python;
  while (room > 0 && make(py).length > room && py.length > MIN_PYTHON_IN_STUB) py = cut(py, Math.max(MIN_PYTHON_IN_STUB, py.length - Math.max(4, make(py).length - room)));
  return make(py);
}

/**
 * Replace the statement at rows `start..end` with a stub that parses; false when it cannot.
 * `attempt` counts earlier stubs of the same statement that still did not parse.
 */
function stubStatement(lines: string[], start: number, end: number, python: string, attempt: number, width: number): boolean {
  const indent = /^\s*/.exec(lines[start])![0];
  const first = lines[start].trim();
  const isHeader = codePart(lines[end]).trim().endsWith('{');
  // Never stub a type declaration (its body is where the stubs go), nor a lone `}` statement.
  if (isHeader && /^(?:(?:public|protected|private|static|final|abstract|sealed)\s+)*(?:class|interface|enum|record|@interface)\b/.test(first)) return false;
  if (!isHeader && first.startsWith('}')) return false;

  const was = (l: string) => `// was: ${l.trim()}`;
  const wrapped = end > start;
  // A wrapped statement keeps its text on the continuation lines; the first of them also takes
  // the original first line, which leaves the stub line room for the Python source.
  for (let r = start + 1; r <= end; r += 1) {
    const text = r === start + 1 ? `${first}${/^\s*\./.test(lines[r]) ? '' : ' '}${lines[r].trim()}` : lines[r];
    lines[r] = `${/^\s*/.exec(lines[r])![0]}${was(text)}`;
  }
  const trailing = wrapped ? '' : ` ${was(first)}`;
  // `{ if (true) ` is the longest prefix a stub gets.
  const todo = todoStatement(python, width > 0 ? width - indent.length - '{ if (true) '.length : 0);

  if (isHeader) {
    // A block header: open a plain block instead, so the body and its closing brace still fit.
    if (first.startsWith('}')) {
      // `} catch (A | A e) {`: a valid catch keeps the try intact. Anything else, or a catch
      // whose try is gone, or Python's loop-else / try-else rendered as `} else {`: close the
      // previous block and open a plain one, keeping the body.
      // On a second attempt the line already ends in `// was: <original>`; keep that original.
      const wasPart = attempt > 0 && first.includes('// was: ') ? ` ${first.slice(first.indexOf('// was: '))}` : trailing;
      lines[start] = attempt === 0 && /^}\s*catch\b/.test(first) ? `${indent}} catch (RuntimeException todo) {${wasPart}` : `${indent}} {${wasPart}`;
      return true;
    }
    // In a class body a plain `{` is an initializer block; in a method it is a nested block.
    lines[start] = atClassLevel(lines, start) ? `${indent}{${trailing}` : `${indent}{ if (true) ${todo}${trailing}`;
    return true;
  }
  lines[start] = atClassLevel(lines, start)
    ? `${indent}// TODO(pyrite): not valid Java: ${first}`
    : `${indent}if (true) ${todo}${trailing}`;
  return true;
}

/**
 * Run the parse gate over a translation. Returns it unchanged when tree-sitter-java is not
 * available. `pythonSource` is the file the translation came from (for the stub messages);
 * stub lines are kept within `lineWidth` columns like the rest of the view (0 = no limit).
 */
export async function applyParseGate(result: TranslateResult, pythonSource: string, mode: InvalidJavaMode = 'stub', lineWidth = 120): Promise<ParseGateOutcome> {
  const errorRows = async (text: string, lines: string[]): Promise<number[] | undefined> =>
    (await javaErrorRows(text))?.filter((row) => !CONSTRUCTOR_CALL.test(lines[row] ?? ''));
  let rows = await errorRows(result.java, result.java.split('\n'));
  if (!rows || rows.length === 0) return { result, stubbed: 0, remaining: 0 };
  if (mode === 'keep') return { result, stubbed: 0, remaining: rows.length };

  const lines = result.java.split('\n');
  const pyLines = pythonSource.split('\n');
  const attempts = new Map<number, number>();
  let stubbed = 0;
  for (let round = 0; round < MAX_ROUNDS && rows.length > 0; round += 1) {
    let changed = false;
    let lastEnd = -Infinity;
    for (const row of rows) {
      if (row >= lines.length) continue;
      // Parsed again next round: if the statement is really wrong it is still reported then.
      if (row <= lastEnd + CASCADE_ROWS) continue;
      const [start, end] = statementExtent(lines, row);
      const attempt = attempts.get(start) ?? 0;
      // A block header that already became `} {` (or any statement stubbed twice) is final.
      if (attempt >= 2 || codePart(lines[start]).trim() === '') continue;
      if (attempt === 1 && !/^\s*}/.test(lines[start])) continue;
      attempts.set(start, attempt + 1);
      if (stubStatement(lines, start, end, pythonOf(result, pyLines, start, end), attempt, lineWidth)) {
        for (let r = start; r <= end; r += 1) lines[r] = fitWidth(lines[r], lineWidth);
        if (attempt === 0) stubbed += 1;
        changed = true;
        lastEnd = end;
      }
    }
    if (!changed) break;
    rows = (await errorRows(lines.join('\n'), lines)) ?? [];
  }
  return { result: { ...result, java: lines.join('\n') }, stubbed, remaining: rows.length };
}
