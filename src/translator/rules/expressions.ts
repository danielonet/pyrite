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

function lambdaParams(vars: string): string {
  const parts = splitTopLevel(vars).map((v) => v.trim()).filter(Boolean);
  if (parts.length === 1 && /^\w+$/.test(parts[0])) return parts[0];
  return `(${parts.join(', ')})`;
}

// Sub-expression patterns allowing one level of nested brackets of the same kind.
const G = '(?:[^()]|\\([^()]*\\))+?';
const L = '(?:[^\\[\\]]|\\[[^\\[\\]]*\\])+?';
const B = '(?:[^{}]|\\{[^{}]*\\})+?';

/** Rewrites list/set/dict comprehensions and generator expressions into stream pipelines. */
function rewriteComprehensions(text: string): string {
  // Every comprehension has ` for `; without it the nested-bracket regexes below would still
  // crawl a large literal (a 30 KB dict table) for seconds.
  if (!/\sfor\s/.test(text)) return text;
  const build = (expr: string, vars: string, iter: string, cond: string | undefined, terminal: string) => {
    const p = lambdaParams(vars);
    let out = streamOf(iter.trim());
    if (cond) out += `.filter(${p} -> ${cond.trim()})`;
    if (expr.trim() !== vars.trim()) out += `.map(${p} -> ${expr.trim()})`;
    return out + terminal;
  };
  let prev = '';
  let cur = text;
  let guard = 0;
  while (prev !== cur && guard < 20) {
    prev = cur;
    guard += 1;
    // dict comprehension {k: v for x in it if c}
    cur = cur.replace(
      new RegExp(`\\{(${B}):\\s*(${B})\\s+for\\s+([\\w, ()]+?)\\s+in\\s+(${B})(?:\\s+if\\s+(${B}))?\\}`),
      (_m, k: string, v: string, vars: string, iter: string, cond?: string) => {
        const p = lambdaParams(vars);
        let out = streamOf(iter.trim());
        if (cond) out += `.filter(${p} -> ${cond.trim()})`;
        return `${out}.collect(Collectors.toMap(${p} -> ${k.trim()}, ${p} -> ${v.trim()}))`;
      },
    );
    // set comprehension
    cur = cur.replace(
      new RegExp(`\\{((?:[^{}:]|\\{[^{}]*\\})+?)\\s+for\\s+([\\w, ()]+?)\\s+in\\s+(${B})(?:\\s+if\\s+(${B}))?\\}`),
      (_m, e: string, vars: string, iter: string, cond?: string) => build(e, vars, iter, cond, '.collect(Collectors.toSet())'),
    );
    // list comprehension
    cur = cur.replace(
      new RegExp(`\\[(${L})\\s+for\\s+([\\w, ()]+?)\\s+in\\s+(${L})(?:\\s+if\\s+(${L}))?\\]`),
      (_m, e: string, vars: string, iter: string, cond?: string) => build(e, vars, iter, cond, '.toList()'),
    );
    // generator expression (also covers sum(x for x in xs))
    cur = cur.replace(
      new RegExp(`\\((${G})\\s+for\\s+([\\w, ()]+?)\\s+in\\s+(${G})(?:\\s+if\\s+(${G}))?\\)`),
      (_m, e: string, vars: string, iter: string, cond?: string) => `(${build(e, vars, iter, cond, '')})`,
    );
  }
  return cur;
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
    const isSubscript = /[\w)\]"]/.test(prevChar) || /\x01$/.test(out.replace(/\s+$/, ''));
    if (!isSubscript) {
      const items = splitTopLevel(inner).filter(Boolean);
      out += items.length === 0 ? 'new ArrayList<>()' : `List.of(${items.join(', ')})`;
    } else {
      // Type hints such as List[int] look like subscripts on capitalized names - leave them alone.
      const receiverMatch = /([\w.]+|\))\s*$/.exec(out);
      const receiver = receiverMatch ? receiverMatch[1] : '';
      if (/^[A-Z]\w*$/.test(receiver) && /^(list|dict|set|tuple|type)$/i.test(receiver) === false && /^[A-Z]/.test(receiver)) {
        out += `<${inner}>`;
      } else if (inner.includes(':')) {
        const [a, b, step] = splitTopLevel(inner, ':').concat(['', '', '']).map((s) => s.trim());
        const parts = inner.split(':');
        const lo = parts[0]?.trim() ?? '';
        const hi = parts[1]?.trim() ?? '';
        if (step === '-1' && lo === '' && hi === '') {
          out += `.reversed()`;
        } else {
          const recv = receiver || 'seq';
          // Python counts negative bounds from the end: xs[-2:] -> subList(xs.size() - 2, xs.size()).
          const bound = (v: string, dflt: string) => (v === '' ? dflt : /^-\d+$/.test(v) ? `${recv}.size() - ${v.slice(1)}` : v);
          out += `.subList(${bound(lo, '0')}, ${bound(hi, `${recv}.size()`)})`;
          void a;
          void b;
        }
      } else if (/^-\d+$/.test(inner.trim())) {
        const recv = receiver || 'seq';
        const n = inner.trim().slice(1);
        out += n === '1' ? `.get(${recv}.size() - 1)` : `.get(${recv}.size() - ${n})`;
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

const BUILTIN_RULES: Array<[RegExp, string]> = [
  [/\bprint\(/g, 'System.out.println('],
  [/\bstr\(/g, 'String.valueOf('],
  [new RegExp(`\\bint\\((?=${PLACEHOLDER_RE})`, 'g'), 'Integer.parseInt('],
  [new RegExp(`\\bfloat\\((?=${PLACEHOLDER_RE})`, 'g'), 'Double.parseDouble('],
  [/\bint\(/g, '(int) ('],
  [/\bfloat\(/g, '(double) ('],
  [/\bbool\(/g, 'Boolean.valueOf('],
  [/\bsuper\(\)\.__init__\(/g, 'super('],
  [/\bsuper\(\)\./g, 'super.'],
  [/\bsuper\(\w+,\s*this\)\./g, 'super.'],
  [/\babs\(/g, 'Math.abs('],
  [new RegExp(`(${PLACEHOLDER_RE})\\s*\\*\\s*(${S})`, 'g'), '$1.repeat($2)'],
  [/\btype\((\w+)\)/g, '$1.getClass()'],
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
  [new RegExp(`(${PLACEHOLDER_RE})\\s*%\\s*\\(`, 'g'), 'String.format($1, '],
  [new RegExp(`(${PLACEHOLDER_RE})\\s*%\\s*(${S})`, 'g'), 'String.format($1, $2)'],
];

function rewriteOperators(text: string): string {
  let t = text;
  // power and floor division on simple operands
  t = t.replace(new RegExp(`(${S})\\s*\\*\\*\\s*(${S})`, 'g'), 'Math.pow($1, $2)');
  t = t.replace(new RegExp(`(${S})\\s*//\\s*(${S})`, 'g'), 'Math.floorDiv($1, $2)');
  // Whatever is left of `//` must not survive - it would start a Java comment.
  t = t.replace(/\/\//g, '/ /* floor div */');
  t = t.replace(/\*\*(\w)/g, '/* ** */ $1');
  // membership tests: `x in (a, b)` -> List.of(a, b).contains(x); `x in y` -> y.contains(x)
  t = t.replace(new RegExp(`(${S})\\s+not\\s+in\\s+\\(([^()]*)\\)`, 'g'), '!List.of($2).contains($1)');
  t = t.replace(new RegExp(`(${S})\\s+in\\s+\\(([^()]*)\\)`, 'g'), 'List.of($2).contains($1)');
  t = t.replace(new RegExp(`(${S})\\s+not\\s+in\\s+(${S})`, 'g'), '!$2.contains($1)');
  t = t.replace(new RegExp(`(${S})\\s+in\\s+(${S})`, 'g'), '$2.contains($1)');
  return t;
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
  t = rewriteComprehensions(t);
  t = rewriteLambda(t);
  t = rewriteTernary(t);
  t = rewriteBrackets(t);
  t = rewriteBraces(t);
  if (ctx.valueContext) t = rewriteOrFallback(t);
  for (const [re, rep] of KEYWORD_RULES) t = t.replace(re, rep);
  if (ctx.className) t = t.replace(/\bcls\b/g, ctx.className);
  const literals = ctx.literals;
  t = rewriteBuiltinCalls(t, {
    literal: (token) => {
      const idx = new RegExp(`^${PLACEHOLDER_RE}$`).test(token) ? Number(token.slice(1, -1)) : -1;
      return idx >= 0 ? literals?.[idx] : undefined;
    },
  });
  for (const [re, rep] of BUILTIN_RULES) t = t.replace(re, rep);
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
  // A one-element tuple `(x,)` is not a parenthesized `x`; any other trailing comma
  // (`f(a, b, )`) is fine in Python and a syntax error in Java.
  t = t.replace(/(?<![\w)\]])\(([^(),]+),\s*\)/g, 'Tuple.of($1)');
  t = t.replace(/,\s*\)/g, ')');
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
