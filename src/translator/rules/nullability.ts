/**
 * Nullable primitives: Python lets any variable hold `None`, Java primitives cannot hold `null`.
 * A function body is scanned up front for the names the code flow treats as possibly `None`
 * (assigned `None`, compared with `None`) and for `return None`; the translator then declares
 * those names with the boxed type, so `count = 0 ... count = None` becomes `Integer count = 0`.
 *
 *   int -> Integer, double -> Double, boolean -> Boolean, char -> Character, ...
 */

import { LogicalLine } from './logicalLines';
import { maskStrings } from './strings';
import { boxed } from './typeHints';
import { inferTypeFromMaskedValue } from './members';

const PRIMITIVE_TYPES = new Set(['int', 'long', 'short', 'byte', 'double', 'float', 'boolean', 'char']);
const NULLABLE_COMMENT = '/* nullable */';

/** Whether a Java type is a primitive (`int`, `double` with a trailing comment), so it cannot hold null. */
export function isPrimitiveType(t: string | undefined): boolean {
  return t !== undefined && PRIMITIVE_TYPES.has(t.replace(/\/\*.*?\*\//g, '').trim());
}

/**
 * The type a nullable value is declared with: a primitive is boxed (`int` -> `Integer`), and
 * the `nullable` comment marker is added once.
 */
export function nullableType(t: string): string {
  const base = t.replace(/\s*\/\*\s*nullable\s*\*\//, '').trim();
  const javaBase = isPrimitiveType(base) ? boxed(base) : base;
  return `${javaBase} ${NULLABLE_COMMENT}`;
}

/** Box `t` when it is a primitive the code flow may set to None, else leave it as it is. */
export function boxIfNullable(t: string, nullable: boolean): string {
  return nullable && isPrimitiveType(t) ? nullableType(t) : t;
}

export interface NullabilityScan {
  /** Plain names (locals and parameters) assigned `None` or compared with `None`. */
  names: Set<string>;
  /** Name -> Java type of the first non-None literal assigned to it (for `x = None ... x = 0`). */
  laterTypes: Map<string, string>;
  /** The function returns `None` explicitly (or a name that may be None) somewhere. */
  returnsNone: boolean;
}

/** Whether a masked expression may evaluate to None: `None`, `a if c else None`, `None if c else a`. */
function mayBeNone(expr: string): boolean {
  const e = expr.trim();
  return e === 'None' || /\belse\s+None$/.test(e) || /^None\s+if\b/.test(e);
}

/** Masked statement text without its trailing comment. */
function codeOf(text: string): string {
  const masked = maskStrings(text).text;
  const idx = masked.indexOf('#');
  return (idx < 0 ? masked : masked.slice(0, idx)).trim();
}

/** Assignment target and value of a simple `name = value` / `name: T = value` statement. */
const SIMPLE_ASSIGN = /^(\w+)\s*(?::\s*[^=]+?)?\s*=(?!=)\s*(.+)$/;
/** `name is None`, `name is not None`, `name == None`, `name != None` (not `obj.name`). */
const NONE_COMPARE = /(?<![.\w])(\w+)\s+(?:is\s+(?:not\s+)?|[=!]=\s*)None\b/g;
/** `None is name`, `None == name`. */
const NONE_COMPARE_REVERSED = /\bNone\s+(?:is\s+(?:not\s+)?|[=!]=\s*)(\w+)\b(?!\s*[.(\[])/g;

/**
 * Scan the body of a `def` for names that may hold None. `body` holds the code lines strictly
 * inside the def at `headerIndent`; nested `def`/`class` bodies are skipped (their own scope).
 * `extra` holds statements on the header line itself (`def f(): return None`).
 */
export function scanNullability(body: LogicalLine[], headerIndent: number, extra: string[] = []): NullabilityScan {
  const scan: NullabilityScan = { names: new Set(), laterTypes: new Map(), returnsNone: false };
  const codes: string[] = [...extra.map(codeOf)];
  let nestedIndent: number | undefined;
  for (const l of body) {
    if (nestedIndent !== undefined) {
      if (l.indent > nestedIndent) continue;
      nestedIndent = undefined;
    }
    const code = codeOf(l.text);
    if (/^(async\s+)?(def|class)\s/.test(code) && l.indent > headerIndent) {
      nestedIndent = l.indent;
      continue;
    }
    codes.push(code);
  }

  const returned: string[] = [];
  for (const code of codes) {
    let m: RegExpExecArray | null;
    if ((m = SIMPLE_ASSIGN.exec(code))) {
      const [, name, value] = m;
      if (mayBeNone(value)) scan.names.add(name);
      else if (!scan.laterTypes.has(name)) {
        const t = inferTypeFromMaskedValue(value, []);
        if (t !== 'var' && !t.includes(NULLABLE_COMMENT)) scan.laterTypes.set(name, t);
      }
    }
    for (const re of [NONE_COMPARE, NONE_COMPARE_REVERSED]) {
      re.lastIndex = 0;
      while ((m = re.exec(code))) if (m[1] !== 'None' && m[1] !== 'self') scan.names.add(m[1]);
    }
    if ((m = /^return\s+(.+)$/.exec(code))) returned.push(m[1].trim());
  }
  scan.returnsNone = returned.some((r) => mayBeNone(r) || scan.names.has(r));
  return scan;
}

/**
 * Fields of a class that may hold None: assigned `self.x = None` (or `x = None` in the class
 * body) or compared as `self.x is None` anywhere in the class whose header is at `i`.
 */
export function nullableSelfFields(lines: LogicalLine[], i: number): Set<string> {
  const header = lines[i];
  const fields = new Set<string>();
  for (let j = i + 1; j < lines.length; j += 1) {
    const l = lines[j];
    if (l.kind !== 'code') continue;
    if (l.indent <= header.indent) break;
    const code = codeOf(l.text);
    const assign = /^self\.(\w+)\s*(?::\s*[^=]+?)?\s*=(?!=)\s*(.+)$/.exec(code);
    if (assign && mayBeNone(assign[2])) fields.add(assign[1]);
    for (const m of code.matchAll(/\bself\.(\w+)\s+(?:is\s+(?:not\s+)?|[=!]=\s*)None\b/g)) fields.add(m[1]);
  }
  return fields;
}
