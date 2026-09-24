/**
 * Finds the Python functions the rules engine is unlikely to have translated well, so the
 * hybrid engine can hand just those to the local LLM.
 *
 * A function is "hard" only when the rules demonstrably fail on it: the rules engine flagged
 * something inside it (a warning, or an `untranslated` marker), or it uses a construct the
 * line-oriented rules are known to get wrong (nested comprehensions, assignment expressions).
 * Constructs the rules already translate acceptably (generators, async/await, lambdas,
 * exec/eval: each is kept and annotated) do NOT qualify, so most functions, and most files,
 * never touch the model.
 */

import { splitLogicalLines } from '../rules/logicalLines';

export interface PythonBlock {
  /** 1-based first line, including any decorators. */
  start: number;
  /** 1-based last line. */
  end: number;
  /** 1-based line of the `def` itself. */
  defLine: number;
  name: string;
  /** Why it was picked, for the output note. */
  reason: string;
}

/** Replace string literal contents so keywords inside strings do not count. */
function stripStrings(text: string): string {
  return text.replace(/([rbfRBF]{0,2})(["'])(?:\\.|(?!\2).)*\2/g, '""');
}

const COMPLEX_PATTERNS: { re: RegExp; reason: string }[] = [
  { re: /^[^#]*[[({][^\])}]*\bfor\b[^\])}]*\bfor\b/, reason: 'nested comprehension' },
  { re: /:=/, reason: 'assignment expression' },
];

/**
 * Outermost `def` blocks that look hard to translate.
 *
 * @param source     the Python source
 * @param warningLines Python lines the rules engine attached warnings to
 * @param todoLines  Python lines whose rules output carries an `untranslated` marker
 */
export function findHardBlocks(source: string, warningLines: Set<number>, todoLines: Set<number>): PythonBlock[] {
  const lines = splitLogicalLines(source);
  const blocks: PythonBlock[] = [];
  let coveredUntil = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const head = lines[i];
    if (head.kind !== 'code' || head.startLine <= coveredUntil) continue;
    const m = /^(?:async\s+)?def\s+([A-Za-z_]\w*)/.exec(head.text);
    if (!m) continue;

    // Body: everything after the header that is indented deeper (blank/comment lines included).
    let last = i;
    for (let j = i + 1; j < lines.length; j += 1) {
      const l = lines[j];
      if (l.kind === 'blank') continue;
      if (l.kind === 'code' && l.indent <= head.indent) break;
      if (l.kind === 'comment' && l.indent <= head.indent) break;
      last = j;
    }
    const end = lines[last].endLine;

    // Decorators sit directly above the def.
    let start = head.startLine;
    for (let k = i - 1; k >= 0 && lines[k].kind === 'code' && lines[k].text.startsWith('@') && lines[k].indent === head.indent; k -= 1) {
      start = lines[k].startLine;
    }

    let reason = '';
    for (let ln = start; ln <= end && !reason; ln += 1) {
      if (todoLines.has(ln)) reason = 'the rules could not translate a statement';
      else if (warningLines.has(ln)) reason = 'the rules reported a warning';
    }
    for (let j = i; j <= last && !reason; j += 1) {
      if (lines[j].kind !== 'code') continue;
      const text = stripStrings(lines[j].text);
      reason = COMPLEX_PATTERNS.find((p) => p.re.test(text))?.reason ?? '';
    }
    if (!reason) continue;

    blocks.push({ start, end, defLine: head.startLine, name: m[1], reason });
    coveredUntil = end;
  }
  return blocks;
}
