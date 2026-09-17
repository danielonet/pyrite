/**
 * Splits Python source into *logical lines*.
 *
 * Python statements may span several physical lines (open brackets, backslash
 * continuations, triple-quoted strings). The translator works on logical lines,
 * each of which remembers the physical line range it came from.
 */

export type LogicalKind = 'code' | 'blank' | 'comment';

export interface LogicalLine {
  kind: LogicalKind;
  /** Statement text with continuation newlines collapsed to single spaces (strings preserved). */
  text: string;
  /** Indentation in spaces (tabs count as 4). */
  indent: number;
  /** 1-based first physical line. */
  startLine: number;
  /** 1-based last physical line. */
  endLine: number;
  /**
   * `# comments` found on the physical lines of a multi-line statement (outside strings),
   * in order. They are lifted out of `text` so a comment inside a bracketed literal cannot
   * be mistaken for the end of the statement.
   */
  comments?: string[];
}

function indentOf(line: string): number {
  let n = 0;
  for (const ch of line) {
    if (ch === ' ') n += 1;
    else if (ch === '\t') n += 4;
    else break;
  }
  return n;
}

interface ScanState {
  depth: number;
  /** Open string delimiter (', ", ''' or """) or null. */
  str: string | null;
}

/** Scan a chunk of text updating string/bracket state. */
function scan(text: string, state: ScanState): ScanState {
  let { depth, str } = state;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (str) {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (text.startsWith(str, i)) {
        i += str.length;
        str = null;
        continue;
      }
      i += 1;
      continue;
    }
    if (ch === '#') {
      break; // rest of physical line is a comment
    }
    if (ch === '"' || ch === "'") {
      const triple = ch.repeat(3);
      if (text.startsWith(triple, i)) {
        str = triple;
        i += 3;
      } else {
        str = ch;
        i += 1;
      }
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
    i += 1;
  }
  // A single-quoted string cannot legally span lines; reset so a stray quote never
  // swallows the rest of the file.
  if (str === '"' || str === "'") str = null;
  return { depth, str };
}

export function splitLogicalLines(source: string): LogicalLine[] {
  const physical = source.replace(/\r\n?/g, '\n').split('\n');
  const result: LogicalLine[] = [];

  let i = 0;
  while (i < physical.length) {
    const first = physical[i];
    const trimmed = first.trim();
    if (trimmed === '') {
      result.push({ kind: 'blank', text: '', indent: 0, startLine: i + 1, endLine: i + 1 });
      i += 1;
      continue;
    }
    if (trimmed.startsWith('#')) {
      result.push({ kind: 'comment', text: trimmed, indent: indentOf(first), startLine: i + 1, endLine: i + 1 });
      i += 1;
      continue;
    }

    const start = i;
    let state: ScanState = { depth: 0, str: null };
    const parts: string[] = [];
    let current = first;
    for (;;) {
      state = scan(current, state);
      const continued = state.depth > 0 || state.str !== null || /\\\s*$/.test(current.replace(/#.*$/, ''));
      parts.push(current);
      if (!continued || i + 1 >= physical.length) break;
      i += 1;
      current = physical[i];
    }

    const joined = joinParts(parts);
    const line: LogicalLine = { kind: 'code', text: joined.text, indent: indentOf(first), startLine: start + 1, endLine: i + 1 };
    if (joined.comments.length) line.comments = joined.comments;
    result.push(line);
    i += 1;
  }
  return result;
}

/** Split one physical line into code and its trailing `# comment`, given the string state it starts in. */
function splitOffComment(text: string, state: ScanState): { code: string; comment?: string } {
  let str = state.str;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (str) {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (text.startsWith(str, i)) {
        i += str.length;
        str = null;
        continue;
      }
      i += 1;
      continue;
    }
    if (ch === '#') return { code: text.slice(0, i), comment: text.slice(i + 1).trim() };
    if (ch === '"' || ch === "'") {
      const triple = ch.repeat(3);
      str = text.startsWith(triple, i) ? triple : ch;
      i += str.length;
      continue;
    }
    i += 1;
  }
  return { code: text };
}

/**
 * Join physical lines of one logical line. Inside triple-quoted strings we keep the
 * real newlines (they matter for text blocks); elsewhere we collapse to one space
 * and drop backslash continuations. Comments on the joined lines are lifted out
 * (a single-line statement keeps its trailing comment in `text`).
 */
function joinParts(parts: string[]): { text: string; comments: string[] } {
  if (parts.length === 1) return { text: parts[0].trim(), comments: [] };
  let out = '';
  const comments: string[] = [];
  let state: ScanState = { depth: 0, str: null };
  for (let idx = 0; idx < parts.length; idx += 1) {
    const raw = idx === 0 ? parts[idx].trim() : parts[idx];
    const inTriple = state.str === '"""' || state.str === "'''";
    if (idx > 0) {
      out += inTriple ? '\n' : ' ';
    }
    let piece = inTriple ? raw : raw.trim();
    if (!inTriple) {
      const split = splitOffComment(piece, state);
      if (split.comment !== undefined) {
        if (split.comment) comments.push(split.comment);
        piece = split.code.replace(/\s+$/, '');
      }
      piece = piece.replace(/\\\s*$/, '');
    }
    out += piece;
    state = scan(raw, state);
  }
  return { text: out.replace(/[ \t]+$/g, ''), comments };
}
