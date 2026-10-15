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

import type { KnownMembers } from './rules/members';
export type { KnownMembers } from './rules/members';

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
  /**
   * What the rest of the project declares (properties, attribute names, return and field
   * types), so cross-file reads of a property render as accessor calls and calls into
   * other modules get a type. Built by `mirrorProject`; this file's own declarations win.
   */
  knownMembers?: KnownMembers;
  /**
   * Maximum line length of the generated Java, in columns. Longer lines are wrapped:
   * arguments and parameters one per line with an 8-space continuation indent, breaks
   * before `&&`, `||`, `?`, `+` and chained calls. 0 disables wrapping. Defaults to 120.
   */
  lineWidth?: number;
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
  /**
   * Set on a module's class (container []) when it is a Python class too: `order_service.py`'s
   * `class OrderService` becomes the module class instead of being nested in it.
   */
  pythonClass?: boolean;
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
  engine: 'rules' | 'hybrid';
}

export interface Translator {
  readonly name: 'rules' | 'hybrid';
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

/** True when the relative path names a Python package module (`__init__.py`). */
export function isInitModule(relativePath: string): boolean {
  return relativePath.split('/').pop() === '__init__.py';
}

/**
 * Name of the Java class a module becomes, which is also its Java file's name:
 * `order_service.py` -> `OrderService`. A package module `inventory/__init__.py` is named after
 * its folder plus `PACKAGE_MODULE_FILE_SUFFIX`, `InventoryInit` (a root-level `__init__.py`
 * becomes `Init`).
 */
export function moduleClassName(relativePath: string): string {
  const parts = relativePath.split('/');
  const base = parts.pop() ?? 'Module';
  if (base === '__init__.py') {
    const folder = parts.pop();
    return folder ? toPascalCase(folder) + PACKAGE_MODULE_FILE_SUFFIX : 'Init';
  }
  return toPascalCase(base);
}

/**
 * Suffix of a package module's class (and so its file): `inventory/__init__.py` becomes
 * `class InventoryInit` in `inventory/InventoryInit.java`. The suffix hints that it came from
 * `__init__.py`, and keeps it apart from a sibling `inventory/inventory.py` -> `Inventory.java`,
 * which would otherwise be the same class (and, on Windows and macOS, the same file).
 */
export const PACKAGE_MODULE_FILE_SUFFIX = 'Init';

/**
 * Base name (no extension) of the Java view file a module is written to: the name of its public
 * class, as `javac` requires (`order_service.py` -> `OrderService`).
 */
export function javaFileBaseName(relativePath: string): string {
  return moduleClassName(relativePath);
}

/** Derive a Java package name from a relative file path. */
export function packageFromPath(relativePath: string): string {
  const parts = relativePath.split('/').slice(0, -1).filter((p) => p && p !== '.');
  return parts.map((p) => p.replace(/[^A-Za-z0-9_]/g, '_')).join('.');
}

/**
 * A module's dotted name the way the rules engine writes it in imports: `app/models.py` ->
 * `app.models`, a package module `app/__init__.py` -> `app`.
 */
export function pythonModuleKey(relativePath: string): string {
  const pkg = packageFromPath(relativePath);
  if (isInitModule(relativePath)) return pkg;
  const base = (relativePath.split('/').pop() ?? '').replace(/\.py$/, '');
  return pkg ? `${pkg}.${base}` : base;
}

/** Fully qualified name of the Java class a module becomes: `app/models.py` -> `app.Models`. */
export function javaModuleClass(relativePath: string): string {
  const pkg = packageFromPath(relativePath);
  return pkg ? `${pkg}.${moduleClassName(relativePath)}` : moduleClassName(relativePath);
}
