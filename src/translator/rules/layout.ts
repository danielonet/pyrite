/**
 * Line wrapping for the generated Java, in the style of the IntelliJ IDEA defaults and
 * palantir-java-format: a 120-column limit, 4-space indentation, 8-space continuation
 * indentation, and "chop down if long".
 *
 *  - A declaration or call whose arguments do not fit puts each argument on its own line,
 *    with the closing parenthesis on the last one:
 *
 *        public Order place_order(
 *                int customer_id,
 *                Map<String, Integer> items) {
 *
 *  - `&&`, `||` and the ternary break before the operator, one operand per line.
 *  - String concatenation breaks before `+`, packing as many operands per line as fit.
 *  - A method chain breaks before each `.call()` that follows a call.
 *  - A trailing `// comment` that pushes a line over the limit moves onto its own line.
 *  - Javadoc and `//` comment prose is re-flowed to the limit.
 *
 * Anything that cannot be broken without changing meaning (a long string literal, a text
 * block, a URL in a comment) is left as it is. Only whitespace and line breaks are added.
 */

export const DEFAULT_LINE_WIDTH = 120;
const CONTINUATION = '        ';

export interface Formatted {
  /** The line, possibly now spanning several physical lines joined with `\n`. */
  text: string;
  /** How many physical lines precede the one holding the original statement's start (a comment moved above it). */
  lead: number;
}

interface Scan {
  /** Bracket depth at each index; an opening bracket has the outer depth. */
  depth: number[];
  /** False inside strings, character literals and comments. */
  code: boolean[];
  /** Index of a trailing `//` comment, or -1. */
  lineComment: number;
}

/** Bracket depth and code/non-code for every character of one Java line. */
function scanJava(text: string): Scan {
  const n = text.length;
  const depth = new Array<number>(n);
  const code = new Array<boolean>(n);
  const stack: string[] = [];
  let lineComment = -1;
  const mark = (from: number, to: number, isCode: boolean) => {
    for (let k = from; k < to && k < n; k += 1) {
      depth[k] = stack.length;
      code[k] = isCode;
    }
  };
  let i = 0;
  while (i < n) {
    const ch = text[i];
    if (ch === '/' && text[i + 1] === '*') {
      const e = text.indexOf('*/', i + 2);
      const end = e < 0 ? n : e + 2;
      mark(i, end, false);
      i = end;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      lineComment = i;
      mark(i, n, false);
      break;
    }
    if (ch === '"' || ch === "'") {
      let end: number;
      if (ch === '"' && text.startsWith('"""', i)) {
        const e = text.indexOf('"""', i + 3);
        end = e < 0 ? n : e + 3;
      } else {
        end = i + 1;
        while (end < n && text[end] !== ch) end += text[end] === '\\' ? 2 : 1;
        end = Math.min(n, end + 1);
      }
      mark(i, end, false);
      i = end;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') {
      mark(i, i + 1, true);
      stack.push(ch);
    } else if (ch === ')' || ch === ']' || ch === '}') {
      while (stack.length && stack[stack.length - 1] === '<') stack.pop();
      stack.pop();
      mark(i, i + 1, true);
    } else if (ch === '<' && /\w/.test(text[i - 1] ?? '') && /[\w?]/.test(text[i + 1] ?? '')) {
      // `Map<String, Object>` - a comparison is always written with spaces (`i < n`).
      mark(i, i + 1, true);
      stack.push('<');
    } else if (ch === '>' && stack[stack.length - 1] === '<' && text[i - 1] !== '-' && text[i - 1] !== ' ') {
      stack.pop();
      mark(i, i + 1, true);
    } else {
      mark(i, i + 1, true);
    }
    i += 1;
  }
  return { depth, code, lineComment };
}

/** Start indexes of `needle` at depth 0 in code (not in strings or comments). */
function topLevel(text: string, scan: Scan, needle: string): number[] {
  const hits: number[] = [];
  for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + 1)) {
    let ok = true;
    for (let k = i; k < i + needle.length; k += 1) {
      if (!scan.code[k] || scan.depth[k] !== 0) {
        ok = false;
        break;
      }
    }
    if (ok) hits.push(i);
  }
  return hits;
}

/** Split at top-level occurrences of `needle`, dropping the needle. */
function splitAt(text: string, needle: string): string[] {
  const scan = scanJava(text);
  const cuts = topLevel(text, scan, needle);
  const parts: string[] = [];
  let from = 0;
  for (const c of cuts) {
    parts.push(text.slice(from, c).trim());
    from = c + needle.length;
  }
  parts.push(text.slice(from).trim());
  return parts;
}

/** Greedy word wrap of prose, each line starting with `prefix`. */
function wrapWords(words: string[], prefix: string, width: number): string[] {
  const lines: string[] = [];
  let current = '';
  for (const w of words) {
    if (current && prefix.length + current.length + 1 + w.length > width) {
      lines.push(prefix + current);
      current = w;
    } else {
      current = current ? `${current} ${w}` : w;
    }
  }
  if (current) lines.push(prefix + current);
  return lines;
}

class Wrapper {
  constructor(private readonly width: number) {}

  private fits(line: string): boolean {
    return line.length <= this.width;
  }

  /**
   * Lines for `expr`, where the first line starts with `indent + prefix` and the last ends
   * with `suffix`. Continuation lines are indented one continuation step deeper.
   */
  expr(expr: string, indent: string, prefix: string, suffix: string): string[] {
    const oneLine = indent + prefix + expr + suffix;
    if (this.fits(oneLine)) return [oneLine];
    const cont = indent + CONTINUATION;
    const scan = scanJava(expr);

    // A lambda keeps its parameters with whatever precedes it: wrap its body.
    const arrow = topLevel(expr, scan, ' -> ')[0];
    if (arrow !== undefined) {
      return this.expr(expr.slice(arrow + 4), indent, `${prefix}${expr.slice(0, arrow)} -> `, suffix);
    }

    // Ternary: break before `?` and `:`.
    const q = topLevel(expr, scan, ' ? ')[0];
    if (q !== undefined) {
      const colon = topLevel(expr, scan, ' : ').find((c) => c > q);
      if (colon !== undefined) {
        return [
          ...this.expr(expr.slice(0, q), indent, prefix, ''),
          ...this.expr(expr.slice(q + 3, colon), cont, '? ', ''),
          ...this.expr(expr.slice(colon + 3), cont, ': ', suffix),
        ];
      }
    }

    // Boolean operators: one operand per line, breaking before the operator.
    for (const op of [' || ', ' && ']) {
      if (topLevel(expr, scan, op).length) {
        const parts = splitAt(expr, op);
        const opText = op.trim();
        return parts.flatMap((part, k) =>
          k === 0 ? this.expr(part, indent, prefix, '') : this.expr(part, cont, `${opText} `, k === parts.length - 1 ? suffix : ''),
        );
      }
    }

    // Arithmetic and string concatenation: break before the operator, packing operands per line.
    // Additive operators bind loosest, so they are the preferred break points.
    for (const ops of [[' | '], [' ^ '], [' & '], [' << ', ' >> ', ' >>> '], [' + ', ' - '], [' * ', ' / ', ' % ']]) {
      const cuts = ops
        .flatMap((op) => topLevel(expr, scan, op).map((at) => ({ at, op })))
        .sort((a, b) => a.at - b.at);
      if (!cuts.length) continue;
      const parts: { op: string; text: string }[] = [];
      let from = 0;
      let pendingOp = '';
      for (const c of cuts) {
        parts.push({ op: pendingOp, text: expr.slice(from, c.at).trim() });
        pendingOp = c.op.trim();
        from = c.at + c.op.length;
      }
      parts.push({ op: pendingOp, text: expr.slice(from).trim() });
      const lines: string[] = [];
      let current = indent + prefix + parts[0].text;
      for (let k = 1; k < parts.length; k += 1) {
        const piece = `${parts[k].op} ${parts[k].text}`;
        const isLast = k === parts.length - 1;
        const candidate = `${current} ${piece}`;
        if (this.fits(candidate + (isLast ? suffix : ''))) {
          current = candidate;
        } else {
          lines.push(current);
          current = cont + piece;
        }
      }
      lines.push(current + suffix);
      // A single operand may still be too long (a call with many arguments): wrap it on its own.
      return lines.flatMap((line) => (this.fits(line) ? [line] : this.rewrapLine(line)));
    }

    // Method chain: break before each `.call(` that follows a call.
    const dots = topLevel(expr, scan, '.').filter((d) => expr[d - 1] === ')' && /^\.[A-Za-z_]\w*\s*\(/.test(expr.slice(d)));
    if (dots.length) {
      const pieces: string[] = [];
      let from = 0;
      for (const d of dots) {
        pieces.push(expr.slice(from, d));
        from = d;
      }
      pieces.push(expr.slice(from));
      return pieces.flatMap((piece, k) =>
        k === 0 ? this.call(piece, indent, prefix, '') : this.call(piece, cont, '', k === pieces.length - 1 ? suffix : ''),
      );
    }

    // A call's argument list is the next best break.
    const called = this.call(expr, indent, prefix, suffix);
    if (called.length > 1 || !topLevel(expr, scan, ', ').length) return called;

    // Last resort: a bare comma-separated list (a leftover Python tuple), packed per line.
    const items = splitAt(expr, ',');
    const lines: string[] = [];
    let current = indent + prefix + items[0];
    for (let k = 1; k < items.length; k += 1) {
      const isLast = k === items.length - 1;
      const candidate = `${current}, ${items[k]}`;
      if (this.fits(candidate + (isLast ? suffix : ','))) {
        current = candidate;
      } else {
        lines.push(`${current},`);
        current = cont + items[k];
      }
    }
    lines.push(current + suffix);
    return lines;
  }

  /** Re-wrap one already indented line that is still too long. */
  private rewrapLine(line: string): string[] {
    const indent = /^\s*/.exec(line)![0];
    const body = line.slice(indent.length);
    const op = /^(\+|-|\*|\/|%|&&|\|\||\?|:) /.exec(body)?.[0] ?? '';
    return this.call(body.slice(op.length), indent, op, '');
  }

  /** Chop down the argument list that ends `expr`, or return it unchanged when there is none. */
  call(expr: string, indent: string, prefix: string, suffix: string): string[] {
    const oneLine = indent + prefix + expr + suffix;
    if (this.fits(oneLine) || !expr.endsWith(')')) return [oneLine];
    const scan = scanJava(expr);
    const opens = topLevel(expr, scan, '(');
    const open = opens[opens.length - 1];
    if (open === undefined) return [oneLine];
    const head = expr.slice(0, open + 1);
    const inner = expr.slice(open + 1, -1).trim();
    if (!inner) return [oneLine];
    const cont = indent + CONTINUATION;
    const args = splitAt(inner, ',');

    // A single argument that fits on its own continuation line goes there. A single argument
    // that is itself a call "hugs" the outer call instead - `add(new Line(` on the first line,
    // only the inner arguments chopped - rather than stacking two levels of indentation.
    if (args.length === 1) {
      const arg = args[0];
      if (this.fits(cont + arg + `)${suffix}`)) return [indent + prefix + head, cont + arg + `)${suffix}`];
      if (arg.endsWith(')') && !topLevel(arg, scanJava(arg), ' -> ').length) {
        const hugged = this.call(arg, indent, prefix + head, `)${suffix}`);
        if (hugged.length > 1 && this.fits(hugged[0])) return hugged;
      }
    }

    // `Map.of(k1, v1, k2, v2)` reads as pairs: keep each key with its value.
    const rows: string[] = [];
    if (/(^|\W)Map\.of\($/.test(head) && args.length % 2 === 0) {
      for (let k = 0; k < args.length; k += 2) rows.push(`${args[k]}, ${args[k + 1]}`);
    } else {
      rows.push(...args);
    }
    const lines = [indent + prefix + head];
    rows.forEach((row, k) => {
      const isLast = k === rows.length - 1;
      lines.push(...this.expr(row, cont, '', isLast ? `)${suffix}` : ','));
    });
    return lines;
  }

  /** A statement: peel off control keywords, `return`/`throw`, assignments, then wrap the expression. */
  statement(code: string, indent: string): string[] {
    if (this.fits(indent + code)) return [indent + code];
    let suffix = '';
    let core = code;
    if (/\s\{$/.test(core) && !/->\s*\{$/.test(core)) {
      suffix = ' {';
      core = core.slice(0, -2);
    } else if (core.endsWith(';')) {
      suffix = ';';
      core = core.slice(0, -1);
    }

    const control = /^((?:\}\s*)?(?:else\s+)?(?:if|while|for|switch|synchronized|catch|try))\s*\(/.exec(core);
    if (control && core.endsWith(')')) {
      const scan = scanJava(core);
      const open = core.indexOf('(', control[1].length);
      if (scan.depth[open] === 0 && topLevel(core, scan, '(').length === 1) {
        return this.expr(core.slice(open + 1, -1), indent, `${control[1]} (`, `)${suffix}`);
      }
    }

    // A type header breaks before `extends` / `implements`.
    if (/^(public |private |protected |static |abstract |final )*(class|interface|enum|record) /.test(core)) {
      const scanHeader = scanJava(core);
      const cuts = [...topLevel(core, scanHeader, ' extends '), ...topLevel(core, scanHeader, ' implements ')].sort((a, b) => a - b);
      if (cuts.length) {
        const lines = [indent + core.slice(0, cuts[0])];
        cuts.forEach((c, k) => lines.push(indent + CONTINUATION + core.slice(c + 1, cuts[k + 1] ?? core.length).trim() + (k === cuts.length - 1 ? suffix : '')));
        return lines;
      }
    }

    let prefix = '';
    const scan = scanJava(core);
    const assign = topLevel(core, scan, ' = ')[0];
    const keyword = /^(return|throw|yield|assert)\s+/.exec(core);
    if (assign !== undefined) {
      prefix = core.slice(0, assign + 3);
      core = core.slice(assign + 3);
    } else if (keyword) {
      prefix = keyword[0];
      core = core.slice(keyword[0].length);
    }
    return this.expr(core, indent, prefix, suffix);
  }
}

/** Wrap one generated line to `width` columns. `width <= 0` disables wrapping. */
export function formatJavaLine(line: string, width: number = DEFAULT_LINE_WIDTH): Formatted {
  if (width <= 0 || line.length <= width || line.includes('\n')) return { text: line, lead: 0 };
  const indent = /^\s*/.exec(line)![0];
  const body = line.slice(indent.length);

  // Comment prose.
  if (body.startsWith('//')) {
    const words = body.slice(2).trim().split(/\s+/);
    return { text: wrapWords(words, `${indent}// `, width).join('\n'), lead: 0 };
  }
  const single = /^\/\*(\*?)\s(.*)\s\*\/$/.exec(body);
  if (single) {
    const lines = [`${indent}/*${single[1]}`, ...wrapWords(single[2].split(/\s+/), `${indent} * `, width), `${indent} */`];
    return { text: lines.join('\n'), lead: 0 };
  }
  if (/^\*( |$)/.test(body)) {
    const text = body.slice(2);
    // Indented text inside a doc comment is preformatted (code examples, tables): leave it.
    if (/^\s/.test(text) || !/\s/.test(text.trim())) return { text: line, lead: 0 };
    return { text: wrapWords(text.split(/\s+/), `${indent}* `, width).join('\n'), lead: 0 };
  }

  const wrapper = new Wrapper(width);
  const scan = scanJava(body);
  if (scan.lineComment >= 0) {
    const code = body.slice(0, scan.lineComment).trimEnd();
    const comment = body.slice(scan.lineComment + 2).trim();
    const commentLines = wrapWords(comment.split(/\s+/), '// ', width - indent.length).map((l) => indent + l);
    const codeLines = wrapper.statement(code, indent);
    if (/\{$/.test(code)) {
      // A block opener keeps the comment as the first line inside the block.
      const inner = commentLines.map((l) => `    ${l}`);
      return { text: [...codeLines, ...inner].join('\n'), lead: 0 };
    }
    return { text: [...commentLines, ...codeLines].join('\n'), lead: commentLines.length };
  }
  return { text: wrapper.statement(body, indent).join('\n'), lead: 0 };
}
