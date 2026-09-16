/**
 * Expression-level rewrite rules (Python expression -> Java-flavored expression).
 *
 * All functions here operate on *masked* text (string literals replaced by
 * placeholders, see strings.ts) so that rewrites never touch string contents.
 */

import { PLACEHOLDER_RE, SIMPLE_OPERAND, maskStrings, setFStringExpressionHook, unmaskStrings } from './strings';
import { splitTopLevel } from './typeHints';

export interface ExprContext {
  /** Enclosing class name, used to render `cls`. */
  className?: string;
}

const S = SIMPLE_OPERAND;

/** Python exception names that have a natural Java counterpart. */
export const EXCEPTIONS: Record<string, string> = {
  ValueError: 'IllegalArgumentException',
  KeyError: 'NoSuchElementException',
  IndexError: 'IndexOutOfBoundsException',
  NotImplementedError: 'UnsupportedOperationException',
  RuntimeError: 'RuntimeException',
  FileNotFoundError: 'FileNotFoundException',
  ZeroDivisionError: 'ArithmeticException',
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
  const build = (expr: string, vars: string, iter: string, cond: string | undefined, terminal: string) => {
    const p = lambdaParams(vars);
    let out = `${iter.trim()}.stream()`;
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
        let out = `${iter.trim()}.stream()`;
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
  [new RegExp(`\\blen\\((${S})\\)`, 'g'), '$1.size()'],
  [/\bstr\(/g, 'String.valueOf('],
  [new RegExp(`\\bint\\((?=${PLACEHOLDER_RE})`, 'g'), 'Integer.parseInt('],
  [new RegExp(`\\bfloat\\((?=${PLACEHOLDER_RE})`, 'g'), 'Double.parseDouble('],
  [/\bint\(/g, '(int) ('],
  [/\bfloat\(/g, '(double) ('],
  [/\bbool\(/g, 'Boolean.valueOf('],
  [new RegExp(`\\bisinstance\\((${S}),\\s*([\\w.]+)\\)`, 'g'), '$1 instanceof $2'],
  [/\bdict\(\)/g, 'new HashMap<>()'],
  [/\blist\(\)/g, 'new ArrayList<>()'],
  [/\bset\(\)/g, 'new HashSet<>()'],
  [/\bdict\(/g, 'new HashMap<>('],
  [/\blist\(/g, 'new ArrayList<>('],
  [/\bset\(/g, 'new HashSet<>('],
  [/\btuple\(/g, 'Tuple.of('],
  [/\bsuper\(\)\.__init__\(/g, 'super('],
  [/\bsuper\(\)\./g, 'super.'],
  [/\bsuper\(\w+,\s*this\)\./g, 'super.'],
  [/\bmin\(/g, 'Math.min('],
  [/\bmax\(/g, 'Math.max('],
  [/\babs\(/g, 'Math.abs('],
  [new RegExp(`\\bround\\((${S})\\)`, 'g'), 'Math.round($1)'],
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
  let t = masked;
  t = rewriteComprehensions(t);
  t = rewriteLambda(t);
  t = rewriteTernary(t);
  t = rewriteBrackets(t);
  t = rewriteBraces(t);
  for (const [re, rep] of KEYWORD_RULES) t = t.replace(re, rep);
  if (ctx.className) t = t.replace(/\bcls\b/g, ctx.className);
  for (const [re, rep] of BUILTIN_RULES) t = t.replace(re, rep);
  t = rewriteOperators(t);
  t = rewriteExceptionNames(t);
  // keyword arguments: f(name=value) -> f(/* name = */ value)
  t = t.replace(/([(,]\s*)([A-Za-z_]\w*)\s*=(?!=)\s*/g, '$1/* $2 = */ ');
  // constructor calls: Foo(...) / pkg.Foo(...) -> new Foo(...)
  t = t.replace(/(^|[^\w.@])((?:[a-z_]\w*\.)*[A-Z]\w*)\(/g, (m, pre: string, name: string, offset: number, whole: string) => {
    if (/(^|\s)new\s$/.test(whole.slice(0, offset + pre.length))) return m;
    if (/^(List|Map|Set|Math|String|Integer|Double|Boolean|Collectors|Tuple|Optional|Objects|Arrays|Collections|Character|CompletableFuture)$/.test(name)) return m;
    return `${pre}new ${name}(`;
  });
  return t;
}

/** Translate a raw (unmasked) Python expression. */
export function translateExpression(expr: string, ctx: ExprContext = {}): string {
  const masked = maskStrings(expr);
  const out = translateMaskedExpression(masked.text, ctx);
  return unmaskStrings(out, masked.literals);
}

// f-string fields ({name}, {total:.2f}) are expressions too.
setFStringExpressionHook((e) => translateExpression(e));
