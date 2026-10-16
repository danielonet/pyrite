/**
 * Python integers are unbounded; Java's `int` holds 32 bits and `long` 64. Integer literals
 * and literal powers are sized here:
 *
 *   2**10                  -> 1024
 *   3000000000             -> 3000000000L                 (long)
 *   0xFFFFFFFFFFFFFFFF     -> 0xFFFFFFFFFFFFFFFFL          (long, all 64 bits set: -1)
 *   18446744073709551615   -> new BigInteger("18446744073709551615")
 *   2**64                  -> new BigInteger("18446744073709551616")
 */

const INT_MAX = 2n ** 31n - 1n;
const LONG_MAX = 2n ** 63n - 1n;
const ULONG_MAX = 2n ** 64n - 1n;
/** Results with more digits than this stay as `Math.pow` rather than a giant literal. */
const MAX_FOLDED_DIGITS = 400;

/** A Python integer literal: decimal, hex, octal or binary, with optional `_` separators. */
const INT_LITERAL_SRC = '(?:0[xX][0-9a-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|\\d[\\d_]*)';
/** Matches an integer literal token, not a part of a name, float, or string placeholder. */
const INT_TOKEN = new RegExp(`(?<![\\w.\\u0001])${INT_LITERAL_SRC}(?![\\w.\\u0001])`, 'g');
/** `a ** b` with two integer literals. */
const INT_POWER = new RegExp(`(?<![\\w.\\u0001])(${INT_LITERAL_SRC})\\s*\\*\\*\\s*(${INT_LITERAL_SRC})(?![\\w.\\u0001(])`, 'g');

export type IntKind = 'int' | 'long' | 'BigInteger';

/** Value of a Python integer literal, or undefined when `text` is not one. */
export function intLiteralValue(text: string): bigint | undefined {
  const t = text.trim();
  if (!new RegExp(`^${INT_LITERAL_SRC}$`).test(t)) return undefined;
  const digits = t.replace(/_/g, '');
  if (/^0[oO]/.test(digits)) return BigInt(`0o${digits.slice(2)}`);
  // Python forbids leading zeros on decimals other than 0 itself; BigInt would read them fine.
  return BigInt(digits);
}

/** The smallest Java integer type that holds `value` (hex/binary/octal may fill all 64 bits). */
export function intKindOf(value: bigint, bitPattern = false): IntKind {
  if (value <= INT_MAX) return 'int';
  if (value <= LONG_MAX || (bitPattern && value <= ULONG_MAX)) return 'long';
  return 'BigInteger';
}

/** Java spelling of a Python integer literal, sized to fit. */
export function javaIntLiteral(text: string): string {
  const value = intLiteralValue(text);
  if (value === undefined) return text;
  const t = text.trim();
  const radix = /^0[xXbBoO]/.test(t);
  const kind = intKindOf(value, radix);
  // Java has no `0o`: write octal in decimal, which is how Java readers read numbers anyway.
  // Java also rejects `_` right after a radix prefix (`0x_FF`), which Python allows.
  const javaText = /^0[oO]/.test(t) ? value.toString() : t.replace(/^(0[xXbB])_+/, '$1');
  if (kind === 'int') return javaText;
  if (kind === 'long') return `${javaText}L`;
  return `new BigInteger("${value.toString()}")`;
}

/** Java type of a masked value that is an integer literal or a literal power, else undefined. */
export function intTypeOf(masked: string): IntKind | undefined {
  const t = masked.trim().replace(/^-\s*/, '');
  const value = intLiteralValue(t);
  if (value !== undefined) return intKindOf(value, /^0[xXbBoO]/.test(t));
  const power = new RegExp(`^(${INT_LITERAL_SRC})\\s*\\*\\*\\s*(${INT_LITERAL_SRC})$`).exec(t);
  if (power) {
    const folded = foldPower(power[1], power[2]);
    if (folded !== undefined) return intKindOf(folded);
  }
  return undefined;
}

function foldPower(baseText: string, expText: string): bigint | undefined {
  const base = intLiteralValue(baseText);
  const exp = intLiteralValue(expText);
  if (base === undefined || exp === undefined) return undefined;
  // Bound the work: the number of digits of base**exp is about exp * log10(base).
  if (base > 1n && Number(exp) * Math.log10(Number(base)) > MAX_FOLDED_DIGITS) return undefined;
  return base ** exp;
}

/**
 * Fold literal powers (`2**10` -> `1024`) and size every integer literal in a masked Python
 * expression. Runs before `**` is rewritten to `Math.pow`.
 */
export function rewriteIntLiterals(text: string): string {
  if (!/\d/.test(text)) return text;
  let t = text.replace(INT_POWER, (m: string, base: string, exp: string) => {
    const folded = foldPower(base, exp);
    return folded === undefined ? m : folded.toString();
  });
  t = t.replace(INT_TOKEN, (m: string) => javaIntLiteral(m));
  return t;
}
