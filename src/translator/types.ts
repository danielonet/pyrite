/**
 * Shared contracts for translation engines.
 *
 * A translator turns one Python module into a Java-flavored *reading view*.
 * The output is not required to compile; it is meant to be read by Java developers.
 */

/**
 * How much Javadoc the rules engine should generate for classes and methods:
 *  - "always": every class/method gets a Javadoc comment; when there is no docstring
 *    the description is extrapolated from the name and `@param`/`@return` are always
 *    extrapolated from the signature.
 *  - "docstringOnly": only classes/methods that have a Python docstring get a Javadoc
 *    comment (still with `@param`/`@return` added); everything else gets none.
 *  - "none": no Javadoc is generated; a docstring is kept as a plain `/* ... *\/` comment
 *    in place instead, like any other construct without a clean Java equivalent.
 */
export type JavadocMode = 'always' | 'docstringOnly' | 'none';

export interface TranslateInput {
  /** Full Python source text. */
  source: string;
  /** Path of the file relative to the mirrored root, using forward slashes (e.g. "app/services/order_service.py"). */
  relativePath: string;
  /** Javadoc generation mode. Defaults to "docstringOnly". */
  javadocMode?: JavadocMode;
  /**
   * Whether test code (by common pytest/unittest path conventions - see `isTestFile`)
   * follows the same `javadocMode` as production code. Defaults to false, meaning test
   * files never get Javadoc regardless of `javadocMode`.
   */
  documentTestCode?: boolean;
  /**
   * Render idiomatic Lombok-style Java instead of spelling out boilerplate: a class whose
   * `__init__` only assigns every parameter to a same-named field gets `@AllArgsConstructor`
   * instead of a written-out constructor; a trivial `__str__`/`__repr__` becomes `@ToString`;
   * a trivial `__eq__`/`__hash__` becomes `@EqualsAndHashCode`; a `@property`/`@x.setter` pair
   * that's a plain pass-through to a field becomes `@Getter`/`@Setter` on that field; and a
   * dataclass-like class (`@dataclass`, `NamedTuple`, `BaseModel`, ...) gets `@Data`. Defaults
   * to false. Methods that don't match these simple shapes are left as ordinary Java.
   */
  lombokStyle?: boolean;
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
