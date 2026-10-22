/**
 * pytest -> JUnit 5 + AssertJ, for modules that are test code (see `isTestFile`).
 *
 *   assert a == b                 ->  assertThat(a).isEqualTo(b);
 *   assert x is None              ->  assertThat(x).isNull();
 *   assert ok                     ->  assertThat(ok).isTrue();
 *   assert len(xs) == 3           ->  assertThat(xs).hasSize(3);
 *   with pytest.raises(E):        ->  assertThatThrownBy(() -> { ... }).isInstanceOf(E.class);
 *   def test_x(): / fixtures      ->  @Test void test_x() { var service = service(); ... }
 *
 * The Java `assert` keyword is never used: it is off unless the JVM runs with `-ea`, so a
 * failing check would pass silently.
 *
 * Works on masked text (string literals are placeholders); `ex` renders a masked Python
 * expression as Java.
 */

import { splitTopLevel } from './typeHints';

type Render = (maskedExpression: string) => string;

/** Comparison operators, longest first so `is not` wins over `is`. */
const COMPARISONS = [' is not ', ' not in ', ' is ', ' in ', '==', '!=', '>=', '<=', '>', '<'];

/** The AssertJ method for a comparison, given the (rendered) right-hand side. */
const ORDERING: Record<string, string> = { '>': 'isGreaterThan', '>=': 'isGreaterThanOrEqualTo', '<': 'isLessThan', '<=': 'isLessThanOrEqualTo' };

interface Comparison {
  op: string;
  left: string;
  right: string;
}

/** The one top-level comparison of `code`, `null` for none, `undefined` for a compound expression. */
function topLevelComparison(code: string): Comparison | null | undefined {
  let depth = 0;
  const found: { at: number; op: string }[] = [];
  for (let i = 0; i < code.length; i += 1) {
    const c = code[i];
    if ('([{'.includes(c)) depth += 1;
    else if (')]}'.includes(c)) depth -= 1;
    else if (depth === 0) {
      if (/^\s(?:and|or|if|else|for)\s/.test(code.slice(i))) return undefined;
      const op = COMPARISONS.find((o) => code.startsWith(o, i));
      if (op) {
        // `->` or `=>` style arrows and `<<`/`>>` shifts are not comparisons.
        if ((op === '>' || op === '<') && (code[i - 1] === '-' || code[i - 1] === '<' || code[i - 1] === '>' || code[i + 1] === code[i])) continue;
        found.push({ at: i, op });
        i += op.length - 1;
      }
    }
  }
  if (/\blambda\b/.test(code)) return undefined;
  if (found.length === 0) return null;
  if (found.length > 1) return undefined;
  const { at, op } = found[0];
  return { op, left: code.slice(0, at).trim(), right: code.slice(at + op.length).trim() };
}

/** `f(args)` -> `args` for a call of exactly `name`, balanced. */
function callArgument(code: string, name: string): string | undefined {
  const m = new RegExp(`^${name}\\(`).exec(code);
  if (!m || !code.endsWith(')')) return undefined;
  const inner = code.slice(m[0].length, -1);
  let depth = 0;
  for (const c of inner) {
    if ('([{'.includes(c)) depth += 1;
    else if (')]}'.includes(c)) depth -= 1;
    if (depth < 0) return undefined;
  }
  return depth === 0 ? inner : undefined;
}

/** A Java boolean expression is asserted as is; anything else is a Python truth test. */
function truth(java: string): string {
  const boolean = /^!|&&|\|\||==|!=|[<>]=?|\.(?:is|has|can|should|contains|startsWith|endsWith|equals|matches)\w*\(/.test(java) || /^(?:true|false)$/.test(java);
  return boolean ? java : `Py.truthy(${java})`;
}

/** `assert <expr>[, message]` as an AssertJ statement (with the trailing `;`). */
export function assertStatement(maskedArgs: string, ex: Render): string {
  const parts = splitTopLevel(maskedArgs);
  const code = parts[0].trim();
  const described = parts[1] ? `.as("%s", ${ex(parts[1])})` : '';
  const that = (actual: string) => `assertThat(${actual})${described}`;

  const cmp = topLevelComparison(code);
  if (cmp) {
    const { op, left, right } = cmp;
    const none = right === 'None';
    const bool = right === 'True' || right === 'False';
    const o = op.trim();
    const isExact = o === 'is' || o === 'is not';
    const negative = o === '!=' || o === 'is not';
    if (o === '==' || o === '!=' || o === 'is' || o === 'is not') {
      if (none) return `${that(ex(left))}.${negative ? 'isNotNull' : 'isNull'}();`;
      if (bool) return `${that(ex(left))}.${(right === 'True') !== negative ? 'isTrue' : 'isFalse'}();`;
      const size = callArgument(left, 'len');
      if (size !== undefined && (o === '==' || o === '!=')) {
        if (right === '0') return `${that(ex(size))}.${negative ? 'isNotEmpty' : 'isEmpty'}();`;
        if (!negative) return `${that(ex(size))}.hasSize(${ex(right)});`;
      }
      const approx = callArgument(right, 'pytest\\.approx');
      if (approx !== undefined && o === '==') return `${that(ex(left))}.isCloseTo(${ex(approx)}, within(1e-6));`;
      if (isExact) return `${that(ex(left))}.${negative ? 'isNotSameAs' : 'isSameAs'}(${ex(right)});`;
      return `${that(ex(left))}.${negative ? 'isNotEqualTo' : 'isEqualTo'}(${ex(right)});`;
    }
    if (o === 'in' || o === 'not in') return `${that(ex(right))}.${o === 'in' ? 'contains' : 'doesNotContain'}(${ex(left)});`;
    return `${that(ex(left))}.${ORDERING[o]}(${ex(right)});`;
  }
  const negated = /^not\s+(.+)$/.exec(code);
  if (negated && topLevelComparison(negated[1]) === null) return `${that(truth(ex(negated[1])))}.isFalse();`;
  return `${that(truth(ex(code)))}.isTrue();`;
}

/** What a `with pytest.raises(...)` item expects. */
export interface RaisesSpec {
  /** Masked Python expressions of the expected exception classes. */
  exceptions: string[];
  /** Masked `match=` pattern, when given. */
  match?: string;
  /** The `as name` binding, when given. */
  bound?: string;
}

export function parseRaises(item: string): RaisesSpec | undefined {
  const m = /^pytest\.raises\((.*)\)(?:\s+as\s+(\w+))?$/.exec(item.trim());
  if (!m) return undefined;
  const args = splitTopLevel(m[1]).map((a) => a.trim()).filter(Boolean);
  const positional = args.filter((a) => !/^\w+\s*=(?!=)/.test(a));
  if (positional.length === 0) return undefined;
  const first = positional[0];
  const exceptions = first.startsWith('(') && first.endsWith(')') ? splitTopLevel(first.slice(1, -1)).map((a) => a.trim()).filter(Boolean) : [first];
  const match = args.map((a) => /^match\s*=(?!=)\s*(.+)$/.exec(a)).find(Boolean)?.[1];
  return { exceptions, match, bound: m[2] };
}

/** The opening of a `pytest.raises` block and the text that closes it, as Java. */
export function raisesBlock(spec: RaisesSpec, ex: Render): { open: string; close: string } {
  const classes = spec.exceptions.map((e) => `${ex(e)}.class`);
  const checks =
    (classes.length === 1 ? `.isInstanceOf(${classes[0]})` : `.isInstanceOfAny(${classes.join(', ')})`) +
    (spec.match ? `.hasMessageFindingMatch(${ex(spec.match)})` : '');
  if (spec.bound) {
    return { open: `var ${spec.bound} = catchThrowable(() -> {`, close: `}); assertThat(${spec.bound})${checks};` };
  }
  return { open: 'assertThatThrownBy(() -> {', close: `})${checks};` };
}

/** pytest fixtures: names defined in this module with `@pytest.fixture` / `@fixture`. */
export const FIXTURE_DECORATOR = /^@(?:pytest\.)?fixture\b/;

/** Classes of the generated test code and the library each is imported from (see `planImports`). */
export const JUNIT_CLASSES: Record<string, string> = {
  Test: 'org.junit.jupiter.api.Test',
  TempDir: 'org.junit.jupiter.api.io.TempDir',
};

/** AssertJ's static entry points the generated test code calls. */
export const ASSERTJ_STATICS = ['assertThat', 'assertThatThrownBy', 'catchThrowable', 'within'];
export const ASSERTJ_CLASS = 'org.assertj.core.api.Assertions';
