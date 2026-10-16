/**
 * String literal handling.
 *
 * Before applying textual rewrite rules to a Python expression we replace every
 * string literal with an opaque placeholder so that keywords inside strings
 * (e.g. "and", "None") are never rewritten. Afterwards the placeholders are
 * restored as Java string literals (double quoted, or text blocks for
 * triple-quoted strings). f-strings become concatenations.
 */

/** A control character that never appears in real source code. */
const PLACEHOLDER = String.fromCharCode(1);

export interface MaskedText {
  text: string;
  literals: string[];
}

interface Literal {
  prefix: string;
  quote: string;
  body: string;
}

function readLiteral(src: string, start: number): { literal: Literal; end: number } | null {
  const m = /^([rRbBuUfF]{0,2})("""|'''|"|')/.exec(src.slice(start));
  if (!m) return null;
  const prefix = m[1].toLowerCase();
  const quote = m[2];
  let i = start + m[0].length;
  let body = '';
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\') {
      body += src.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (src.startsWith(quote, i)) {
      return { literal: { prefix, quote, body }, end: i + quote.length };
    }
    body += ch;
    i += 1;
  }
  // Unterminated - take the rest.
  return { literal: { prefix, quote, body }, end: src.length };
}

/** Replace string literals with placeholders. Comments are left in place (handled by caller). */
export function maskStrings(src: string): MaskedText {
  const literals: string[] = [];
  let out = '';
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    const prefixed =
      /[rRbBuUfF]/.test(ch) && /^[rRbBuUfF]{1,2}["']/.test(src.slice(i, i + 3)) && (i === 0 || !/[\w.]/.test(src[i - 1]));
    if (ch === '"' || ch === "'" || prefixed) {
      const read = readLiteral(src, i);
      if (read) {
        literals.push(renderLiteral(read.literal));
        out += `${PLACEHOLDER}${literals.length - 1}${PLACEHOLDER}`;
        i = read.end;
        continue;
      }
    }
    if (ch === '#') {
      // Comment start: keep verbatim, no more literals on this line.
      out += src.slice(i);
      break;
    }
    out += ch;
    i += 1;
  }
  return { text: out, literals };
}

export function unmaskStrings(text: string, literals: string[]): string {
  return text.replace(new RegExp(`${PLACEHOLDER}(\\d+)${PLACEHOLDER}`, 'g'), (_m, idx: string) => literals[Number(idx)]);
}

/** True when the (masked) text is exactly one string literal placeholder. */
export function isSingleLiteral(masked: string): boolean {
  return new RegExp(`^${PLACEHOLDER}\\d+${PLACEHOLDER}$`).test(masked.trim());
}

/** Regex source matching one placeholder. */
export const PLACEHOLDER_RE = `${PLACEHOLDER}\\d+${PLACEHOLDER}`;

/** Placeholder-aware "simple operand": identifier/attribute chain with optional call or index, or a string literal. */
export const SIMPLE_OPERAND = `(?:${PLACEHOLDER_RE}|-?[\\w.]+(?:\\([^()]*\\))?(?:\\[[^\\[\\]]*\\])?|\\([^()]*\\))`;

function escapeForJava(body: string, singleQuoted: boolean): string {
  let s = body;
  if (singleQuoted) {
    // Python allows unescaped " inside '...' and escaped \' which Java does not need.
    // Escape pairs are read whole, so `\"` (an escaped quote) and `\\` stay what they were.
    s = s.replace(/\\([\s\S])|"/g, (m, esc?: string) => (esc === undefined ? '\\"' : esc === "'" ? "'" : m));
  }
  return s.includes('\\') ? translateEscapes(s) : s;
}

/** `\ooo` for a char below 256: unlike `\u000a`, an octal escape is not pre-lexed by javac. */
function octalEscape(code: number): string {
  return `\\${code.toString(8).padStart(3, '0')}`;
}

/** A code point as Java escapes (a surrogate pair above the BMP); never `\u000a`-style line breaks. */
function codePointEscape(code: number): string {
  if (code < 0x100) return octalEscape(code);
  if (code < 0x10000) return `\\u${code.toString(16).padStart(4, '0')}`;
  const v = code - 0x10000;
  return codePointEscape(0xd800 + (v >> 10)) + codePointEscape(0xdc00 + (v & 0x3ff));
}

/**
 * Python escapes as Java ones. Java lacks `\x`, `\a`, `\v`, `\U` and `\N{...}`, and rejects
 * escapes Python keeps as a backslash plus the character (`"\d"` is `\\d` in Python); `\s`
 * even means a space in Java. Escapes both languages share are kept.
 */
function translateEscapes(text: string): string {
  return text.replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|N\{[^}]*\}|[0-7]{1,3}|[\s\S])/g, (m, esc: string) => {
    switch (esc[0]) {
      case 'x':
        return octalEscape(parseInt(esc.slice(1), 16));
      case 'u':
      case 'U':
        return codePointEscape(parseInt(esc.slice(1), 16));
      case 'a':
        return octalEscape(7);
      case 'v':
        return octalEscape(11);
      case 'N':
        return `\\\\${esc}`; // a named character: no Java escape, kept as text
      case '\n':
        return m; // line continuation inside a text block
      default:
        if (/^[0-7]/.test(esc)) return parseInt(esc, 8) < 256 ? m : codePointEscape(parseInt(esc, 8));
        return /^[btnfr"'\\]$/.test(esc) ? m : `\\\\${esc}`;
    }
  });
}

/** Hook set by the expression module so f-string fields can be translated recursively. */
let exprHook: (expr: string) => string = (e) => e;
export function setFStringExpressionHook(fn: (expr: string) => string): void {
  exprHook = fn;
}

function renderLiteral(lit: Literal): string {
  const triple = lit.quote.length === 3;
  const single = lit.quote[0] === "'";
  const isF = lit.prefix.includes('f');
  const isRaw = lit.prefix.includes('r');
  let body = lit.body;
  if (isRaw) {
    body = body.replace(/\\/g, '\\\\');
  }
  if (isF) {
    return renderFString(body, single, triple);
  }
  if (triple) {
    // Java text block (Java 15+). Content must start on a new line.
    const content = escapeForJava(body, single).replace(/^\n/, '');
    return `"""\n${content}"""`;
  }
  return `"${escapeForJava(body, single)}"`;
}

/**
 * f"Hello {name}, total={total:.2f}" -> "Hello " + name + ", total=" + String.format("%.2f", total)
 */
function renderFString(body: string, single: boolean, triple = false): string {
  const parts: string[] = [];
  let text = '';
  let i = 0;
  const flushText = () => {
    if (text.length > 0) {
      // A multi-line piece of a triple-quoted f-string becomes a text block: a Java string
      // literal cannot contain a raw newline.
      const escaped = escapeForJava(text, single);
      parts.push(triple && text.includes('\n') ? `"""\n${escaped.replace(/^\n/, '')}"""` : `"${escaped}"`);
      text = '';
    }
  };
  while (i < body.length) {
    const ch = body[i];
    if (ch === '{') {
      if (body[i + 1] === '{') {
        text += '{';
        i += 2;
        continue;
      }
      let depth = 1;
      let j = i + 1;
      let inner = '';
      while (j < body.length && depth > 0) {
        const c = body[j];
        if (c === '{') depth += 1;
        else if (c === '}') depth -= 1;
        if (depth > 0) inner += c;
        j += 1;
      }
      flushText();
      parts.push(renderFStringField(inner));
      i = j;
      continue;
    }
    if (ch === '}' && body[i + 1] === '}') {
      text += '}';
      i += 2;
      continue;
    }
    text += ch;
    i += 1;
  }
  flushText();
  if (parts.length === 0) return '""';
  return parts.join(' + ');
}

function renderFStringField(inner: string): string {
  // Split "expr!conv:spec" at top-level ':' and '!'.
  let depth = 0;
  let exprEnd = inner.length;
  for (let k = 0; k < inner.length; k += 1) {
    const c = inner[k];
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') depth -= 1;
    else if (depth === 0 && (c === ':' || (c === '!' && inner[k + 1] !== '='))) {
      exprEnd = k;
      break;
    }
  }
  let expr = inner.slice(0, exprEnd).trim();
  const rest = inner.slice(exprEnd);
  const selfDoc = expr.endsWith('=');
  if (selfDoc) expr = expr.slice(0, -1).trim();
  const specMatch = /:(.*)$/.exec(rest);
  const spec = specMatch ? specMatch[1] : '';
  let rendered = exprHook(expr);
  if (/[^\w.()]/.test(rendered)) rendered = `(${rendered})`;
  if (spec) {
    rendered = `String.format("%${pythonSpecToJava(spec)}", ${rendered})`;
  }
  if (selfDoc) rendered = `"${expr}=" + ${rendered}`;
  return rendered;
}

/** Rough mapping of Python format specs to java.util.Formatter specs. */
function pythonSpecToJava(spec: string): string {
  const m = /^([<>^]?)(\d*)(,?)(?:\.(\d+))?([dfsx%]?)$/.exec(spec);
  if (!m) return `s /* ${spec} */`;
  const [, align, width, comma, precision, type] = m;
  const flag = (align === '<' ? '-' : '') + (comma ? ',' : '');
  const w = width ?? '';
  const p = precision ? `.${precision}` : '';
  const t = type === '%' ? 'f%%' : type || (precision ? 'f' : 's');
  return `${flag}${w}${p}${t}`;
}
