/**
 * Rewrites calls to Python builtins into Java-flavored equivalents.
 *
 * Unlike the single-operand regexes in expressions.ts, this walks the text and parses each
 * call's balanced argument list, so `len(a + b)`, `sorted(xs, key=lambda o: o.x)` and
 * `any(x > 1 for x in xs)` all work. Operates on *masked* text (string literals are
 * placeholders); a `CallContext` resolves a placeholder back to its literal when a rule
 * needs the value (attribute names for getattr/hasattr, the mode of open()).
 */

import { PLACEHOLDER_RE } from './strings';
import { splitTopLevel } from './typeHints';

export interface CallContext {
  /** The Java-rendered literal behind a placeholder token, e.g. `"name"`, or undefined when unknown. */
  literal(maskedToken: string): string | undefined;
}

type Handler = (args: string[], kw: Map<string, string>, ctx: CallContext, raw: string) => string | undefined;

const PLACEHOLDER_ONLY = new RegExp(`^${PLACEHOLDER_RE}$`);

/** Identifier / attribute chain, optionally called or indexed once, or a string literal. */
function isSimple(s: string): boolean {
  return /^[\w.]+(\([^()]*\))?(\.get\([^()]*\))?$/.test(s) || PLACEHOLDER_ONLY.test(s);
}

function paren(s: string): string {
  return isSimple(s) ? s : `(${s})`;
}

/** True when the closing paren of the leading `(` is the last character. */
function wrappedInParens(t: string): boolean {
  if (!t.startsWith('(') || !t.endsWith(')')) return false;
  let depth = 0;
  for (let i = 0; i < t.length; i += 1) {
    if (t[i] === '(') depth += 1;
    else if (t[i] === ')') {
      depth -= 1;
      if (depth === 0) return i === t.length - 1;
    }
  }
  return false;
}

/** A generator expression argument arrives as `(xs.stream()...)`; drop the wrapping parens. */
function stripGenerator(s: string): string {
  const t = s.trim();
  return wrappedInParens(t) ? t.slice(1, -1).trim() : t;
}

function isStream(s: string): boolean {
  return /\.stream\(\)/.test(s) || /^IntStream\./.test(s) || /\.boxed\(\)$/.test(s);
}

/** `range(a, b, step)` argument text -> an IntStream. */
export function rangeToIntStream(argsText: string): string {
  const args = splitTopLevel(argsText);
  if (args.length === 1) return `IntStream.range(0, ${args[0]})`;
  if (args.length === 2) return `IntStream.range(${args[0]}, ${args[1]})`;
  const [a, b, step] = args;
  const down = step.trim().startsWith('-');
  return `IntStream.iterate(${a}, i -> i ${down ? '>' : '<'} ${b}, i -> i ${down ? '-' : '+'} ${down ? step.trim().slice(1) : step})`;
}

/** Whatever `arg` is (collection, generator, range, stream), as a Stream. */
export function streamOf(arg: string): string {
  const a = stripGenerator(arg);
  if (isStream(a)) return a;
  const r = /^range\((.*)\)$/.exec(a);
  if (r) return `${rangeToIntStream(r[1])}.boxed()`;
  return `${paren(a)}.stream()`;
}

/** `.stream().map(p -> e)` -> its parts, so any()/all() can turn the map into a match. */
function splitTrailingMap(stream: string): { head: string; lambda: string } | undefined {
  const idx = stream.lastIndexOf('.map(');
  if (idx < 0 || !stream.endsWith(')')) return undefined;
  const lambda = stream.slice(idx + 5, -1);
  if (!/^\(?[\w, ]+\)?\s*->/.test(lambda)) return undefined;
  return { head: stream.slice(0, idx), lambda };
}

/** A Python callable passed by name -> a Java function reference where one is well known. */
function functionRef(f: string): string {
  const refs: Record<string, string> = {
    str: 'String::valueOf',
    int: 'Integer::parseInt',
    float: 'Double::parseDouble',
    len: 'v -> v.size()',
    abs: 'Math::abs',
    'String.valueOf': 'String::valueOf',
  };
  return refs[f.trim()] ?? f.trim();
}

/** `key=f, reverse=True` -> a Comparator expression, or '' for the natural order. */
function comparator(kw: Map<string, string>): string {
  const key = kw.get('key');
  const reverse = kw.get('reverse') === 'true';
  if (key && reverse) return `Comparator.comparing(${functionRef(key)}).reversed()`;
  if (key) return `Comparator.comparing(${functionRef(key)})`;
  if (reverse) return 'Comparator.reverseOrder()';
  return '';
}

/** Unquote a rendered Java literal like `"name"`; undefined when it is not a plain string. */
function plainString(ctx: CallContext, token: string): string | undefined {
  const lit = ctx.literal(token.trim());
  const m = lit && /^"([^"\\]*)"$/.exec(lit);
  return m ? m[1] : undefined;
}

const HANDLERS: Record<string, Handler> = {
  len: ([a]) => (a ? `${paren(a)}.size()` : undefined),
  sum: ([a], kw) => (a && !kw.size ? `${streamOf(a)}.mapToDouble(Number::doubleValue).sum()` : undefined),
  any: ([a]) => {
    if (!a) return undefined;
    const s = streamOf(a);
    const m = splitTrailingMap(s);
    return m ? `${m.head}.anyMatch(${m.lambda})` : `${s}.anyMatch(Boolean.TRUE::equals)`;
  },
  all: ([a]) => {
    if (!a) return undefined;
    const s = streamOf(a);
    const m = splitTrailingMap(s);
    return m ? `${m.head}.allMatch(${m.lambda})` : `${s}.allMatch(Boolean.TRUE::equals)`;
  },
  sorted: ([a], kw) => (a ? `${streamOf(a)}.sorted(${comparator(kw)}).toList()` : undefined),
  reversed: ([a]) => (a ? `${paren(a)}.reversed()` : undefined),
  next: ([it, dflt]) => (it ? (dflt !== undefined ? `${paren(it)}.hasNext() ? ${paren(it)}.next() : ${dflt}` : `${paren(it)}.next()`) : undefined),
  iter: ([a]) => (a ? `${paren(a)}.iterator()` : undefined),
  round: ([x, n]) => {
    if (!x) return undefined;
    if (n === undefined) return `Math.round(${x})`;
    if (/^\d+$/.test(n.trim())) {
      const scale = `${10 ** Number(n.trim())}.0`;
      return `Math.round(${paren(x)} * ${scale}) / ${scale}`;
    }
    return `Math.round(${paren(x)} * Math.pow(10, ${n})) / Math.pow(10, ${n})`;
  },
  map: ([f, xs, ...more]) => (f && xs && !more.length ? `${streamOf(xs)}.map(${functionRef(f)})` : undefined),
  filter: ([f, xs]) => (f && xs ? `${streamOf(xs)}.filter(${f.trim() === 'null' ? 'Objects::nonNull' : functionRef(f)})` : undefined),
  zip: (args) => (args.length >= 2 ? `Tuple.zip(${args.join(', ')})` : undefined),
  enumerate: ([xs, start]) => (xs ? `Tuple.enumerate(${xs}${start !== undefined ? `, ${start}` : ''})` : undefined),
  range: (args, _kw, _ctx, raw) => (args.length ? rangeToIntStream(raw) : undefined),
  isinstance: ([x, t]) => {
    if (!x || !t) return undefined;
    const types = wrappedInParens(t.trim()) ? splitTopLevel(t.trim().slice(1, -1)) : [t.trim()];
    const tests = types.map((ty) => `${x} instanceof ${ty}`);
    return tests.length === 1 ? tests[0] : `(${tests.join(' || ')})`;
  },
  getattr: ([o, name, dflt], _kw, ctx) => {
    if (!o || !name) return undefined;
    const attr = plainString(ctx, name);
    if (attr === undefined || !/^\w+$/.test(attr)) return `getattr(${[o, name, dflt].filter((a) => a !== undefined).join(', ')}) /* reflective attribute access */`;
    return dflt !== undefined ? `Objects.requireNonNullElse(${paren(o)}.${attr}, ${dflt})` : `${paren(o)}.${attr} /* getattr */`;
  },
  hasattr: ([o, name], _kw, ctx) => {
    if (!o || !name) return undefined;
    const attr = plainString(ctx, name);
    return attr !== undefined && /^\w+$/.test(attr) ? `${paren(o)}.${attr} != null /* hasattr */` : `hasattr(${o}, ${name}) /* reflective attribute check */`;
  },
  open: ([p, mode], kw, ctx) => {
    if (!p) return undefined;
    const m = (mode !== undefined ? plainString(ctx, mode) : kw.has('mode') ? plainString(ctx, kw.get('mode')!) : 'r') ?? '';
    if (mode !== undefined && plainString(ctx, mode) === undefined) return undefined;
    const readers: Record<string, string> = {
      r: `new BufferedReader(new FileReader(${p}))`,
      rt: `new BufferedReader(new FileReader(${p}))`,
      w: `new PrintWriter(${p})`,
      wt: `new PrintWriter(${p})`,
      a: `new FileWriter(${p}, true)`,
      rb: `new FileInputStream(${p})`,
      wb: `new FileOutputStream(${p})`,
      ab: `new FileOutputStream(${p}, true)`,
    };
    return readers[m.replace('+', '')];
  },
  list: ([a], kw) => {
    if (kw.size) return undefined;
    if (a === undefined) return 'new ArrayList<>()';
    const s = stripGenerator(a);
    if (isStream(s)) return /^IntStream\./.test(s) ? `${s}.boxed().toList()` : `${s}.toList()`;
    return `new ArrayList<>(${s})`;
  },
  set: ([a]) => {
    if (a === undefined) return 'new HashSet<>()';
    const s = stripGenerator(a);
    return isStream(s) ? `${s}.collect(Collectors.toSet())` : `new HashSet<>(${s})`;
  },
  tuple: ([a]) => {
    if (a === undefined) return 'Tuple.of()';
    const s = stripGenerator(a);
    return isStream(s) ? `${s}.toList() /* tuple */` : `Tuple.of(${s})`;
  },
  dict: (args, kw) => {
    if (!args.length && !kw.size) return 'new HashMap<>()';
    if (!args.length) return `Map.of(${[...kw].map(([k, v]) => `"${k}", ${v}`).join(', ')})`;
    return `new HashMap<>(${args.join(', ')})`;
  },
  min: (args, kw) => {
    if (args.length === 1) return `Collections.min(${args[0]}${kw.has('key') ? `, ${comparator(kw)}` : ''})`;
    if (args.length >= 2 && !kw.size) return args.reduceRight((acc, a) => `Math.min(${a}, ${acc})`);
    return undefined;
  },
  max: (args, kw) => {
    if (args.length === 1) return `Collections.max(${args[0]}${kw.has('key') ? `, ${comparator(kw)}` : ''})`;
    if (args.length >= 2 && !kw.size) return args.reduceRight((acc, a) => `Math.max(${a}, ${acc})`);
    return undefined;
  },
  pow: ([a, b]) => (a && b ? `Math.pow(${a}, ${b})` : undefined),
  divmod: ([a, b]) => (a && b ? `Tuple.of(Math.floorDiv(${a}, ${b}), Math.floorMod(${a}, ${b}))` : undefined),
  chr: ([a]) => (a ? `(char) ${paren(a)}` : undefined),
  ord: ([a]) => (a ? `(int) ${paren(a)}` : undefined),
  repr: ([a]) => (a ? `String.valueOf(${a})` : undefined),
};

/** Split call arguments into positional ones and `name=value` keyword ones. */
function splitArguments(inner: string): { args: string[]; kw: Map<string, string> } {
  const args: string[] = [];
  const kw = new Map<string, string>();
  for (const part of splitTopLevel(inner)) {
    const m = /^([A-Za-z_]\w*)\s*=(?!=)\s*([\s\S]+)$/.exec(part);
    if (m) kw.set(m[1], m[2].trim());
    else args.push(part);
  }
  return { args, kw };
}

const CALL_START = /(^|[^\w.])([A-Za-z_]\w*)\(/g;

/** Rewrite every builtin call in `text` (innermost first). Unknown names are left untouched. */
export function rewriteBuiltinCalls(text: string, ctx: CallContext): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    CALL_START.lastIndex = i;
    const m = CALL_START.exec(text);
    if (!m) {
      out += text.slice(i);
      break;
    }
    const nameStart = m.index + m[1].length;
    const open = nameStart + m[2].length;
    const handler = HANDLERS[m[2]];
    // The regex may have matched a name that is not ours or is preceded by `new ` - copy through.
    if (!handler || /new\s$/.test(text.slice(0, nameStart))) {
      out += text.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    let depth = 0;
    let close = -1;
    for (let j = open; j < text.length; j += 1) {
      if (text[j] === '(') depth += 1;
      else if (text[j] === ')') {
        depth -= 1;
        if (depth === 0) {
          close = j;
          break;
        }
      }
    }
    if (close < 0) {
      out += text.slice(i);
      break;
    }
    const inner = rewriteBuiltinCalls(text.slice(open + 1, close), ctx);
    const { args, kw } = splitArguments(inner);
    const replaced = handler(args, kw, ctx, inner);
    out += text.slice(i, nameStart) + (replaced ?? `${m[2]}(${inner})`);
    i = close + 1;
  }
  return out;
}

/**
 * `a or b` used as a value (an assignment or return, not a condition) is a fallback, not a
 * boolean: render it as `Objects.requireNonNullElse(a, b)`. Only a plain operand on the left
 * qualifies; comparisons and boolean logic keep `||`.
 */
export function rewriteOrFallback(text: string): string {
  const idx = indexOfTopLevel(text, /\sor\s/);
  if (idx < 0) return text;
  const lhs = text.slice(0, idx).trim();
  const rhs = text.slice(idx + 4).trim();
  if (!lhs || !rhs) return text;
  if (!isSimple(lhs) || /^(true|false|null|not\b)/.test(lhs)) return text;
  if (/\snot\s|\sand\s|==|!=|<|>|\bin\s/.test(rhs)) return text;
  return `Objects.requireNonNullElse(${lhs}, ${rewriteOrFallback(rhs)})`;
}

function indexOfTopLevel(text: string, needle: RegExp): number {
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (depth === 0) {
      needle.lastIndex = 0;
      const m = needle.exec(text.slice(i));
      if (m && m.index === 0) return i;
    }
  }
  return -1;
}
