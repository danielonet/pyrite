/**
 * Expression-level rewrite rules (Python expression -> Java-flavored expression).
 *
 * All functions here operate on *masked* text (string literals replaced by
 * placeholders, see strings.ts) so that rewrites never touch string contents.
 */

import { PLACEHOLDER_RE, SIMPLE_OPERAND, maskStrings, setFStringExpressionHook, unmaskStrings } from './strings';
import { splitTopLevel } from './typeHints';
import { rewriteBuiltinCalls, rewriteOrFallback, streamOf } from './builtins';
import { rewriteIntLiterals } from './numbers';

export interface ExprContext {
  /** Enclosing class name, used to render `cls`. */
  className?: string;
  /** The literals behind the placeholders in the masked text, when the caller has them. */
  literals?: string[];
  /** The expression is used as a value (assignment, return), not as a condition: `a or b` is a fallback. */
  valueContext?: boolean;
  /** How a read of a Python `@property` is rendered (`total()`, `getTotal()`), or undefined for a plain attribute. */
  propertyAccessor?: (name: string) => string | undefined;
  /** `this.<python field>` -> `this.<java field>` for backing fields renamed after their property. */
  fieldRenames?: Map<string, string>;
  /** Nested functions in scope, rendered as lambdas: calls become `name.apply(...)` and the like. */
  localFunctions?: Map<string, LocalFunction>;
}

/** How a nested function, translated to a lambda, is called. */
export interface LocalFunction {
  /** Functional-interface method: `apply`, `accept`, `get`, `run`. */
  method: string;
  /** The lambda takes one `Object[]` (three or more parameters, or `*args`). */
  arrayArgs: boolean;
}

/** `f(a, b)` -> `f.apply(a, b)` (or `f.apply(new Object[] {a, b, c})`) for nested functions. */
function rewriteLocalFunctionCalls(text: string, functions: Map<string, LocalFunction>): string {
  let t = text;
  for (const [name, fn] of functions) {
    const call = new RegExp(`(?<![\\w.])${name}\\(`, 'g');
    let out = '';
    let from = 0;
    for (let m = call.exec(t); m; m = call.exec(t)) {
      const open = m.index + name.length;
      const end = groupEnd(t, open);
      if (end < 0) break;
      const args = t.slice(open + 1, end - 1);
      // `f(*args)` is already an array (`args.toArray()`); anything else is packed into one.
      const packed = fn.arrayArgs && !(splitTopLevel(args).length === 1 && /\.toArray\(\)$/.test(args.trim()));
      out += `${t.slice(from, m.index)}${name}.${fn.method}(${packed ? `new Object[] {${args}}` : args})`;
      from = end;
      call.lastIndex = end;
    }
    t = out + t.slice(from);
  }
  return t;
}

/** Start of the postfix expression (`a.b(c).get(d)`) that ends just before `end`. */
function postfixStart(text: string, end: number): number {
  let k = end;
  while (k > 0) {
    const ch = text[k - 1];
    if (ch === ')' || ch === ']') {
      let depth = 0;
      let j = k - 1;
      for (; j >= 0; j -= 1) {
        if (text[j] === ')' || text[j] === ']') depth += 1;
        else if (text[j] === '(' || text[j] === '[') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      if (j < 0) return k;
      k = j;
    } else if (/[\w.\x01]/.test(ch)) k -= 1;
    else break;
  }
  return k;
}

/** A primitive cast in front of an operand, as the builtin rules write `int(x)` / `float(x)`. */
const CAST = /^\((?:int|long|double|float|char|boolean)\)\s*/;
const CAST_BEFORE = /\((?:int|long|double|float|char|boolean)\)\s*$/;

/** End of the operand that starts at `start` (after spaces): `-x`, `f(a)[0].b`, `(a + b)`, `"s"`; `start` when none. */
function postfixEnd(text: string, start: number): number {
  let k = start;
  while (text[k] === ' ') k += 1;
  if (text[k] === '-') k += 1;
  // A cast belongs to its operand: `(double) (b)`.
  const cast = CAST.exec(text.slice(k));
  if (cast) k += cast[0].length;
  const first = k;
  if (text.startsWith('new ', k)) k += 4;
  for (;;) {
    const ch = text[k];
    if (ch === '(' || ch === '[') {
      // A group starts an operand, or calls / subscripts the name before it.
      const end = groupEnd(text, k);
      if (end < 0) return k;
      k = end;
    } else if (ch !== undefined && /[\w\x01]/.test(ch)) {
      if (k > first && /[)\]\w\x01]/.test(text[k - 1]) && !/[\w\x01]/.test(text[k - 1])) return k;
      k += 1;
    } else if (ch === '.' && k > first && /[\w\x01]/.test(text[k + 1] ?? '')) k += 1;
    else if (ch === '.' && k === first && /\d/.test(text[k + 1] ?? '')) k += 1;
    else return k > first ? k : start;
  }
}

/**
 * Rewrite every `left <op> right` where `op` matches `op` (a global regex) and both sides are
 * whole postfix expressions, found by scanning (so `f(g(x)) ** 2` takes all of `f(g(x))`).
 * `build` returns the replacement, or undefined to leave that occurrence alone.
 */
function rewriteInfix(text: string, op: RegExp, build: (left: string, right: string, match: RegExpExecArray) => string | undefined): string {
  let t = text;
  op.lastIndex = 0;
  for (let m = op.exec(t); m; m = op.exec(t)) {
    let leftEnd = m.index;
    while (leftEnd > 0 && t[leftEnd - 1] === ' ') leftEnd -= 1;
    let leftStart = postfixStart(t, leftEnd);
    const cast = CAST_BEFORE.exec(t.slice(0, leftStart));
    if (cast) leftStart -= cast[0].length;
    const rightStart = m.index + m[0].length;
    const rightEnd = postfixEnd(t, rightStart);
    const left = t.slice(leftStart, leftEnd);
    const right = t.slice(rightStart, rightEnd).trim();
    const out = left && right ? build(left, right, m) : undefined;
    if (out === undefined) continue;
    t = t.slice(0, leftStart) + out + t.slice(rightEnd);
    op.lastIndex = leftStart + out.length;
  }
  return t;
}

/** `(a, b)` -> [`a`, `b`] when `text` is a parenthesized group with a top-level comma. */
function tupleItems(text: string): string[] | undefined {
  if (!text.startsWith('(') || groupEnd(text, 0) !== text.length) return undefined;
  const items = splitTopLevel(text.slice(1, -1)).map((s) => s.trim()).filter(Boolean);
  return items.length > 1 || /,\s*$/.test(text.slice(1, -1)) ? items : undefined;
}

/**
 * A call on a value that is not a name: Python calls whatever an expression returns
 * (`handlers[event](self, frame)`, `factory(name)(data)`). Java only calls methods, so the
 * value is cast to the functional interface that nested functions become (see
 * `translateNestedDef`) and called through it:
 *
 *   handlers.get(event)(this, frame)  -> ((BiFunction<Object, Object, Object>) handlers.get(event)).apply(this, frame)
 *   type(self)(a, b) / self.__class__(a, b)  -> new Point(a, b)
 */
function rewriteCallsOnValues(text: string, className: string | undefined): string {
  let t = text;
  for (let i = t.indexOf(')('); i >= 0; i = t.indexOf(')(', i + 1)) {
    const start = postfixStart(t, i + 1);
    const callee = t.slice(start, i + 1);
    // The callee must itself end in a call or subscript (`f(x)`, `m.get(k)`), not a cast `(int)`.
    if (!/[\w>]\(/.test(callee) && !/\.get\(/.test(callee)) continue;
    const end = groupEnd(t, i + 1);
    if (end < 0) break;
    const args = t.slice(i + 2, end - 1);
    let call: string;
    if (/^this\.getClass\(\)$/.test(callee)) {
      if (!className) continue;
      call = `new ${className}(${args})`;
    } else if (/\.getClass\(\)$/.test(callee)) {
      continue; // a reflective constructor call: no plain Java equivalent
    } else {
      const items = splitTopLevel(args).filter((a) => a.trim() !== '');
      const spread = items.length === 1 && /\.toArray\(\)$/.test(items[0].trim());
      call = spread || items.length > 2
        ? `((Function<Object[], Object>) ${callee}).apply(${spread ? items[0].trim() : `new Object[] {${args}}`})`
        : items.length === 0
          ? `((Supplier<Object>) ${callee}).get()`
          : items.length === 1
            ? `((Function<Object, Object>) ${callee}).apply(${args})`
            : `((BiFunction<Object, Object, Object>) ${callee}).apply(${args})`;
    }
    t = t.slice(0, start) + call + t.slice(end);
    i = start;
  }
  return t;
}

const S = SIMPLE_OPERAND;

/** Python exception names that have a natural Java counterpart. */
export const EXCEPTIONS: Record<string, string> = {
  ValueError: 'IllegalArgumentException',
  TypeError: 'IllegalArgumentException',
  KeyError: 'NoSuchElementException',
  LookupError: 'NoSuchElementException',
  AttributeError: 'IllegalStateException',
  IndexError: 'IndexOutOfBoundsException',
  NotImplementedError: 'UnsupportedOperationException',
  RuntimeError: 'RuntimeException',
  FileNotFoundError: 'FileNotFoundException',
  ZeroDivisionError: 'ArithmeticException',
  ArithmeticError: 'ArithmeticException',
  OverflowError: 'ArithmeticException',
  RecursionError: 'StackOverflowError',
  MemoryError: 'OutOfMemoryError',
  UnicodeError: 'CharacterCodingException',
  UnicodeDecodeError: 'CharacterCodingException',
  UnicodeEncodeError: 'CharacterCodingException',
  // Unchecked, so `except ImportError:` around an import that became a comment still compiles.
  ImportError: 'NoClassDefFoundError',
  ModuleNotFoundError: 'NoClassDefFoundError',
  AssertionError: 'AssertionError',
  StopIteration: 'NoSuchElementException',
  TimeoutError: 'TimeoutException',
  PermissionError: 'SecurityException',
  OSError: 'IOException',
  IOError: 'IOException',
  Exception: 'Exception',
  BaseException: 'Throwable',
};

export function mapExceptionName(name: string): string {
  return EXCEPTIONS[name] ?? name;
}

/** Find the index of `needle` at bracket depth 0, or -1. */
export function indexAtDepth0(text: string, needle: RegExp, from = 0): number {
  let depth = 0;
  for (let i = from; i < text.length; i += 1) {
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

/**
 * Index of the whitespace before keyword `word` at bracket depth 0 in `text` (from `from`),
 * with whitespace after it too; -1 when there is none.
 */
function keywordAtDepth0(text: string, word: string, from = 0): number {
  let depth = 0;
  for (let i = from; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (depth === 0 && /\s/.test(ch) && text.startsWith(word, i + 1) && /\s/.test(text[i + 1 + word.length] ?? '')) return i;
  }
  return -1;
}

interface CompClause {
  targets: string;
  iter: string;
  conds: string[];
}

/** `elem for t in it if c for u in it2` -> its element and clauses, or undefined when it is not one. */
function parseComprehension(inner: string): { elem: string; clauses: CompClause[] } | undefined {
  if (!/\sfor\s/.test(inner)) return undefined;
  let at = keywordAtDepth0(inner, 'for');
  if (at < 0) return undefined;
  const elem = inner.slice(0, at).trim().replace(/\s+async$/, '');
  const clauses: CompClause[] = [];
  while (at >= 0) {
    const targetsFrom = at + 5;
    const inAt = keywordAtDepth0(inner, 'in', targetsFrom);
    if (inAt < 0) return undefined;
    const nextBoundary = (from: number) => {
      const f = keywordAtDepth0(inner, 'for', from);
      const i = keywordAtDepth0(inner, 'if', from);
      return f < 0 ? i : i < 0 ? f : Math.min(f, i);
    };
    let b = nextBoundary(inAt + 4);
    const clause: CompClause = { targets: inner.slice(targetsFrom, inAt).trim(), iter: inner.slice(inAt + 4, b < 0 ? undefined : b).trim(), conds: [] };
    while (b >= 0 && inner.startsWith('if', b + 1)) {
      const next = nextBoundary(b + 4);
      clause.conds.push(inner.slice(b + 4, next < 0 ? undefined : next).trim());
      b = next;
    }
    if (!elem || !clause.targets || !clause.iter || clause.conds.some((c) => !c)) return undefined;
    clauses.push(clause);
    at = b;
  }
  return { elem, clauses };
}

/** The names bound by a comprehension target, as `name -> Java read of it from param`. */
function targetReads(targets: string, param: string, entries: boolean): Map<string, string> {
  const reads = new Map<string, string>();
  const walk = (text: string, base: string, isEntry: boolean) => {
    let t = text.trim();
    if (/^[(\[]/.test(t) && groupEnd(t, 0) === t.length) t = t.slice(1, -1);
    const parts = splitTopLevel(t).map((x) => x.trim()).filter(Boolean);
    parts.forEach((part, k) => {
      const read = isEntry && parts.length === 2 ? `${base}.${k === 0 ? 'getKey' : 'getValue'}()` : `${base}.get(${k})`;
      if (/^\w+$/.test(part)) reads.set(part, read);
      else walk(part, read, false);
    });
  };
  walk(targets, param, entries);
  return reads;
}

/**
 * One comprehension clause chain as a stream: each clause filters by its conditions; every
 * clause but the last flat-maps into the next, and the last maps to the element. A tuple
 * target becomes one parameter (`item`) whose parts are read where the names were used.
 */
function comprehensionStream(clauses: CompClause[], elem: string, used: string, toEntry: boolean): string {
  const [first, ...rest] = clauses;
  let param = first.targets.replace(/^\((\w+)\)$/, '$1');
  let rename = (x: string) => x;
  if (!/^\w+$/.test(param)) {
    param = 'item';
    for (let n = 2; new RegExp(`\\b${param}\\b`).test(used); n += 1) param = `item${n}`;
    const reads = targetReads(first.targets, param, /\.items\(\)$/.test(first.iter));
    rename = (x: string) => x.replace(/(?<![\w.\x01])([A-Za-z_]\w*)(?![\w\x01]|\s*=(?!=))/g, (m, name: string) => reads.get(name) ?? m);
  }
  let out = streamOf(first.iter);
  for (const c of first.conds) out += `.filter(${param} -> ${rename(c)})`;
  if (rest.length) {
    const inner = rest.map((c) => ({ ...c, iter: rename(c.iter), conds: c.conds.map(rename) }));
    return `${out}.flatMap(${param} -> ${comprehensionStream(inner, rename(elem), used + param, toEntry)})`;
  }
  const e = rename(elem);
  if (toEntry) {
    const colon = indexAtDepth0(e, /:/);
    return `${out}.map(${param} -> Map.entry(${e.slice(0, colon).trim()}, ${e.slice(colon + 1).trim()}))`;
  }
  return e === param ? out : `${out}.map(${param} -> ${e})`;
}

/** A list/set/dict comprehension or generator expression (the inside of `kind` brackets) as a stream, or undefined. */
function comprehension(inner: string, kind: string): string | undefined {
  const comp = parseComprehension(inner);
  if (!comp) return undefined;
  const { elem, clauses } = comp;
  if (kind === '[') return `${comprehensionStream(clauses, elem, inner, false)}.toList()`;
  if (kind === '(') return `(${comprehensionStream(clauses, elem, inner, false)})`;
  if (indexAtDepth0(elem, /:/) < 0) return `${comprehensionStream(clauses, elem, inner, false)}.collect(Collectors.toSet())`;
  // A dict: one clause maps straight into toMap; more go through entries.
  if (clauses.length === 1 && /^\(?\w+\)?$/.test(clauses[0].targets)) {
    const p = clauses[0].targets.replace(/[()]/g, '');
    let out = streamOf(clauses[0].iter);
    for (const c of clauses[0].conds) out += `.filter(${p} -> ${c})`;
    const colon = indexAtDepth0(elem, /:/);
    return `${out}.collect(Collectors.toMap(${p} -> ${elem.slice(0, colon).trim()}, ${p} -> ${elem.slice(colon + 1).trim()}))`;
  }
  return `${comprehensionStream(clauses, elem, inner, true)}.collect(Collectors.toMap(Map.Entry::getKey, Map.Entry::getValue))`;
}

/**
 * Rewrites list/set/dict comprehensions and generator expressions into stream pipelines,
 * innermost first, at any nesting depth:
 *
 *   [p.name for p in ps if p.active]   -> ps.stream().filter(p -> p.active).map(p -> p.name).toList()
 *   [v for (k, v) in d.items()]        -> d.items().stream().map(item -> item.getValue()).toList()
 *   [x * y for x in xs for y in ys]    -> xs.stream().flatMap(x -> ys.stream().map(y -> x * y)).toList()
 */
function rewriteComprehensions(text: string): string {
  // Every comprehension has ` for `; most expressions are done here.
  if (!/\sfor\s/.test(text)) return text;
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch !== '(' && ch !== '[' && ch !== '{') {
      out += ch;
      i += 1;
      continue;
    }
    const end = groupEnd(text, i);
    if (end < 0) {
      out += text.slice(i);
      break;
    }
    const inner = rewriteComprehensions(text.slice(i + 1, end - 1));
    out += comprehension(inner, ch) ?? `${ch}${inner}${text[end - 1]}`;
    i = end;
  }
  return out;
}

/** `A if C else B` -> `C ? A : B` (one expression, top level). */
function rewriteTernaryFlat(text: string): string {
  const ifIdx = indexAtDepth0(text, /\sif\s/);
  if (ifIdx < 0) return text;
  // Dict entry `key: value if c else other` or lambda `x -> value if c else other`:
  // only the value part is a ternary.
  const arrow = text.lastIndexOf('->', ifIdx);
  const colon = indexAtDepth0(text, /:/);
  const cut = Math.max(arrow >= 0 ? arrow + 2 : -1, colon >= 0 && colon < ifIdx ? colon + 1 : -1);
  if (cut > 0) {
    return text.slice(0, cut) + ' ' + rewriteTernaryFlat(text.slice(cut).trim());
  }
  const elseIdx = indexAtDepth0(text, /\selse\s/, ifIdx + 3);
  if (elseIdx < 0) return text;
  const a = text.slice(0, ifIdx).trim();
  const c = text.slice(ifIdx + 4, elseIdx).trim();
  const b = text.slice(elseIdx + 6).trim();
  if (!a || !c || !b) return text;
  return `${c} ? ${a} : ${b}`;
}

/** Index just past the matching close bracket of the group opening at `i`, or -1. */
function groupEnd(text: string, i: number): number {
  const open = text[i];
  const close = open === '(' ? ')' : open === '[' ? ']' : '}';
  let depth = 0;
  for (let j = i; j < text.length; j += 1) {
    if (text[j] === open) depth += 1;
    else if (text[j] === close) {
      depth -= 1;
      if (depth === 0) return j + 1;
    }
  }
  return -1;
}

/** Words and punctuation that end a comparison chain at bracket depth 0. */
const CHAIN_BOUNDARY = /(?:[,:;]|(?:and|or|not|if|else|for|in|is|lambda|return|yield|await)\b)/y;

/** `a < b <= c` (one segment, no boundary inside) -> `a < b and b <= c`, else unchanged. */
function splitComparisonChain(segment: string): string {
  const ops: Array<{ at: number; op: string }> = [];
  let depth = 0;
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i];
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (depth === 0) {
      const two = segment.slice(i, i + 2);
      if (two === '<<' || two === '>>' || two === '->') i += 1;
      else if (two === '<=' || two === '>=' || two === '==' || two === '!=') {
        ops.push({ at: i, op: two });
        i += 1;
      } else if (ch === '<' || ch === '>') ops.push({ at: i, op: ch });
    }
  }
  if (ops.length < 2) return segment;
  const lead = /^\s*/.exec(segment)![0];
  const trail = /\s*$/.exec(segment)![0];
  const operands: string[] = [];
  let from = 0;
  for (const { at, op } of ops) {
    operands.push(segment.slice(from, at).trim());
    from = at + op.length;
  }
  operands.push(segment.slice(from).trim());
  if (operands.some((o) => o === '')) return segment;
  const pairs = ops.map(({ op }, k) => `${operands[k]} ${op} ${operands[k + 1]}`);
  return `${lead}${pairs.join(' and ')}${trail}`;
}

/**
 * Python chains comparisons, Java does not: `0 <= i < n` -> `0 <= i and i < n` (the `and`
 * becomes `&&` later), at every bracket depth. A middle operand is repeated as written.
 */
function rewriteChainedComparisons(text: string): string {
  // Cheap exit for the common case (and for 30 KB literal tables): fewer than two comparisons.
  if ((text.match(/[<>]=?|[=!]=/g)?.length ?? 0) < 2) return text;
  let out = '';
  let segment = '';
  let afterNot = false;
  const flush = () => {
    const chained = splitComparisonChain(segment);
    // `not a < b < c` negates the whole chain.
    out += chained !== segment && afterNot ? ` (${chained.trim()})${/\s*$/.exec(segment)![0]}` : chained;
    segment = '';
  };
  for (let i = 0; i < text.length; ) {
    const ch = text[i];
    if (ch === '(' || ch === '[' || ch === '{') {
      const end = groupEnd(text, i);
      if (end < 0) {
        segment += text.slice(i);
        break;
      }
      segment += ch + rewriteChainedComparisons(text.slice(i + 1, end - 1)) + text[end - 1];
      i = end;
      continue;
    }
    CHAIN_BOUNDARY.lastIndex = i;
    const boundary = /[\w\u0001]/.test(text[i - 1] ?? '') ? null : CHAIN_BOUNDARY.exec(text);
    if (boundary) {
      flush();
      out += boundary[0];
      afterNot = boundary[0] === 'not';
      i += boundary[0].length;
      continue;
    }
    segment += ch;
    i += 1;
  }
  flush();
  return out;
}

/** Words after which `(...)` is a value, not a call's argument list (`return (a, b)`). */
const VALUE_KEYWORDS = new Set(['return', 'in', 'not', 'and', 'or', 'if', 'else', 'elif', 'yield', 'await', 'is', 'lambda', 'assert', 'del', 'from']);

/**
 * Python tuple literals -> `Tuple.of(...)`: `(a, b)`, `(x,)`, `()`, at every bracket depth. A
 * call's argument list is not a tuple, nor a `for (a, b) in` target, nor the operand of
 * `"..." % (a, b)` (a format call later). After `in` a tuple is a collection to test or walk,
 * so it becomes `List.of(...)`.
 */
function rewriteTuples(text: string): string {
  if (!text.includes('(')) return text;
  let out = '';
  for (let i = 0; i < text.length; ) {
    if (text[i] !== '(') {
      out += text[i];
      i += 1;
      continue;
    }
    const end = groupEnd(text, i);
    if (end < 0) {
      out += text.slice(i);
      break;
    }
    const inner = rewriteTuples(text.slice(i + 1, end - 1));
    const before = out.replace(/\s+$/, '');
    const prevWord = /(?<![.\w])(\w+)$/.exec(before)?.[1];
    const isValueKeyword = prevWord !== undefined && VALUE_KEYWORDS.has(prevWord);
    const isCall = /[\w)\]\u0001]$/.test(before) && !isValueKeyword;
    const isTuple = !isCall && prevWord !== 'for' && !/%$/.test(before) && (inner.trim() === '' || indexAtDepth0(inner, /,/) >= 0);
    out += isTuple ? `${prevWord === 'in' ? 'List' : 'Tuple'}.of(${splitTopLevel(inner).join(', ')})` : `(${inner})`;
    i = end;
  }
  return out;
}

/** `x` as a receiver: kept as is when it is a name, call or bracket group, else parenthesized. */
function receiver(x: string): string {
  const e = x.trim();
  return /^[\w.]+(\([^()]*\))*$/.test(e) || (/^\(/.test(e) && groupEnd(e, 0) === e.length) ? e : `(${e})`;
}

/** The expression after `*` in a single-star item (`*xs`), or undefined. */
function starred(item: string): string | undefined {
  return /^\*(?!\*)\s*([\s\S]+)$/.exec(item.trim())?.[1];
}

/** Items with `*xs` among them as one stream: `Stream.of(Stream.of(a), xs.stream()).flatMap(Function.identity())`. */
function streamOfItems(items: string[]): string {
  const parts: string[] = [];
  let plain: string[] = [];
  const flush = () => {
    if (plain.length) parts.push(`Stream.of(${plain.join(', ')})`);
    plain = [];
  };
  for (const item of items) {
    const x = starred(item);
    if (x === undefined) plain.push(item.trim());
    else {
      flush();
      parts.push(`${receiver(x)}.stream()`);
    }
  }
  flush();
  // Method references, not lambdas: a lambda parameter may not reuse a local's name.
  return parts.length === 1 ? parts[0] : `Stream.of(${parts.join(', ')}).flatMap(Function.identity())`;
}

/**
 * Star-unpacking, which Java has no syntax for (runs after the tuple pass):
 *
 *   f(*xs)             -> f(xs.toArray())
 *   f(a, *xs)          -> f(Stream.of(Stream.of(a), xs.stream()).flatMap(Function.identity()).toArray())
 *   [*xs, a], {*xs, a} -> the same stream .toList() / .collect(Collectors.toSet())
 *   {**d, "k": v}      -> the maps merged in order, later keys winning (LinkedHashMap)
 *
 * The array goes to a varargs parameter; keyword arguments and `**kwargs` stay as they are.
 */
function rewriteStarUnpacking(text: string): string {
  if (!/(^|[(\[{,]\s*)\*/.test(text)) return text;
  let out = '';
  for (let i = 0; i < text.length; ) {
    const open = text[i];
    if (open !== '(' && open !== '[' && open !== '{') {
      out += open;
      i += 1;
      continue;
    }
    const end = groupEnd(text, i);
    if (end < 0) {
      out += text.slice(i);
      break;
    }
    const inner = rewriteStarUnpacking(text.slice(i + 1, end - 1));
    const items = splitTopLevel(inner);
    const hasStar = items.some((it) => starred(it) !== undefined);
    const hasDoubleStar = items.some((it) => /^\*\*/.test(it.trim()));
    const before = out.replace(/\s+$/, '');
    const afterValue = /[\w)\]\u0001]$/.test(before);
    i = end;
    if (open === '(' && hasStar && afterValue) {
      // A call: the positional arguments become one array for the varargs parameter.
      const keyword = (it: string) => /^\w+\s*=(?!=)/.test(it.trim()) || /^\*\*/.test(it.trim());
      const positional = items.filter((it) => !keyword(it));
      const rest = items.filter(keyword);
      const single = positional.length === 1 ? starred(positional[0]) : undefined;
      const array = single !== undefined ? `${receiver(single)}.toArray()` : `${streamOfItems(positional)}.toArray()`;
      out += `(${[array, ...rest].join(', ')})`;
    } else if (open === '[' && hasStar && !afterValue) {
      out += `${streamOfItems(items)}.toList()`;
    } else if (open === '{' && hasDoubleStar) {
      // Merge in order; consecutive `k: v` entries stay a dict literal (Map.of later).
      const maps: string[] = [];
      let entries: string[] = [];
      const flush = () => {
        if (entries.length) maps.push(`{${entries.join(', ')}}`);
        entries = [];
      };
      for (const it of items) {
        const m = /^\*\*\s*([\s\S]+)$/.exec(it.trim());
        if (m) {
          flush();
          maps.push(m[1]);
        } else entries.push(it.trim());
      }
      flush();
      out += `Stream.of(${maps.join(', ')}).map(Map::entrySet).flatMap(Set::stream).collect(Collectors.toMap(Map.Entry::getKey, Map.Entry::getValue, (older, newer) -> newer, LinkedHashMap::new))`;
    } else if (open === '{' && hasStar) {
      out += `${streamOfItems(items)}.collect(Collectors.toSet())`;
    } else {
      out += `${open}${inner}${text[end - 1]}`;
    }
  }
  return out;
}

/** Applies the ternary rewrite to every comma-separated item at every bracket depth. */
function rewriteTernary(text: string): string {
  if (!/\sif\s/.test(text)) return text;
  // First rewrite inside bracket groups (innermost first), then the top level.
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '(' || ch === '[' || ch === '{') {
      const close = ch === '(' ? ')' : ch === '[' ? ']' : '}';
      let depth = 0;
      let j = i;
      for (; j < text.length; j += 1) {
        if (text[j] === ch) depth += 1;
        else if (text[j] === close) {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      if (j >= text.length) {
        out += text.slice(i);
        break;
      }
      out += ch + rewriteTernary(text.slice(i + 1, j)) + close;
      i = j + 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  const items = splitTopLevel(out).map((item) => rewriteTernaryFlat(item));
  // splitTopLevel trims items; rejoin with ", " only when there really were commas.
  return items.length > 1 ? items.join(', ') : rewriteTernaryFlat(out);
}

/**
 * Handles `[` ... `]` occurrences: literals become List.of / new ArrayList, subscripts
 * become .get(i) / .subList(a, b).
 */
/** Builtin names that read as types inside `X[...]`. */
const TYPE_ARG_NAMES = /^(?:int|float|str|bytes|bool|complex|object|list|dict|set|tuple|type|None|Any|\.\.\.)$/;

/**
 * Whether the inside of `Name[...]` reads as type arguments (`str, List<int>`, `typing.Any`,
 * `[int], str`) rather than an index (`0`, `dt.month`, `i + 1`): every item is a name whose
 * last part is capitalized or a builtin type, optionally with type arguments of its own.
 */
function looksLikeTypeArgs(receiver: string, inner: string): boolean {
  if (/^(?:Literal|Annotated)$/.test(receiver)) return true;
  const items = splitTopLevel(inner).map((s) => s.trim());
  return items.length > 0 && items.every((item) => {
    if (/^(?:List\.of\(.*\)|new ArrayList<>\(\))$/.test(item)) return true; // Callable[[A, B], R]
    const m = /^([\w.]+|\.\.\.)\s*(?:<.*>)?$/.exec(item);
    if (!m) return false;
    return TYPE_ARG_NAMES.test(m[1]) || /^[A-Z]/.test(m[1].split('.').pop()!);
  });
}

/** A slice bound on `recv`: Python counts a negative bound from the end (`-2` -> `xs.size() - 2`). */
export function sliceBound(recv: string, bound: string, dflt: string): string {
  if (bound === '') return dflt;
  const neg = /^-\s*(\w+|\(.*\))$/.exec(bound);
  return neg ? `${recv}.size() - ${neg[1]}` : bound;
}

function rewriteBrackets(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch !== '[') {
      out += ch;
      i += 1;
      continue;
    }
    // find matching bracket
    let depth = 0;
    let j = i;
    for (; j < text.length; j += 1) {
      if (text[j] === '[') depth += 1;
      else if (text[j] === ']') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    if (j >= text.length) {
      out += text.slice(i);
      break;
    }
    const inner = rewriteBrackets(text.slice(i + 1, j));
    const prevChar = out.replace(/\s+$/, '').slice(-1);
    // `x in [a, b]`, `return [a]`: a keyword before `[` starts a list, it is not a subscripted name.
    const afterKeyword = /(?:^|[^\w.])(?:in|not|and|or|is|if|else|return|yield|lambda|await|assert|del|from)\s*$/.test(out);
    const isSubscript = !afterKeyword && (/[\w)\]}"]/.test(prevChar) || /\x01$/.test(out.replace(/\s+$/, '')));
    if (!isSubscript) {
      const items = splitTopLevel(inner).filter(Boolean);
      out += items.length === 0 ? 'new ArrayList<>()' : `List.of(${items.join(', ')})`;
    } else {
      // Type hints such as List[int] look like subscripts on capitalized names - leave them alone.
      const receiverMatch = /([\w.]+|\))\s*$/.exec(out);
      const receiver = receiverMatch ? receiverMatch[1] : '';
      if (/^[A-Z]\w*$/.test(receiver) && /[a-z]/.test(receiver) && !/^(list|dict|set|tuple|type)$/i.test(receiver) && looksLikeTypeArgs(receiver, inner)) {
        out += `<${inner}>`;
      } else if (indexAtDepth0(inner, /:/) >= 0) {
        const [lo, hi, step] = splitTopLevel(inner, ':').concat(['', '', '']).map((x) => x.trim());
        if (step === '-1' && lo === '' && hi === '') {
          out += `.reversed()`;
        } else if (/^[\w.]+$/.test(receiver) && !step) {
          // A plain name: subList, with Python's negative bounds counted from the end.
          if (lo === '' && hi === '') out = `${out.slice(0, out.length - receiver.length)}new ArrayList<>(${receiver})`;
          else out += `.subList(${sliceBound(receiver, lo, '0')}, ${sliceBound(receiver, hi, `${receiver}.size()`)})`;
        } else {
          // A call or subscript (evaluated once), or a step: the runtime helper, which also clamps.
          const trimmed = out.replace(/\s+$/, '');
          const start = postfixStart(trimmed, trimmed.length);
          const recv = trimmed.slice(start);
          const args = [lo || 'null', hi || 'null', ...(step ? [step] : [])];
          out = `${trimmed.slice(0, start)}Py.slice(${recv}, ${args.join(', ')})`;
        }
      } else if (/^-\d+$/.test(inner.trim())) {
        const n = inner.trim().slice(1);
        if (/^[\w.]+$/.test(receiver)) out += `.get(${receiver}.size() - ${n})`;
        else if (n === '1') out += '.getLast()';
        else {
          const trimmed = out.replace(/\s+$/, '');
          const start = postfixStart(trimmed, trimmed.length);
          out = `${trimmed.slice(0, start)}Py.at(${trimmed.slice(start)}, -${n})`;
        }
      } else {
        out += `.get(${inner})`;
      }
    }
    i = j + 1;
  }
  return out;
}

/** `{k: v}` -> Map.of(k, v); `{a, b}` -> Set.of(a, b); `{}` -> new HashMap<>() */
function rewriteBraces(text: string): string {
  let prev = '';
  let cur = text;
  let guard = 0;
  while (prev !== cur && guard < 20) {
    prev = cur;
    guard += 1;
    cur = cur.replace(/\{([^{}]*)\}/, (_m, inner: string) => {
      const items = splitTopLevel(inner).filter(Boolean);
      if (items.length === 0) return 'new HashMap<>()';
      const isMap = items.every((it) => indexAtDepth0(it, /:/) >= 0);
      if (isMap) {
        const pairs = items.map((it) => {
          const idx = indexAtDepth0(it, /:/);
          return `${it.slice(0, idx).trim()}, ${it.slice(idx + 1).trim()}`;
        });
        return `Map.of(${pairs.join(', ')})`;
      }
      return `Set.of(${items.join(', ')})`;
    });
  }
  return cur;
}

const KEYWORD_RULES: Array<[RegExp, string]> = [
  [/\bis\s+not\b/g, '!='],
  [/\bis\b/g, '=='],
  [/\band\b/g, '&&'],
  [/\bor\b/g, '||'],
  [/\bnot\s+(?!in\b)/g, '!'],
  [/\bNone\b/g, 'null'],
  [/\bTrue\b/g, 'true'],
  [/\bFalse\b/g, 'false'],
  [/\bself\b/g, 'this'],
  [/\bawait\s+/g, '/* await */ '],
  [/\s*:=\s*/g, ' = /* walrus */ '],
];

const BUILTIN_TYPE_CLASSES: Record<string, string> = { int: 'Integer', float: 'Double', str: 'String', bool: 'Boolean', bytes: 'byte[]', object: 'Object' };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const BUILTIN_RULES: Array<[RegExp, string | ((...args: any[]) => string)]> = [
  [/\bprint\(/g, 'System.out.println('],
  [/\bstr\(/g, 'String.valueOf('],
  [new RegExp(`\\bint\\((?=${PLACEHOLDER_RE})`, 'g'), 'Integer.parseInt('],
  [new RegExp(`\\bfloat\\((?=${PLACEHOLDER_RE})`, 'g'), 'Double.parseDouble('],
  [/\bint\(/g, '(int) ('],
  [/\bfloat\(/g, '(double) ('],
  [/\bbool\(/g, 'Boolean.valueOf('],
  [/\bsuper\(\)\.__init__\(/g, 'super('],
  [/\bsuper\(\)\./g, 'super.'],
  [/\bsuper\([\w.]+,\s*\w+\)\./g, 'super.'],
  [/\babs\(/g, 'Math.abs('],
  // A builtin type used as a value (`d[int] = f`, `x in (int, float)`) is its Java class;
  // `(int)` alone is a cast made above and `int.from_bytes` an attribute.
  [/(?<![\w.])(int|float|str|bool|bytes|object)\b(?![\w.(]|\s*=(?!=))/g, (m: string, name: string, at: number, whole: string) =>
    whole[at - 1] === '(' && whole[at + m.length] === ')' ? m : `${BUILTIN_TYPE_CLASSES[name]}.class`],
  [new RegExp(`(${PLACEHOLDER_RE})\\s*\\*\\s*(${S})`, 'g'), '$1.repeat($2)'],
  [/\btype\(([\w.]+)\)/g, '$1.getClass()'],
  [/\.__class__\.__name__/g, '.getClass().getSimpleName()'],
  [/\.__class__/g, '.getClass()'],
  [/\.__name__/g, '.getName()'],
  [/\.append\(/g, '.add('],
  [/\.extend\(/g, '.addAll('],
  [/\.insert\(/g, '.add('],
  [/\.items\(\)/g, '.entrySet()'],
  [/\.keys\(\)/g, '.keySet()'],
  [new RegExp(`\\.get\\((${S}),\\s*`, 'g'), '.getOrDefault($1, '],
  [new RegExp(`\\.setdefault\\((${S}),\\s*`, 'g'), '.computeIfAbsent($1, key -> '],
  [/\.update\(/g, '.putAll('],
  [/\.strip\(\)/g, '.trim()'],
  [/\.lower\(\)/g, '.toLowerCase()'],
  [/\.upper\(\)/g, '.toUpperCase()'],
  [/\.startswith\(/g, '.startsWith('],
  [/\.endswith\(/g, '.endsWith('],
  [/\.find\(/g, '.indexOf('],
  [/\.isdigit\(\)/g, '.chars().allMatch(Character::isDigit)'],
  [/\.copy\(\)/g, '.copy() /* shallow copy */'],
  [new RegExp(`(${PLACEHOLDER_RE})\\.join\\(`, 'g'), 'String.join($1, '],
  [new RegExp(`(${PLACEHOLDER_RE})\\.format\\(`, 'g'), 'String.format($1, '],
];

/**
 * Python's `%` string formatting: `"%s=%d" % (k, v)` / `fmt % (k, v)` -> `String.format(fmt, k, v)`
 * and `"%s" % f(x)` -> `String.format("%s", f(x))`. A string literal on the left, or a tuple on
 * the right (a number cannot be taken modulo a tuple), marks it as formatting.
 */
function rewritePercentFormat(text: string): string {
  return rewriteInfix(text, /\s*%(?!=)\s*/g, (left, right) => {
    const items = tupleItems(right);
    if (items) return `String.format(${left}, ${items.join(', ')})`;
    if (!new RegExp(`^${PLACEHOLDER_RE}$`).test(left)) return undefined;
    return `String.format(${left}, ${right})`;
  });
}

function rewriteOperators(text: string): string {
  let t = text;
  // power and floor division
  if (t.includes('**')) t = rewriteInfix(t, /\s*\*\*\s*/g, (a, b) => `Math.pow(${a}, ${b})`);
  if (t.includes('//')) t = rewriteInfix(t, /\s*\/\/\s*/g, (a, b) => `Math.floorDiv(${a}, ${b})`);
  // Whatever is left of `//` must not survive - it would start a Java comment.
  t = t.replace(/\/\//g, '/ /* floor div */');
  t = t.replace(/\*\*(\w)/g, '/* ** */ $1');
  // membership tests: `x in (a, b)` -> List.of(a, b).contains(x); `x in y` -> y.contains(x)
  if (/\sin\s/.test(t)) {
    t = rewriteInfix(t, /\s+(not\s+)?in\s+/g, (x, coll, m) => {
      const items = tupleItems(coll);
      const target = items ? `List.of(${items.join(', ')})` : coll;
      return `${m[1] ? '!' : ''}${target}.contains(${x})`;
    });
  }
  return t;
}

function lambdaParams(vars: string): string {
  const parts = splitTopLevel(vars).map((v) => v.trim()).filter(Boolean);
  if (parts.length === 1 && /^\w+$/.test(parts[0])) return parts[0];
  return `(${parts.join(', ')})`;
}

function rewriteLambda(text: string): string {
  return text.replace(/\blambda\s*([^:()]*?)\s*:\s*/g, (_m, params: string) => {
    const p = params.trim() === '' ? '()' : lambdaParams(params);
    return `${p} -> `;
  });
}

function rewriteExceptionNames(text: string): string {
  return text.replace(/\b([A-Z]\w*(?:Error|Exception|Iteration))\b/g, (m) => EXCEPTIONS[m] ?? m);
}

/**
 * Translate a masked Python expression to a masked Java-flavored expression.
 * Strings stay as placeholders; the caller unmasks.
 */
export function translateMaskedExpression(masked: string, ctx: ExprContext = {}): string {
  // Python joins adjacent string literals ("a " "b"); Java needs an explicit +.
  let t = masked.replace(new RegExp(`(${PLACEHOLDER_RE})\\s+(?=${PLACEHOLDER_RE})`, 'g'), '$1 + ');
  t = rewriteIntLiterals(t);
  t = rewriteChainedComparisons(t);
  t = rewriteTuples(t);
  t = rewriteStarUnpacking(t);
  t = rewriteComprehensions(t);
  t = rewriteLambda(t);
  t = rewriteTernary(t);
  t = rewriteBrackets(t);
  t = rewriteBraces(t);
  if (ctx.valueContext) t = rewriteOrFallback(t);
  for (const [re, rep] of KEYWORD_RULES) t = t.replace(re, rep);
  if (t.includes('%')) t = rewritePercentFormat(t);
  if (ctx.className) t = t.replace(/\bcls\b/g, ctx.className);
  const literals = ctx.literals;
  t = rewriteBuiltinCalls(t, {
    literal: (token) => {
      const idx = new RegExp(`^${PLACEHOLDER_RE}$`).test(token) ? Number(token.slice(1, -1)) : -1;
      return idx >= 0 ? literals?.[idx] : undefined;
    },
  });
  for (const [re, rep] of BUILTIN_RULES) t = t.replace(re, rep as string);
  t = rewriteOperators(t);
  t = rewriteExceptionNames(t);
  // keyword arguments: f(name=value) -> f(/* name = */ value)
  t = t.replace(/([(,]\s*)([A-Za-z_]\w*)\s*=(?!=)\s*/g, '$1/* $2 = */ ');
  // constructor calls: Foo(...) / pkg.Foo(...) -> new Foo(...)
  t = t.replace(/(^|[^\w.@])((?:[a-z_]\w*\.)*[A-Z]\w*)\(/g, (m, pre: string, name: string, offset: number, whole: string) => {
    if (/(^|[\s(])new\s$/.test(whole.slice(0, offset + pre.length))) return m;
    if (/^(List|Map|Set|Math|String|Integer|Double|Boolean|Collectors|Tuple|Optional|Objects|Arrays|Collections|Character|CompletableFuture|IntStream|Comparator|BigDecimal|Number)$/.test(name)) return m;
    return `${pre}new ${name}(`;
  });
  // Python property reads look like field reads; render them as the accessor call they are.
  if (ctx.propertyAccessor) {
    t = t.replace(/\.([A-Za-z_]\w*)(?![\w(])/g, (m, name: string, offset: number, whole: string) => {
      const before = whole[offset - 1];
      if (before === undefined || /[\d.\s]/.test(before)) return m; // 1.5, "..", or a stray dot
      const acc = ctx.propertyAccessor!(name);
      return acc ? `.${acc}` : m;
    });
  }
  if (ctx.fieldRenames?.size) {
    t = t.replace(/\bthis\.(\w+)\b(?!\()/g, (m, field: string) => {
      const renamed = ctx.fieldRenames!.get(field);
      return renamed ? `this.${renamed}` : m;
    });
  }
  if (ctx.localFunctions?.size) t = rewriteLocalFunctionCalls(t, ctx.localFunctions);
  // A one-element tuple `(x,)` is not a parenthesized `x`; any other trailing comma
  // (`f(a, b, )`) is fine in Python and a syntax error in Java.
  t = t.replace(/(?<![\w)\]])\(([^(),]+),\s*\)/g, 'Tuple.of($1)');
  t = t.replace(/,\s*\)/g, ')');
  if (t.includes(')(')) t = rewriteCallsOnValues(t, ctx.className);
  return t;
}

/** Translate a raw (unmasked) Python expression. */
export function translateExpression(expr: string, ctx: ExprContext = {}): string {
  const masked = maskStrings(expr);
  const out = translateMaskedExpression(masked.text, { ...ctx, literals: masked.literals });
  return unmaskStrings(out, masked.literals);
}

// f-string fields ({name}, {total:.2f}) are expressions too. Literals are rendered while the
// statement is being masked, before any translate call, so the statement translator hands the
// context (class name, property accessors, field renames) over up front.
let fStringContext: ExprContext = {};
export function setFStringExpressionContext(ctx: ExprContext): void {
  fStringContext = ctx;
}
setFStringExpressionHook((e) => translateExpression(e, fStringContext));
