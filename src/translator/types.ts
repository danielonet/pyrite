/**
 * Shared contracts for translation engines.
 *
 * A translator turns one Python module into a Java-flavored *reading view*.
 * The output is not required to compile; it is meant to be read by Java developers.
 */

export interface TranslateInput {
  /** Full Python source text. */
  source: string;
  /** Path of the file relative to the mirrored root, using forward slashes (e.g. "app/services/order_service.py"). */
  relativePath: string;
}

export type SymbolKind = 'class' | 'method' | 'field';

export interface SymbolInfo {
  /** Identifier exactly as it appears in the generated Java text. */
  name: string;
  kind: SymbolKind;
  /**
   * Enclosing class chain, outermost first (always starts with the module
   * class). Does not include the symbol's own name for a 'class' entry.
   */
  container: string[];
  /** 0-based line in the generated Java text where this symbol is declared. */
  javaLine: number;
  /** 1-based Python source line the declaration was produced from. */
  pythonLine: number;
}

export interface TranslateResult {
  /** Generated Java-flavored text. */
  java: string;
  /**
   * For each generated line (0-based index), the 1-based Python line it was produced from,
   * or 0 when the line is synthetic (closing braces, headers, ...).
   */
  sourceMap: number[];
  /** Every class, method and field declared in the output, for "Go to Definition". */
  symbols: SymbolInfo[];
  /** Human-readable notes about constructs that could not be translated faithfully. */
  warnings: string[];
  /** Which engine produced the result. */
  engine: 'rules';
}

export interface Translator {
  readonly name: 'rules';
  translate(input: TranslateInput): Promise<TranslateResult>;
}

/** Convert snake_case / kebab-case / module names to PascalCase. */
export function toPascalCase(name: string): string {
  return name
    .replace(/\.py$/, '')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

/** Convert snake_case to camelCase (leaves ALL_CAPS constants and dunders untouched). */
export function toCamelCase(name: string): string {
  if (/^[A-Z0-9_]+$/.test(name) || name.startsWith('__')) {
    return name;
  }
  const leading = name.match(/^_+/)?.[0] ?? '';
  const body = name.slice(leading.length);
  const camel = body.replace(/_+([a-zA-Z0-9])/g, (_m, c: string) => c.toUpperCase());
  return leading + camel;
}

/** Derive a Java package name from a relative file path. */
export function packageFromPath(relativePath: string): string {
  const parts = relativePath.split('/').slice(0, -1).filter((p) => p && p !== '.');
  return parts.map((p) => p.replace(/[^A-Za-z0-9_]/g, '_')).join('.');
}
