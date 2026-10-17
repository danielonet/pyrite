/**
 * Rule-based Python -> Java-flavored translator.
 *
 * Deterministic, offline, dependency-free. The output is a *reading view*: it
 * looks like Java, keeps the structure and names of the Python source, but is
 * not guaranteed (or intended) to compile.
 *
 * Structure of the generated file:
 *
 *   package proj.a.b;                  // the project's base package, then the folder path
 *   import ...;                        // Python imports, rewritten
 *   public final class ModuleName {    // one class per Python module
 *       public static class Foo { }    // Python classes become nested classes
 *       public static void bar() { }   // module-level functions become static methods
 *       public static void main(String[] args) { }   // if __name__ == "__main__"
 *   }
 */

import { LogicalLine, splitLogicalLines } from './logicalLines';
import { isSingleLiteral, maskStrings, unmaskStrings } from './strings';
import { boxed, splitTopLevel, translateType } from './typeHints';
import { ExprContext, LocalFunction, indexAtDepth0, mapExceptionName, sliceBound, setFStringExpressionContext, translateExpression, translateMaskedExpression } from './expressions';
import { JavadocMode, SymbolInfo, SymbolKind, TranslateInput, TranslateResult, Translator, isInitModule, moduleClassName, packageFromPath, pythonPackageParts, toPascalCase } from '../types';
import { FieldInfo, KnownMembers, MemberScan, classNameOf, collectSelfFields, elementTypeOf, inferTypeFromMaskedValue, mapTypesOf, scanMembers, toKnownMembers, typeFromDefault } from './members';
import { describeClassSummary, describeMethodSummary, isTestFile, paramTag, renderJavadoc, returnTag } from './javadoc';
import { DEFAULT_LINE_WIDTH, formatJavaLine } from './layout';
import { applyImports, codeOnly, planImports, renderImports } from '../imports/javaImports';
import { NullabilityScan, boxIfNullable, nullableType, scanNullability } from './nullability';
import { UNDERSCORE_NAME, renameJavaReservedIdentifiers } from './javaNames';
import { HoistedLocal, planHoistedLocals } from './scoping';
import { typeFromUsage } from './usageTypes';
import { RUNTIME_MODULES } from '../imports/pythonModules';

type BlockKind = 'class' | 'def' | 'if' | 'for' | 'while' | 'try' | 'with' | 'match' | 'case' | 'main' | 'static' | 'other';

/** Java methods that return a boolean, so a condition needs no `Py.truthy` around them. */
const BOOLEAN_METHODS = new Set([
  'contains', 'containsKey', 'containsValue', 'containsAll', 'startsWith', 'endsWith', 'isEmpty', 'isBlank', 'equals',
  'equalsIgnoreCase', 'matches', 'find', 'hasNext', 'exists', 'anyMatch', 'allMatch', 'noneMatch', 'isAssignableFrom',
  'isInstance', 'isPresent', 'test', 'add', 'remove', 'removeIf', 'offer', 'tryLock', 'isAlive', 'isDirectory', 'isFile',
  'isDigit', 'isLetter', 'isLetterOrDigit', 'isWhitespace', 'isUpperCase', 'isLowerCase', 'isNaN', 'isInfinite',
]);

/**
 * `a && !b || c` split at the top-level `&&` / `||`: operands at even indexes, operators at odd
 * ones. Undefined when the condition has a top-level `? :` (left as it is).
 */
function splitBoolean(java: string): string[] | undefined {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < java.length; i += 1) {
    const ch = java[i];
    if ('([{'.includes(ch)) depth += 1;
    else if (')]}'.includes(ch)) depth -= 1;
    else if (depth === 0 && ch === '?') return undefined;
    else if (depth === 0 && (java.startsWith('&&', i) || java.startsWith('||', i))) {
      parts.push(java.slice(from, i), java.slice(i, i + 2));
      from = i + 2;
      i += 1;
    }
  }
  parts.push(java.slice(from));
  return parts;
}

/**
 * Names the file binds to modules that have a Java counterpart (see `pythonModules.ts`):
 * `import os` -> os, `import re as regex` -> regex, `from os import path` -> path (os.path),
 * `import math` -> math.
 */
function importedRuntimeModules(lines: LogicalLine[]): Map<string, string> {
  const known = (mod: string) => mod === 'math' || Object.prototype.hasOwnProperty.call(RUNTIME_MODULES, mod);
  const modules = new Map<string, string>();
  for (const l of lines) {
    if (l.kind !== 'code') continue;
    const text = l.text.trim();
    let m = /^import\s+(.+)$/.exec(text);
    if (m) {
      for (const part of m[1].split(',')) {
        const [mod, alias] = part.trim().split(/\s+as\s+/);
        // `import os.path` binds `os`.
        if (alias && known(mod)) modules.set(alias, mod);
        else if (!alias && known(mod.split('.')[0])) modules.set(mod.split('.')[0], mod.split('.')[0]);
      }
      continue;
    }
    m = /^from\s+([\w.]+)\s+import\s+\(?([^)]+)\)?$/.exec(text);
    if (!m) continue;
    for (const part of m[2].split(',')) {
      const [name, alias] = part.trim().split(/\s+as\s+/);
      if (name && known(`${m[1]}.${name}`)) modules.set(alias ?? name, `${m[1]}.${name}`);
    }
  }
  return modules;
}

/** A function as a lambda: its parameters, functional interface and the method that calls it. */
interface FunctionShape extends LocalFunction {
  parsed: Array<{ star: string; name: string; def?: string }>;
  iface: string;
}

/**
 * The functional interface a function becomes as a lambda, by its shape: `Runnable`, `Supplier`,
 * `Consumer`, `Function`, `BiConsumer`, `BiFunction`; three or more parameters, or `*args`, take
 * one `Object[]`. `types` gives the parameters' Java types where known.
 */
function functionShape(rawParams: string[], ret: string, types: Map<string, string>): FunctionShape {
  const parsed = rawParams
    .filter((p) => p !== '*' && p !== '/')
    .map((p) => /^(\*{0,2})(\w+)\s*(?::\s*([^=]+?))?\s*(?:=\s*(.+))?$/.exec(p))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ star: m[1], name: m[2], def: m[4] }));
  const plain = (t: string | undefined) => boxed((t ?? 'Object').replace(/\s*\/\*.*?\*\//g, '').trim() || 'Object');
  const isVoid = ret === 'void';
  const r = plain(ret);
  const arrayArgs = parsed.length >= 3 || parsed.some((p) => p.star);
  let iface: string;
  let method: string;
  if (arrayArgs) [iface, method] = isVoid ? ['Consumer<Object[]>', 'accept'] : [`Function<Object[], ${r}>`, 'apply'];
  else if (parsed.length === 0) [iface, method] = isVoid ? ['Runnable', 'run'] : [`Supplier<${r}>`, 'get'];
  else {
    const ps = parsed.map((p) => plain(types.get(p.name)));
    if (parsed.length === 1) [iface, method] = isVoid ? [`Consumer<${ps[0]}>`, 'accept'] : [`Function<${ps[0]}, ${r}>`, 'apply'];
    else [iface, method] = isVoid ? [`BiConsumer<${ps[0]}, ${ps[1]}>`, 'accept'] : [`BiFunction<${ps[0]}, ${ps[1]}, ${r}>`, 'apply'];
  }
  return { parsed, iface, method, arrayArgs };
}

/** The value a hoisted local starts with, by type (`null` for the rest). */
const DEFAULT_VALUES: Record<string, string> = { int: '0', long: '0L', double: '0.0', float: '0.0f', boolean: 'false', char: "'\\0'", short: '0', byte: '0' };

interface Block {
  indent: number;
  kind: BlockKind;
  className?: string;
  isEnum?: boolean;
  /** dataclass / NamedTuple / pydantic model: class-level annotations are instance fields. */
  isRecord?: boolean;
  isInterface?: boolean;
  /** Variables already declared in this function scope. */
  declared?: Set<string>;
  /** Java types of parameters and locals declared in this function scope. */
  types?: Map<string, string>;
  /** Names in this function scope that the code flow may set to None (declared boxed). */
  nullability?: NullabilityScan;
  /** Python field name -> Java field name, for backing fields renamed after their property (Lombok style). */
  fieldRenames?: Map<string, string>;
  /** Static field names a class declares so far (class blocks). */
  fields?: Set<string>;
  /** Index in the output of a `static {` block's opening line (static blocks). */
  startOut?: number;
  /** Loop with an `else:` clause: the flag `break` sets, so the else part runs only without one. */
  loopFlag?: string;
  /** `try` (and its `except` blocks) with an `else:` clause: the flag every `except` sets. */
  raisedFlag?: string;
  /** Nested functions declared in this function scope (as lambdas), by name. */
  localFunctions?: Map<string, LocalFunction>;
  /** What closes the block, when not `}` (a lambda body: `};`). */
  closer?: string;
  /** Outer `try {` that only exists to hold a `finally` around try / except / else. */
  finallyWrapper?: boolean;
  /** Locals this block declares (unpacked loop targets): out of scope in Java once it closes. */
  blockLocals?: string[];
  /** Name bound by `except ... as name` for this catch block. */
  catchVar?: string;
  /** Function scope: locals declared ahead of a nested first assignment, by the line they precede. */
  hoists?: Map<number, HoistedLocal[]>;
  /** Generator function: the list its `yield`s add to (collected eagerly), returned at the end. */
  yielded?: string;
  /** The generator is declared to return an `Iterator`: it returns `yielded.iterator()`. */
  yieldIterator?: boolean;
  /** pyrite.lombokStyle plan for this class, if any boilerplate here can be collapsed. */
  lombokPlan?: LombokPlan;
}

/** A `@property`/`@x.setter` pair that is a plain pass-through to a field, collapsible to `@Getter`/`@Setter`. */
interface LombokPropertyPlan {
  /** The `self.<field>` the property reads/writes. */
  field: string;
  getter: boolean;
  setter: boolean;
}

/**
 * What can be rewritten as Lombok annotations for one class, decided by scanning its whole
 * body up front (see `buildLombokPlan`) - before any of its methods are emitted.
 */
interface LombokPlan {
  suppressCtor: boolean;
  suppressToString: boolean;
  suppressEquals: boolean;
  suppressHash: boolean;
  /** Class-level annotations to emit (e.g. `@AllArgsConstructor`, `@ToString`, `@Data`). */
  annotations: string[];
  /** Python property name -> plan, keyed the same for the getter and its `.setter`. */
  properties: Map<string, LombokPropertyPlan>;
  /** Field name -> which of `@Getter`/`@Setter` to place on its declaration. */
  fieldAnnotations: Map<string, { getter: boolean; setter: boolean }>;
}

interface OutLine {
  text: string;
  py: number;
}

/** A recorded declaration, before `javaLineRaw` is rebased onto the final output (see assemble()). */
interface RawSymbol {
  name: string;
  kind: SymbolKind;
  container: string[];
  javaLineRaw: number;
  py: number;
}

const ENUM_BASES = new Set(['Enum', 'IntEnum', 'StrEnum', 'Flag', 'IntFlag']);
const RECORD_BASES = new Set(['NamedTuple', 'TypedDict', 'BaseModel', 'BaseSettings']);
const RECORD_DECORATORS = /^@(dataclass|dataclasses\.dataclass|attr\.s|attrs\.define|define|frozen|pydantic\.dataclasses\.dataclass)\b/;

const DUNDER_METHODS: Record<string, { name: string; ret: string; params?: string; doc: string }> = {
  __str__: { name: 'toString', ret: 'String', doc: 'Returns a string representation of this object.' },
  __repr__: { name: 'toString /* __repr__ */', ret: 'String', doc: 'Returns a developer-facing string representation of this object.' },
  __eq__: { name: 'equals', ret: 'boolean', doc: 'Indicates whether some other object is equal to this one.' },
  __ne__: { name: 'notEquals /* __ne__ */', ret: 'boolean', doc: 'Indicates whether some other object is not equal to this one.' },
  __hash__: { name: 'hashCode', ret: 'int', doc: 'Returns a hash code value for this object.' },
  __len__: { name: 'size', ret: 'int', doc: 'Returns the number of elements.' },
  __bool__: { name: 'isTruthy /* __bool__ */', ret: 'boolean', doc: 'Returns whether this object is truthy.' },
  __iter__: { name: 'iterator', ret: 'Iterator<Object>', doc: 'Returns an iterator over the elements.' },
  __next__: { name: 'next', ret: 'Object', doc: 'Returns the next element.' },
  __contains__: { name: 'contains', ret: 'boolean', doc: 'Returns whether this object contains the given value.' },
  __getitem__: { name: 'get /* __getitem__ */', ret: 'Object', doc: 'Returns the value at the given key or index.' },
  __setitem__: { name: 'put /* __setitem__ */', ret: 'void', doc: 'Sets the value at the given key or index.' },
  __delitem__: { name: 'remove /* __delitem__ */', ret: 'void', doc: 'Removes the value at the given key or index.' },
  __call__: { name: 'call /* __call__ */', ret: 'Object', doc: 'Invokes this object as if it were a function.' },
  __enter__: { name: 'enter /* __enter__: try-with-resources open */', ret: 'Object', doc: 'Enters the context, for use in a try-with-resources block.' },
  __exit__: { name: 'close /* __exit__: try-with-resources close */', ret: 'void', doc: 'Exits the context, for use in a try-with-resources block.' },
  __lt__: { name: 'compareTo /* __lt__ */', ret: 'boolean', doc: 'Returns whether this object orders before another.' },
  __le__: { name: 'lessOrEqual /* __le__ */', ret: 'boolean', doc: 'Returns whether this object orders before or equal to another.' },
  __gt__: { name: 'greaterThan /* __gt__ */', ret: 'boolean', doc: 'Returns whether this object orders after another.' },
  __ge__: { name: 'greaterOrEqual /* __ge__ */', ret: 'boolean', doc: 'Returns whether this object orders after or equal to another.' },
  __add__: { name: 'plus /* __add__ */', ret: 'Object', doc: 'Returns the sum of this object and another.' },
  __sub__: { name: 'minus /* __sub__ */', ret: 'Object', doc: 'Returns the difference of this object and another.' },
  __mul__: { name: 'times /* __mul__ */', ret: 'Object', doc: 'Returns the product of this object and another.' },
  __post_init__: { name: '__post_init__ /* runs after the generated constructor */', ret: 'void', doc: 'Runs after the generated constructor.' },
};

/**
 * PEP 695 type parameters `[T, U: Bound, *Ts, **P]` -> Java type parameters
 * (`T`, `U extends Bound`; variadic/param-spec parameters keep their bare name).
 */
function typeParamsOf(bracketed: string | undefined): string[] {
  if (!bracketed) return [];
  return splitTopLevel(bracketed.slice(1, -1))
    .map((p) => /^\**(\w+)\s*(?::\s*(.+))?$/.exec(p.trim()))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => (m[2] ? `${m[1]} extends ${translateType(m[2])}` : m[1]));
}

/** Remove one pair of enclosing parentheses when they wrap the whole text. */
/** Index just past the bracket group that opens `text` (`(...)`, `[...]`), or -1. */
function groupEndIndex(text: string): number {
  const open = text[0];
  const close = open === '(' ? ')' : open === '[' ? ']' : '';
  if (!close) return -1;
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '(' || text[i] === '[' || text[i] === '{') depth += 1;
    else if (text[i] === ')' || text[i] === ']' || text[i] === '}') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * The targets of an unpacking assignment or loop (`a, b`, `(a, b)`, `[a, *rest]`, `x.y, d[k]`),
 * or undefined when `target` is a single target or has nested tuples.
 */
/**
 * `recv[key]` split at the bracket that matches the final `]`, so a key that is itself a
 * subscript stays whole: `dispatch[PROTO[0]]` -> [`dispatch`, `PROTO[0]`]. Undefined when the
 * target does not end in a subscript.
 */
function subscriptTarget(target: string): [string, string] | undefined {
  const t = target.trim();
  if (!t.endsWith(']')) return undefined;
  let depth = 0;
  for (let i = t.length - 1; i > 0; i -= 1) {
    if (t[i] === ')' || t[i] === ']' || t[i] === '}') depth += 1;
    else if (t[i] === '(' || t[i] === '[' || t[i] === '{') {
      depth -= 1;
      if (depth === 0) return t[i] === '[' && t.slice(0, i).trim() !== '' ? [t.slice(0, i), t.slice(i + 1, -1)] : undefined;
    }
  }
  return undefined;
}

function unpackTargets(target: string): string[] | undefined {
  let t = target.trim();
  if (/^[(\[]/.test(t) && groupEndIndex(t) === t.length) t = t.slice(1, -1);
  const parts = splitTopLevel(t);
  const trailingComma = /,\s*$/.test(t);
  if (parts.length < 2 && !trailingComma) return undefined;
  if (!parts.every((p) => /^\*?[\w.]+$/.test(p) || /^[\w.]+\[.+\]$/.test(p) || nestedTargets(p))) return undefined;
  if (parts.filter((p) => p.startsWith('*')).length > 1) return undefined;
  return parts;
}

/** The targets inside a nested group such as `(f, t)` in `name, (f, t) = x`, else undefined. */
function nestedTargets(target: string): string[] | undefined {
  const t = target.trim();
  return /^[(\[]/.test(t) && groupEndIndex(t) === t.length ? unpackTargets(t) : undefined;
}

/** Every name bound by unpacking `targets`, nested groups included, without the `*`. */
function boundNames(targets: string[]): string[] {
  return targets.flatMap((t) => nestedTargets(t) ? boundNames(nestedTargets(t)!) : [t.replace(/^\*/, '')]);
}

function stripOuterParens(text: string): string {
  const t = text.trim();
  if (!t.startsWith('(') || !t.endsWith(')')) return t;
  let depth = 0;
  for (let i = 0; i < t.length; i += 1) {
    if (t[i] === '(') depth += 1;
    else if (t[i] === ')') {
      depth -= 1;
      if (depth === 0 && i < t.length - 1) return t; // closes before the end: not wrapping
    }
  }
  return t.slice(1, -1);
}

class RuleTranslation {
  private readonly lines: LogicalLine[];
  private readonly out: OutLine[] = [];
  private readonly imports: OutLine[] = [];
  private readonly warnings: string[] = [];
  private readonly stack: Block[] = [];
  private pendingDecorators: { text: string; py: number }[] = [];
  /** Blank lines and comments seen since the last code line; flushed after blocks are closed. */
  private pendingTrivia: { kind: 'blank' | 'comment'; text: string; py: number }[] = [];
  private moduleDoc: OutLine[] = [];
  /** The Python package's folder names, for resolving relative imports (no base package). */
  private readonly packageParts: string[];
  private skipIndex = -1;
  private readonly moduleClass: string;
  private readonly usedNames = new Set<string>();
  /** Classes, methods and fields declared so far, for "Go to Definition"; rebased in assemble(). */
  private readonly symbols: RawSymbol[] = [];
  private readonly javadocMode: JavadocMode;
  /** What this module declares (classes, properties, fields, return hints). */
  private readonly scan: MemberScan;
  /** The same, name-keyed, plus what the rest of the project declares. */
  private readonly localKnown: KnownMembers;
  private readonly known: KnownMembers | undefined;
  private readonly knownAttributes: Set<string>;

  constructor(private readonly input: TranslateInput) {
    this.lines = splitLogicalLines(input.source);
    renameJavaReservedIdentifiers(this.lines);
    this.pythonModules = importedRuntimeModules(this.lines);
    for (const l of this.lines) {
      const m = l.kind === 'code' ? /^import\s+(.+)$/.exec(l.text.trim()) : null;
      for (const part of m ? m[1].split(',') : []) {
        const [mod, alias] = part.trim().split(/\s+as\s+/);
        this.importedModules.add(alias ?? mod.split('.')[0]);
      }
    }
    this.moduleFunctions = this.moduleConditionalDefs();
    this.scan = scanMembers(this.lines);
    this.localKnown = toKnownMembers(this.scan);
    this.known = input.knownMembers;
    this.knownAttributes = new Set([...this.localKnown.attributes, ...(this.known?.attributes ?? [])]);
    this.packageParts = pythonPackageParts(input.relativePath);
    this.moduleClass = moduleClassName(input.relativePath);
    const requestedMode = input.javadocMode ?? 'docstringOnly';
    // Test code never gets Javadoc unless the user opted it into the same rules as production code.
    this.javadocMode = isTestFile(input.relativePath) && !input.documentTestCode ? 'none' : requestedMode;
  }

  /** Whether a class/method with (or without) a docstring should get a Javadoc comment, per javadocMode. */
  private wantsJavadoc(hasDocstring: boolean): boolean {
    if (this.javadocMode === 'none') return false;
    if (this.javadocMode === 'docstringOnly') return hasDocstring;
    return true;
  }

  // ---------------------------------------------------------------- helpers

  private get depth(): number {
    return this.stack.length + 1;
  }

  private indentStr(depth = this.depth): string {
    return '    '.repeat(depth);
  }

  private emit(text: string, py: number, depth = this.depth): void {
    this.out.push({ text: text === '' ? '' : this.indentStr(depth) + text, py });
  }

  private flushTrivia(): void {
    for (const t of this.pendingTrivia) {
      const last = this.out[this.out.length - 1];
      if (t.kind === 'blank') {
        // no blank directly after an opening brace, and never two in a row
        if (!last || last.text === '' || /\{\s*(\/\/.*)?$/.test(last.text)) continue;
        this.emit('', 0, 0);
      } else {
        this.emit(`// ${t.text.replace(/^#\s?/, '')}`, t.py);
      }
    }
    this.pendingTrivia = [];
  }

  private top(): Block | undefined {
    return this.stack[this.stack.length - 1];
  }

  private enclosingClass(): Block | undefined {
    for (let i = this.stack.length - 1; i >= 0; i -= 1) {
      if (this.stack[i].kind === 'class') return this.stack[i];
      if (this.stack[i].kind === 'def' || this.stack[i].kind === 'main') return undefined;
    }
    return undefined;
  }

  private enclosingScope(): Block | undefined {
    for (let i = this.stack.length - 1; i >= 0; i -= 1) {
      const k = this.stack[i].kind;
      if (k === 'def' || k === 'main' || k === 'class' || k === 'static') return this.stack[i];
    }
    return undefined;
  }

  /** Nearest enclosing class, looking through def frames too (for `cls` inside method bodies). */
  private nearestClass(): Block | undefined {
    for (let i = this.stack.length - 1; i >= 0; i -= 1) {
      if (this.stack[i].kind === 'class') return this.stack[i];
    }
    return undefined;
  }

  /** Local names bound to Python modules with a Java counterpart (`os`, `osp` -> `os.path`, ...). */
  private pythonModules: Map<string, string>;
  /** Classes declared in this file (see `ExprContext.classNames`). */
  private classNameSet?: Set<string>;
  /** Names bound by `import x` / `import x as y`: modules, whose functions are not str/list methods. */
  private importedModules = new Set<string>();
  private classMethodCache = new Map<string, Set<string>>();

  /** Java type of a plain name: a local or parameter, a `self.x` / `this.x` field, a module global. */
  private nameType(name: string): string | undefined {
    const field = /^(?:self|this)\.(\w+)$/.exec(name);
    if (field) {
      const cls = this.nearestClass()?.className;
      return cls ? this.scan.classes.get(cls)?.fields.get(field[1]) : undefined;
    }
    if (!/^\w+$/.test(name)) return undefined;
    return this.enclosingScope()?.types?.get(name) ?? this.scan.moduleTypes.get(name);
  }

  /** Method names a class of this file defines (Python names), for `this.x()` calls. */
  private classMethodsOf(className: string | undefined): Set<string> | undefined {
    if (!className) return undefined;
    let methods = this.classMethodCache.get(className);
    if (!methods) {
      methods = this.scan.classes.get(className)?.methodNames ?? new Set();
      this.classMethodCache.set(className, methods);
    }
    return methods;
  }

  /** Functions defined under a module-level `if`/`try`: static fields holding a lambda, by name. */
  private moduleFunctions = new Map<string, FunctionShape>();

  private exprCtx(literals?: string[], valueContext = false): ExprContext {
    return {
      modules: this.pythonModules,
      classNames: (this.classNameSet ??= new Set(this.scan.classes.keys())),
      importedModules: this.importedModules,
      classMethods: this.classMethodsOf(this.nearestClass()?.className),
      typeOf: (name) => this.nameType(name),
      className: this.nearestClass()?.className,
      literals,
      valueContext,
      propertyAccessor: (name) => this.propertyGetter(name),
      fieldRenames: this.nearestClass()?.fieldRenames,
      localFunctions: this.localFunctionsInScope(),
    };
  }

  // ------------------------------------------------------ properties & types

  private propertyInfo(name: string): { trivial: boolean; boolean: boolean; setter: boolean } | undefined {
    if (this.knownAttributes.has(name)) return undefined; // also a plain attribute somewhere: ambiguous, leave alone
    return this.localKnown.properties[name] ?? this.known?.properties[name];
  }

  /** How a read of property `name` is rendered (`total()`, `getTotal()`, `isEmpty()`), or undefined when not a property. */
  private propertyGetter(name: string): string | undefined {
    const info = this.propertyInfo(name);
    if (!info) return undefined;
    if (this.input.lombokStyle && info.trivial) return `${info.boolean ? 'is' : 'get'}${toPascalCase(name)}()`;
    return `${name}()`;
  }

  /** Method name a write to property `name` is rendered with (`total`, `setTotal`), or undefined. */
  private propertySetter(name: string): string | undefined {
    const info = this.propertyInfo(name);
    if (!info || !info.setter) return undefined;
    return this.input.lombokStyle && info.trivial ? `set${toPascalCase(name)}` : name;
  }

  /** Type of a name in scope: locals/params of enclosing functions, then module-level declarations. */
  private lookupName(name: string): string | undefined {
    for (let i = this.stack.length - 1; i >= 0; i -= 1) {
      const t = this.stack[i].types?.get(name);
      if (t) return t;
    }
    return this.scan.moduleTypes.get(name);
  }

  /** Superclass (first base) of a class declared in this file, when it is a plain name. */
  private baseOf(className: string): string | undefined {
    const base = this.scan.classes.get(className)?.bases.find((b) => !/^(ABC|abc\.ABC|Protocol|typing\.Protocol|Generic\[.*\]|object)$/.test(b));
    return base ? classNameOf(base.replace(/\[.*$/, '')) : undefined;
  }

  private returnTypeOf(className: string | undefined, method: string): string | undefined {
    if (!className) return this.scan.functions.get(method) ?? this.known?.returnTypes[method];
    const visited = new Set<string>();
    for (let c: string | undefined = className; c && !visited.has(c); c = this.baseOf(c)) {
      visited.add(c);
      const local = this.scan.classes.get(c);
      const r = local?.methods.get(method) ?? this.propertyTypeOf(c, method) ?? this.known?.returnTypes[`${c}.${method}`];
      if (r) return r;
    }
    return undefined;
  }

  private propertyTypeOf(className: string, prop: string): string | undefined {
    const p = this.scan.classes.get(className)?.properties.get(prop);
    if (!p) return this.known?.returnTypes[`${className}.${prop}`];
    return p.returnType ?? (p.trivialField ? this.fieldTypeOf(className, p.trivialField) : undefined);
  }

  private fieldTypeOf(className: string | undefined, field: string, fieldsSoFar?: Map<string, FieldInfo>): string | undefined {
    const soFar = fieldsSoFar?.get(field)?.type;
    if (soFar && soFar !== 'Object') return soFar;
    if (!className) return undefined;
    const visited = new Set<string>();
    for (let c: string | undefined = className; c && !visited.has(c); c = this.baseOf(c)) {
      visited.add(c);
      const t = this.scan.classes.get(c)?.fields.get(field) ?? this.known?.fieldTypes[`${c}.${field}`];
      if (t && t !== 'Object') return t;
    }
    return undefined;
  }

  /** `callee(args)` when `t` is exactly one call expression. */
  private static splitCall(t: string): { callee: string } | undefined {
    const open = t.indexOf('(');
    if (open <= 0 || !t.endsWith(')')) return undefined;
    const callee = t.slice(0, open);
    if (!/^[\w.]+$/.test(callee)) return undefined;
    let depth = 0;
    for (let i = open; i < t.length; i += 1) {
      if (t[i] === '(') depth += 1;
      else if (t[i] === ')') {
        depth -= 1;
        if (depth === 0) return i === t.length - 1 ? { callee } : undefined;
      }
    }
    return undefined;
  }

  /** Class a receiver expression denotes: `self`/`cls` -> the enclosing class, `Foo` -> Foo, otherwise the class of its type. */
  private receiverClass(recv: string, lits: string[], opts: { className?: string; fields?: Map<string, FieldInfo> }): string | undefined {
    if (recv === 'self' || recv === 'cls') return opts.className ?? this.nearestClass()?.className;
    if (/^[A-Z]\w*$/.test(recv) && (this.scan.classes.has(recv) || Object.keys(this.known?.returnTypes ?? {}).some((k) => k.startsWith(`${recv}.`)))) return recv;
    return classNameOf(this.typeOf(recv, lits, opts));
  }

  /**
   * Java type of a masked Python expression, from what is in scope: names, `self.field`,
   * calls to functions/methods with return hints (including on typed receivers), and
   * attribute reads on typed receivers. Undefined when unknown.
   */
  private typeOf(masked: string, lits: string[], opts: { className?: string; fields?: Map<string, FieldInfo> } = {}): string | undefined {
    const t = masked.trim();
    const className = opts.className ?? this.nearestClass()?.className;
    let m: RegExpExecArray | null;
    if (/^\w+$/.test(t)) return this.lookupName(t);
    if ((m = /^(self|cls)\.(\w+)$/.exec(t))) return this.fieldTypeOf(className, m[2], opts.fields) ?? (className ? this.propertyTypeOf(className, m[2]) : undefined);
    const call = RuleTranslation.splitCall(t);
    if (call) {
      if (/^\w+$/.test(call.callee)) return this.returnTypeOf(undefined, call.callee) ?? (/^[A-Z]/.test(call.callee) ? call.callee : undefined);
      const dot = /^(.+)\.(\w+)$/.exec(call.callee);
      if (!dot) return undefined;
      const recvClass = this.receiverClass(dot[1], lits, opts);
      if (recvClass) return this.returnTypeOf(recvClass, dot[2]);
      return /^[A-Z]\w*$/.test(dot[2]) ? dot[2] : undefined;
    }
    if ((m = /^(.+)\.(\w+)$/.exec(t))) {
      const recvClass = this.receiverClass(m[1], lits, opts);
      return recvClass ? this.fieldTypeOf(recvClass, m[2]) ?? this.propertyTypeOf(recvClass, m[2]) : undefined;
    }
    return undefined;
  }

  /** Type for a value being assigned: literal shapes first, then whatever the type environment knows. */
  private inferValueType(masked: string, lits: string[]): string {
    const t = inferTypeFromMaskedValue(masked, lits);
    return t === 'var' ? this.typeOf(masked, lits) ?? 'var' : t;
  }

  /** Enclosing class names, outermost first, always starting with the module class. */
  private classChain(): string[] {
    return [this.moduleClass, ...this.stack.filter((b) => b.kind === 'class').map((b) => b.className!)];
  }

  /**
   * Record a declaration for "Go to Definition". Call this right after the `emit()` that produced
   * it, and before pushing a new class block onto the stack (so a class's own `container` reflects
   * only its enclosing classes, not itself).
   */
  private recordSymbol(name: string, kind: SymbolKind, py: number): void {
    this.symbols.push({ name, kind, container: this.classChain(), javaLineRaw: this.out.length - 1, py });
  }

  private expr(pythonExpr: string): string {
    return translateExpression(pythonExpr, this.exprCtx());
  }

  private warn(msg: string, py: number): void {
    this.warnings.push(`${this.input.relativePath}:${py}: ${msg}`);
  }

  /** Split a trailing `# comment` off a masked statement. */
  private splitComment(masked: string): { code: string; comment: string } {
    const idx = masked.indexOf('#');
    if (idx < 0) return { code: masked.trim(), comment: '' };
    return { code: masked.slice(0, idx).trim(), comment: ' // ' + masked.slice(idx + 1).trim() };
  }

  private closeBlocksTo(indent: number, continuation: boolean): void {
    while (this.stack.length > 0 && this.top()!.indent >= indent) {
      const block = this.stack.pop()!;
      for (const name of block.blockLocals ?? []) this.enclosingScope()?.declared?.delete(name);
      if (continuation && block.indent === indent) {
        this.lastClosed = block;
        return; // the continuation header emits "} else {" itself
      }
      this.endGenerator(block);
      this.emit(block.closer ?? '}', 0, this.depth);
    }
  }

  private closeAll(): void {
    while (this.stack.length > 0) {
      const block = this.stack.pop()!;
      this.endGenerator(block);
      this.emit(block.closer ?? '}', 0, this.depth);
    }
  }

  /** A generator body ends by returning what it collected, unless its last statement already left. */
  private endGenerator(block: Block): void {
    if (!block.yielded) return;
    const last = [...this.out].reverse().find((o) => o.text.trim() !== '' && !/^\s*\/\//.test(o.text));
    if (last && /^\s*(return|throw)\b/.test(last.text)) return;
    // After a `while (true)` that never breaks, the end is unreachable: javac rejects a return there.
    if (last && /^\s*}\s*$/.test(last.text)) {
      const indent = /^\s*/.exec(last.text)![0];
      const at = this.out.lastIndexOf(last);
      let k = at - 1;
      while (k >= 0 && !(this.out[k].text.startsWith(indent) && /^\S/.test(this.out[k].text.slice(indent.length)))) k -= 1;
      const loop = this.out.slice(k, at);
      if (k >= 0 && /^\s*while \(true\) \{/.test(this.out[k].text) && !loop.some((o) => /^\s*break;/.test(o.text))) return;
    }
    this.emit(this.generatorReturn(block), 0, this.depth + 1);
  }

  /**
   * Functions defined under a module-level `if`, `try` or `with` (platform switches, optional
   * imports): Java cannot define a method conditionally, so each is a static field of the module
   * class holding a lambda, assigned in the static block. Found before translating, so that calls
   * anywhere in the file (`f(x)` -> `f.apply(x)`) go through the field. The first definition of a
   * name sets its shape.
   */
  private moduleConditionalDefs(): Map<string, FunctionShape> {
    const found = new Map<string, FunctionShape>();
    const open: LogicalLine[] = [];
    this.lines.forEach((l, i) => {
      if (l.kind !== 'code') return;
      while (open.length && open[open.length - 1].indent >= l.indent) open.pop();
      const m = /^(?:async\s+)?def\s+(\w+)\s*(?:\[[^\]]*\])?\s*\((.*)\)\s*(?:->\s*(.+?))?\s*:/.exec(l.text);
      const compound = open.length > 0 && open[0].indent === 0 && open.every((b) => !/^(?:async\s+)?(def|class)\s/.test(b.text));
      if (m && compound && !found.has(m[1])) {
        const ret = m[3] ? translateType(m[3]) : this.inferReturnType(i);
        const rawParams = splitTopLevel(m[2]).map((p) => p.trim()).filter(Boolean);
        const types = new Map<string, string>();
        for (const p of rawParams) {
          const hint = /^(\w+)\s*:\s*([^=]+?)\s*(?:=.*)?$/.exec(p);
          if (hint) types.set(hint[1], translateType(hint[2]));
        }
        found.set(m[1], functionShape(rawParams, ret, types));
      }
      if (/:\s*(#.*)?$/.test(l.text)) open.push(l);
    });
    return found;
  }

  /** Nested functions visible here (from every enclosing function scope, and the module's conditional defs), or undefined. */
  private localFunctionsInScope(): Map<string, LocalFunction> | undefined {
    let all: Map<string, LocalFunction> | undefined = this.moduleFunctions.size ? new Map(this.moduleFunctions) : undefined;
    for (const b of this.stack) {
      if (!b.localFunctions?.size) continue;
      all ??= new Map();
      for (const [k, v] of b.localFunctions) all.set(k, v);
    }
    return all;
  }

  /** Next code line index after i (skipping blanks/comments) if it is a docstring for the block opened at i. */
  private docstringAfter(i: number): number {
    if (this.inlineBody !== undefined) return -1; // a one-liner has no block to hold a docstring
    const header = this.lines[i];
    for (let j = i + 1; j < this.lines.length; j += 1) {
      const l = this.lines[j];
      if (l.kind !== 'code') continue;
      if (l.indent <= header.indent) return -1;
      const masked = maskStrings(l.text);
      return isSingleLiteral(masked.text) ? j : -1;
    }
    return -1;
  }

  /** Body lines of a docstring literal, dedented and stripped of the quote delimiters. */
  private docstringBody(line: LogicalLine): string[] {
    const raw = line.text.replace(/^[rRuUbB]*("""|'''|"|')/, '').replace(/("""|'''|"|')$/, '');
    const bodyLines = raw.split('\n').map((l) => l.trim());
    while (bodyLines.length && bodyLines[0] === '') bodyLines.shift();
    while (bodyLines.length && bodyLines[bodyLines.length - 1] === '') bodyLines.pop();
    return bodyLines;
  }

  /**
   * Javadoc lines for a class: the docstring if there is one, otherwise a description
   * extrapolated from the class name.
   */
  private classJavadoc(name: string, docLine: LogicalLine | undefined, py: number, trailer: string[] = []): OutLine[] {
    const description = docLine ? this.docstringBody(docLine) : [describeClassSummary(name)];
    if (trailer.length) description.push('', ...trailer);
    const at = docLine ? docLine.startLine : py;
    return renderJavadoc(description).map((text) => ({ text, py: at }));
  }

  /**
   * Javadoc lines for a method: the docstring (if any) as the description, plus
   * `@param`/`@return` tags always extrapolated from the Java signature.
   */
  private methodJavadoc(
    pythonName: string,
    docLine: LogicalLine | undefined,
    isCtor: boolean,
    className: string | undefined,
    dunderDoc: string | undefined,
    paramNames: string[],
    ret: string,
    py: number,
  ): OutLine[] {
    const description = docLine ? this.docstringBody(docLine) : [describeMethodSummary(pythonName, isCtor, className, dunderDoc)];
    const paramTags = paramNames.map((n) => paramTag(n));
    const retTag = returnTag(pythonName, ret, isCtor);
    const at = docLine ? docLine.startLine : py;
    return renderJavadoc(description, paramTags, retTag).map((text) => ({ text, py: at }));
  }

  private takeDecorators(): { text: string; py: number }[] {
    const d = this.pendingDecorators;
    this.pendingDecorators = [];
    return d;
  }

  private decoratorToAnnotation(text: string): string {
    const m = /^@([\w.]+)(\(.*\))?$/.exec(text.trim());
    if (!m) return `// ${text}`;
    const name = m[1].split('.').pop()!;
    const pascal = name.charAt(0).toUpperCase() + name.slice(1);
    if (!m[2] || m[2].slice(1, -1).trim() === '') return `@${pascal}`;
    // Annotation arguments are `name = constant` pairs (or one constant); anything else in a
    // decorator call (`@lru_cache(maxsize=None, typed=True)` is fine, `@wraps(func)` is not)
    // stays a comment rather than an annotation javac rejects.
    const args = splitTopLevel(m[2].slice(1, -1)).map((a) => a.trim()).filter(Boolean);
    const constant = (v: string) => /^(-?\d[\w.]*|"(?:[^"\\]|\\.)*"|true|false)$/.test(v);
    const pairs = args.map((a) => /^(\w+)\s*=(?!=)\s*(.+)$/.exec(a));
    if (pairs.every((p) => p && constant(this.expr(p[2])))) return `@${pascal}(${pairs.map((p) => `${p![1]} = ${this.expr(p![2])}`).join(', ')})`;
    if (args.length === 1 && !pairs[0] && constant(this.expr(args[0]))) return `@${pascal}(${this.expr(args[0])})`;
    return `// ${text.trim()}`;
  }

  /** Lines of the body of the block whose header is at index i. */
  private bodyLines(i: number): LogicalLine[] {
    const header = this.lines[i];
    const body: LogicalLine[] = [];
    for (let j = i + 1; j < this.lines.length; j += 1) {
      const l = this.lines[j];
      if (l.kind !== 'code') continue;
      if (l.indent <= header.indent) break;
      body.push(l);
    }
    return body;
  }

  // ------------------------------------------------------------- statements

  translate(): TranslateResult {
    // Module docstring
    let first = this.lines.findIndex((l) => l.kind === 'code');
    const hasModuleDoc = first >= 0 && isSingleLiteral(maskStrings(this.lines[first].text).text);
    if (hasModuleDoc && this.javadocMode !== 'none') this.skipIndex = first;
    // A package module is renamed after its folder (inventory/__init__.py -> Inventory), so say where it came from.
    const initOrigin = isInitModule(this.input.relativePath)
      ? { javadoc: `Translated from {@code ${this.input.relativePath}}, the {@code ${this.packageParts[this.packageParts.length - 1] ?? this.moduleClass}} package's __init__ module.`, comment: `// Translated from ${this.input.relativePath}, the package's __init__ module.` }
      : undefined;
    this.moduleDoc = this.wantsJavadoc(hasModuleDoc)
      ? this.classJavadoc(this.moduleClass, hasModuleDoc ? this.lines[first] : undefined, 0, initOrigin ? [initOrigin.javadoc] : [])
      : initOrigin ? [{ text: initOrigin.comment, py: 0 }] : [];

    for (let i = 0; i < this.lines.length; i += 1) {
      if (i === this.skipIndex) continue;
      const line = this.lines[i];
      if (line.kind === 'blank') {
        const last = this.pendingTrivia[this.pendingTrivia.length - 1];
        if (!last || last.kind !== 'blank') this.pendingTrivia.push({ kind: 'blank', text: '', py: 0 });
        continue;
      }
      if (line.kind === 'comment') {
        this.pendingTrivia.push({ kind: 'comment', text: line.text, py: line.startLine });
        continue;
      }
      this.translateCode(i);
    }
    // Trailing comments belong to the module; trailing blanks are dropped.
    this.pendingTrivia = this.pendingTrivia.filter((t) => t.kind === 'comment');
    this.closeAll();
    this.flushTrivia();

    return this.assemble();
  }

  private assemble(): TranslateResult {
    const header: OutLine[] = [];
    header.push({ text: `// Java view of ${this.input.relativePath}`, py: 0 });
    header.push({ text: '// Generated by Pyrite (rules engine). Read-only reading aid: edit the Python source instead.', py: 0 });
    const pkg = packageFromPath(this.input.relativePath, this.input.basePackage);
    if (pkg) header.push({ text: `package ${pkg};`, py: 0 });
    header.push({ text: '', py: 0 });
    header.push({ text: 'import java.util.*;', py: 0 });
    header.push({ text: 'import java.util.function.*;', py: 0 });
    header.push({ text: 'import java.util.stream.*;', py: 0 });
    if (this.out.some((l) => /\b(BufferedReader|FileReader|PrintWriter|FileWriter|FileInputStream|FileOutputStream)\b/.test(l.text))) {
      header.push({ text: 'import java.io.*;', py: 0 });
    }
    if (this.imports.length) {
      header.push({ text: '', py: 0 });
      header.push(...this.imports);
    }
    header.push({ text: '', py: 0 });
    header.push(...this.moduleDoc);
    const promoted = this.promoteModuleNamedClass();
    this.terminateEnumConstants(Boolean(promoted && /^public enum\b/.test(promoted.header.text)));
    if (promoted) {
      // The module's Javadoc and the class's would read as one; keep them apart.
      if (this.moduleDoc.length && promoted.lead.some((l) => l.text.startsWith('/**'))) header.push({ text: '', py: 0 });
      header.push(...promoted.lead, promoted.header);
    } else {
      header.push({ text: `public final class ${this.moduleClass} {`, py: 0 });
    }

    // Trim trailing blank lines from body
    while (this.out.length && this.out[this.out.length - 1].text === '') this.out.pop();
    // Wrap long body lines to the configured width. `lead` counts lines (a moved comment)
    // placed above the statement itself, so symbols still point at their declaration.
    const width = this.input.lineWidth ?? DEFAULT_LINE_WIDTH;
    const body = this.out.map((l) => {
      const f = formatJavaLine(l.text, width);
      return { text: f.text, py: l.py, lead: f.lead };
    });
    const all: (OutLine & { lead?: number })[] = [...header, ...body, { text: '}', py: 0 }, { text: '', py: 0 }];
    // An emitted statement can span several physical lines (wrapped lines, text blocks), so the
    // source map and the symbols' line numbers are built from physical lines, not emitted entries.
    const sourceMap: number[] = [];
    const physicalLineOf: number[] = [];
    for (const l of all) {
      physicalLineOf.push(sourceMap.length + (l.lead ?? 0));
      const count = l.text.split('\n').length;
      for (let k = 0; k < count; k += 1) sourceMap.push(l.py);
    }
    const symbols: SymbolInfo[] = [
      { name: this.moduleClass, kind: 'class', container: [], javaLine: physicalLineOf[header.length - 1], pythonLine: promoted?.header.py ?? 1, ...(promoted && { pythonClass: true }) },
      ...this.symbols.map((s) => ({ name: s.name, kind: s.kind, container: s.container, javaLine: physicalLineOf[header.length + s.javaLineRaw], pythonLine: s.py })),
    ];
    return {
      java: all.map((l) => l.text).join('\n'),
      sourceMap,
      symbols,
      warnings: this.warnings,
      engine: 'rules',
    };
  }

  /**
   * Enum constants are written `NAME(value),`. When members follow them, Java needs the list to
   * end with `;` instead, so the last constant's comma becomes a semicolon.
   */
  private terminateEnumConstants(promotedEnum: boolean): void {
    const out = this.out;
    // Each enum body: where it starts, and the closing line that ends it (absent for the module's own enum).
    const bodies: { from: number; close?: string }[] = promotedEnum ? [{ from: 0 }] : [];
    out.forEach((l, h) => {
      const header = /^(\s*)(public )?enum\s.*\{/.exec(l.text);
      if (header) bodies.push({ from: h + 1, close: `${header[1]}}` });
    });
    for (const { from, close } of bodies) {
      let last = -1;
      let k = from;
      for (; k < out.length; k += 1) {
        const t = out[k].text;
        if (t === '' || /^\s*\/\//.test(t)) continue;
        if (!/^\s*[A-Z_][A-Z0-9_]*(\(.*\))?,(\s*\/\/.*)?$/.test(t)) break;
        last = k;
      }
      if (last < 0 || k >= out.length || out[k].text === close) continue;
      out[last] = { ...out[last], text: out[last].text.replace(/,(\s*\/\/.*)?$/, ';$1') };
    }
  }

  /**
   * `order_service.py` declaring `class OrderService` would give `OrderService.OrderService`, which
   * Java rejects (a nested class cannot share its enclosing class's name). Instead that class
   * becomes the module's class: its Javadoc, annotations and header move to the top, its body is
   * dedented one level, and the module's constants and functions stay around it as static
   * members. An enum's body moves to the top, since its constants must come first.
   * Returns the lines that replace the module class header, or undefined when there is no such class.
   */
  private promoteModuleNamedClass(): { lead: OutLine[]; header: OutLine } | undefined {
    const symbol = this.symbols.find((s) => s.kind === 'class' && s.name === this.moduleClass && s.container.length === 1);
    if (!symbol) return undefined;
    const h = symbol.javaLineRaw;
    const out = this.out;
    if (!/^ {4}public\b.*\b(class|enum|interface)\s/.test(out[h]?.text ?? '')) return undefined;

    // The class's closing brace: the line where the brace depth opened at the header returns to 0.
    let depth = 0;
    let end = -1;
    for (let k = h; k < out.length && end < 0; k += 1) {
      for (const code of codeOnly(out[k].text.split('\n'))) {
        for (const ch of code) depth += ch === '{' ? 1 : ch === '}' ? -1 : 0;
      }
      if (k > h && depth === 0) end = k;
    }
    if (end < 0 || out[end].text.trim() !== '}') return undefined;

    // Javadoc, annotations and block comments directly above the header belong to the class.
    let start = h;
    while (start > 0 && /^ {4}(@|\/\*| \*)/.test(out[start - 1].text)) start -= 1;

    const dedent = (l: OutLine): OutLine => ({ text: l.text.split('\n').map((t) => t.replace(/^ {4}/, '')).join('\n'), py: l.py });
    const lead = out.slice(start, h).map(dedent);
    const headerText = out[h].text.trim().replace(/^public (abstract )?static class\b/, 'public $1class');
    const header = { text: headerText, py: out[h].py };
    const isEnum = /^public enum\b/.test(headerText);

    // New order of the old entries (by index); -1 marks the promoted class's own lines.
    const inner = Array.from({ length: end - h - 1 }, (_, k) => h + 1 + k);
    const before = Array.from({ length: start }, (_, k) => k);
    const after = Array.from({ length: out.length - end - 1 }, (_, k) => end + 1 + k);
    const order = isEnum ? [...inner, ...before, ...after] : [...before, ...inner, ...after];
    const kept: number[] = [];
    for (const k of order) {
      // No blank line first in the body, and never two in a row where the class was cut out.
      const prev = kept.length ? out[kept[kept.length - 1]].text : '';
      if (out[k].text === '' && (!kept.length || prev === '')) continue;
      kept.push(k);
    }
    if (isEnum && kept.length > inner.length) {
      // Keep a blank line between the enum's own members and the module's.
      const firstModule = kept.findIndex((k) => k < h || k > end);
      if (firstModule > 0 && out[kept[firstModule]].text !== '') kept.splice(firstModule, 0, -2);
    }
    const newIndex = new Map<number, number>();
    const rebuilt: OutLine[] = kept.map((k, n) => {
      if (k === -2) return { text: '', py: 0 };
      newIndex.set(k, n);
      return k > h && k < end ? dedent(out[k]) : out[k];
    });
    out.splice(0, out.length, ...rebuilt);

    const symbols = this.symbols.filter((s) => s !== symbol && newIndex.has(s.javaLineRaw));
    for (const s of symbols) {
      s.javaLineRaw = newIndex.get(s.javaLineRaw)!;
      if (s.container[1] === this.moduleClass) s.container = [this.moduleClass, ...s.container.slice(2)];
    }
    this.symbols.splice(0, this.symbols.length, ...symbols);
    return { lead, header };
  }

  private translateCode(i: number): void {
    const line = this.lines[i];
    const py = line.startLine;

    // `case` is not a continuation like `else`/`except`: each case arm is its own `{ ... }`,
    // so the previous arm must be closed with a normal `}` before the next one opens.
    const continuation = /^(elif\b|else\b|except\b|finally\b)/.test(line.text);
    this.closeBlocksTo(line.indent, continuation);
    if (continuation) {
      // Comments between a block and its else/except belong inside the closing block.
      this.pendingTrivia = this.pendingTrivia.filter((t) => t.kind !== 'blank');
    }
    // Comments from inside a multi-line statement go right above it.
    for (const c of line.comments ?? []) this.pendingTrivia.push({ kind: 'comment', text: `# ${c}`, py });
    this.flushTrivia();

    // Masking renders f-strings, whose fields need this statement's context (see expressions.ts).
    setFStringExpressionContext(this.exprCtx());
    const masked = maskStrings(line.text);
    const split = this.splitComment(masked.text);
    const code = split.code;
    let comment = split.comment;
    const lits = masked.literals;
    const un = (s: string) => unmaskStrings(s, lits);

    if (code === '') {
      if (comment) this.emit(comment.trim(), py);
      return;
    }
    if (!continuation) this.placeInStaticBlock(code, py);
    if (!continuation) this.emitHoistedLocals(i, py);

    // `if x: return 1`, `except: pass`, `def f(): return 1` - a compound statement with its body
    // on the same line. The header opens the block as usual; the body is translated inside it,
    // and the block closes when the next line (at the same or a lower indent) is reached, so a
    // following `else:` / `except:` still chains onto it.
    const oneLiner = this.splitOneLineCompound(code);
    if (oneLiner) {
      this.inlineBody = oneLiner.body;
      try {
        this.translateStatement(i, line, `${oneLiner.header}:`, lits, un, py, comment);
      } finally {
        this.inlineBody = undefined;
      }
      for (const stmt of splitTopLevel(oneLiner.body, ';')) this.translateSimple(stmt.trim(), lits, py, '');
      return;
    }
    this.translateStatement(i, line, code, lits, un, py, comment);
  }

  /** Body of a one-line compound statement being translated, if any (see translateCode). */
  private inlineBody: string | undefined;

  /** `header: body` when `code` is a compound statement with an inline body, else undefined. */
  private splitOneLineCompound(code: string): { header: string; body: string } | undefined {
    if (!/^(async\s+)?(if|elif|else|for|while|try|except|finally|with|def|class|case)\b/.test(code) || /:$/.test(code)) return undefined;
    let depth = 0;
    for (let k = 0; k < code.length; k += 1) {
      const ch = code[k];
      if (ch === '(' || ch === '[' || ch === '{') depth += 1;
      else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
      else if (ch === ':' && depth === 0 && code[k + 1] !== '=') {
        const header = code.slice(0, k).trim();
        const body = code.slice(k + 1).trim();
        // A top-level lambda's colon would be mistaken for the header's; leave such lines alone.
        if (!body || /\blambda\b/.test(header)) return undefined;
        return { header, body };
      }
    }
    return undefined;
  }

  /** An `import` / `from ... import` statement: recorded for the import block (wherever it appears). */
  private translateImport(code: string, py: number): boolean {
    let m: RegExpExecArray | null;
    if ((m = /^import\s+(.+)$/.exec(code))) {
      for (const part of splitTopLevel(m[1])) {
        const [mod, alias] = part.split(/\s+as\s+/).map((s) => s.trim());
        this.imports.push({ text: `import ${this.qualifyProjectModule(mod, false)};${alias ? ` // as ${alias}` : ''}`, py });
      }
      return true;
    }
    if ((m = /^from\s+(\S+)\s+import\s+(.+)$/.exec(code))) {
      if (m[1] === '__future__') return true;
      const mod = this.qualifyProjectModule(this.resolveModule(m[1]), m[1].startsWith('.'));
      const names = m[2].replace(/^\(|\)$/g, '');
      if (names.trim() === '*') {
        this.imports.push({ text: `import ${mod}.*;`, py });
      } else {
        for (const part of splitTopLevel(names)) {
          const [name, alias] = part.split(/\s+as\s+/).map((s) => s.trim());
          if (!name) continue;
          const dotted = mod ? `${mod}.${name}` : name;
          this.imports.push({ text: `import ${dotted};${alias ? ` // as ${alias}` : ''}`, py });
        }
      }
      return true;
    }
    return false;
  }

  private translateStatement(i: number, line: LogicalLine, code: string, lits: string[], un: (s: string) => string, py: number, comment: string): void {
    const masked = { literals: lits };
    void masked;

    // decorators
    if (code.startsWith('@')) {
      this.pendingDecorators.push({ text: un(code), py });
      return;
    }

    // imports
    if (this.translateImport(code, py)) return;
    let m: RegExpExecArray | null;

    // compound statements
    if ((m = /^class\s+(\w+)\s*(\[[^\]]*\])?\s*(?:\((.*)\))?\s*:$/.exec(code))) {
      this.translateClass(i, m[1], m[3] ?? '', comment, typeParamsOf(m[2]));
      return;
    }
    if ((m = /^(async\s+)?def\s+(\w+)\s*(\[[^\]]*\])?\s*\((.*)\)\s*(?:->\s*(.+?))?\s*:$/.exec(code))) {
      this.translateDef(i, Boolean(m[1]), m[2], un(m[4]), m[5] ? un(m[5]) : undefined, comment, typeParamsOf(m[3]));
      return;
    }
    if (/^if\s+__name__\s*==\s*.\d+.\s*:$/.test(code)) {
      this.emit(`public static void main(String[] args) {${comment}`, py);
      this.stack.push({ indent: line.indent, kind: 'main', declared: new Set(['args']), types: new Map([['args', 'String[]']]), hoists: planHoistedLocals(this.lines, i, new Set(['args'])) });
      return;
    }
    if ((m = /^if\s+(.+):$/.exec(code))) {
      this.emit(`if (${this.condition(m[1], lits)}) {${comment}`, py);
      this.stack.push({ indent: line.indent, kind: 'if' });
      return;
    }
    if ((m = /^elif\s+(.+):$/.exec(code))) {
      this.emit(`} else if (${this.condition(m[1], lits)}) {${comment}`, py);
      this.stack.push({ indent: line.indent, kind: 'if' });
      return;
    }
    if (/^else\s*:$/.test(code)) {
      const prev = this.lastClosed;
      if (prev?.loopFlag) {
        // Java has no loop-else: the loop sets a flag when it breaks.
        this.emit('}', py);
        this.emit(`if (!${prev.loopFlag}) { // loop-else: runs when the loop did not break${comment}`, py);
      } else if (prev?.raisedFlag) {
        // Java has no try-else: every except sets a flag. Outside the try, so the excepts do not
        // catch what the else part raises - as in Python.
        this.emit('}', py);
        this.emit(`if (!${prev.raisedFlag}) { // try-else: runs when no exception was raised${comment}`, py);
      } else {
        this.emit(`} else {${comment}`, py);
      }
      this.stack.push({ indent: line.indent, kind: 'if' });
      return;
    }
    if ((m = /^while\s+(.+):$/.exec(code))) {
      const loopFlag = this.loopElseFlag(i, py);
      this.emit(`while (${this.condition(m[1], lits)}) {${comment}`, py);
      this.stack.push({ indent: line.indent, kind: 'while', loopFlag });
      return;
    }
    if ((m = /^(async\s+)?for\s+(.+?)\s+in\s+(.+):$/.exec(code))) {
      const loopFlag = this.loopElseFlag(i, py);
      this.translateFor(line, m[2], m[3], lits, Boolean(m[1]), comment);
      // translateFor pushes the loop's block (and may emit unpacking lines into it).
      const loop = [...this.stack].reverse().find((b) => b.kind === 'for' && b.indent === line.indent);
      if (loop && loopFlag) loop.loopFlag = loopFlag;
      return;
    }
    if (/^try\s*:$/.test(code)) {
      const clauses = this.clausesAfter(i);
      const raisedFlag = clauses.has('else') && clauses.has('except') ? this.freeLocalName('raised') : undefined;
      if (raisedFlag && clauses.has('finally')) {
        // try / except / else / finally: the finally needs a try of its own around all of it.
        this.emit(`try { // try / except / else / finally${comment}`, py);
        this.stack.push({ indent: line.indent, kind: 'try', finallyWrapper: true });
        comment = '';
      }
      if (raisedFlag) this.emit(`boolean ${raisedFlag} = false;`, py);
      this.emit(`try {${comment}`, py);
      this.stack.push({ indent: line.indent, kind: 'try', raisedFlag });
      return;
    }
    if ((m = /^except\s*(?:\(?([^)]*?)\)?)?\s*(?:as\s+(\w+))?\s*:$/.exec(code))) {
      const types = (m[1] ?? '').trim();
      // Two Python types can map to one Java type (ValueError, TypeError); a multi-catch may not repeat it.
      const names = types ? [...new Set(splitTopLevel(types).map((t) => mapExceptionName(t.trim())))].join(' | ') : 'Exception';
      const variable = m[2] ?? (types ? 'ignored' : 'e');
      const raisedFlag = this.lastClosed?.raisedFlag;
      this.emit(`} catch (${names} ${variable}) {${comment}`, py);
      this.stack.push({ indent: line.indent, kind: 'try', catchVar: variable, raisedFlag });
      if (raisedFlag) this.emit(`${raisedFlag} = true;`, py);
      return;
    }
    if (/^finally\s*:$/.test(code)) {
      const wrapper = this.top();
      if (wrapper?.finallyWrapper && wrapper.indent === line.indent) {
        // Close the try-else's `if`, then the wrapper's `try` takes the finally.
        this.emit('}', py);
        this.stack.pop();
      }
      this.emit(`} finally {${comment}`, py);
      this.stack.push({ indent: line.indent, kind: 'try' });
      return;
    }
    if ((m = /^(async\s+)?with\s+(.+):$/.exec(code))) {
      this.translateWith(line, m[2], lits, Boolean(m[1]), comment);
      return;
    }
    if ((m = /^match\s+(.+):$/.exec(code))) {
      this.emit(`switch (${un(translateMaskedExpression(m[1], this.exprCtx(lits)))}) {${comment}`, py);
      this.stack.push({ indent: line.indent, kind: 'match' });
      return;
    }
    if ((m = /^case\s+(.+):$/.exec(code))) {
      const pattern = m[1].trim() === '_' ? 'default' : `case ${un(translateMaskedExpression(m[1], this.exprCtx(lits)))}`;
      this.emit(`${pattern} -> {${comment}`, py);
      this.stack.push({ indent: line.indent, kind: 'case' });
      return;
    }
    if (/^(if|for|while|with|try|def|class)\b.*:$/.test(code)) {
      // A compound statement we did not recognise - keep it readable and open a block.
      this.warn(`Unrecognised compound statement: ${line.text}`, py);
      this.emit(`${un(code.slice(0, -1))} { // TODO: untranslated${comment}`, py);
      this.stack.push({ indent: line.indent, kind: 'other' });
      return;
    }

    // simple statements (possibly several on one line: a = 1; b = 2)
    const simpleStatements = splitTopLevel(code, ';');
    for (const stmt of simpleStatements) {
      this.translateSimple(stmt.trim(), lits, py, comment);
      comment = '';
    }
  }

  /** The block a continuation header (`else:`, `except:`, ...) just closed. */
  private lastClosed: Block | undefined;

  /** Resolve a relative module (".models", "..repository") against this file's package. */
  private resolveModule(mod: string): string {
    const dots = /^\.+/.exec(mod)?.[0].length ?? 0;
    if (dots === 0) return mod;
    const base = this.packageParts.slice(0, Math.max(0, this.packageParts.length - (dots - 1)));
    const rest = mod.slice(dots);
    return [...base, rest].filter(Boolean).join('.');
  }

  /**
   * Put the base package in front of a module of this project, as its Java package has it:
   * `inventory.models` -> `shop.inventory.models`. A relative import is always one of the project's;
   * an absolute one is when it starts with a top-level package the project scan found.
   */
  private qualifyProjectModule(mod: string, relative: boolean): string {
    const base = this.input.basePackage;
    if (!base) return mod;
    if (!relative) {
      const top = mod.split('.')[0];
      const projectTops = Object.keys(this.known?.modules ?? {}).map((k) => k.split('.')[0]);
      if (!projectTops.includes(top)) return mod;
    }
    return mod ? `${base}.${mod}` : base;
  }

  private condition(maskedCond: string, lits: string[]): string {
    const java = translateMaskedExpression(maskedCond.trim(), this.exprCtx(lits));
    return unmaskStrings(this.truthy(java), lits);
  }

  /**
   * Python truthiness in a (masked) Java condition: each operand of `&&`, `||` and `!` that is a
   * value rather than a boolean expression is tested with `Py.truthy` (None, zero and empty are
   * false), since Java only accepts booleans there.
   *
   *   if items and not done:   ->   if (Py.truthy(items) && !done)      (done is a boolean)
   */
  private truthy(java: string): string {
    const parts = splitBoolean(java);
    if (!parts) return java;
    return parts.map((part, k) => (k % 2 ? part : this.truthyOperand(part))).join('');
  }

  private truthyOperand(operand: string): string {
    const lead = /^\s*/.exec(operand)![0];
    const trail = /\s*$/.exec(operand)![0];
    let text = operand.trim();
    let bangs = '';
    while (text.startsWith('!') && !text.startsWith('!=')) {
      bangs += '!';
      text = text.slice(1).trim();
    }
    if (text.startsWith('(') && groupEndIndex(text) === text.length && !/^\((int|long|double|float|char|boolean|String)\)/.test(text)) {
      return `${lead}${bangs}(${this.truthy(text.slice(1, -1))})${trail}`;
    }
    if (this.isBooleanExpression(text)) return `${lead}${bangs}${text}${trail}`;
    return `${lead}${bangs}Py.truthy(${text})${trail}`;
  }

  /** Whether a Java expression is already a boolean (a comparison, a predicate call, a boolean name). */
  private isBooleanExpression(text: string): boolean {
    if (/^(true|false)$/.test(text) || /\/\* walrus \*\//.test(text) || /^Py\.truthy\(/.test(text)) return true;
    if (indexAtDepth0(text, /==|!=|<=|>=|<(?![\w?]+>)|>|\binstanceof\b|\?/) >= 0) return true;
    // A predicate: `xs.contains(x)`, `s.startsWith(p)`, `is_valid(x)`, `o.hasNext()`.
    // A predicate call (`xs.contains(x)`, `is_valid(x)`, `o.hasNext()`) or attribute (`o.is_active`).
    // `is_valid`, `isValid`, and Python's own `isdir`, `isdigit`, `isinstance`.
    const predicate = /^(?:(is|has|can|should|was|will|needs|contains|exists|matches|startswith|endswith|callable)(?:_|[A-Z]|$)|is[a-z]{2,}$)/;
    const call = /(?:^|\.)([A-Za-z_]\w*)\((?:[^()]|\([^()]*\))*\)(?:\s*\/\*[^*]*\*\/)?$/.exec(text);
    if (call && (BOOLEAN_METHODS.has(call[1]) || predicate.test(call[1]))) return true;
    const attribute = /^[\w.]+\.([A-Za-z_]\w*)$/.exec(text);
    if (attribute && predicate.test(attribute[1])) return true;
    const type = /^[A-Za-z_]\w*$/.test(text) ? this.enclosingScope()?.types?.get(text) : undefined;
    return type !== undefined && /^(boolean|Boolean)\b/.test(type);
  }


  // ------------------------------------------------------------------ class

  private translateClass(i: number, name: string, basesText: string, comment: string, pep695TypeParams: string[] = []): void {
    const line = this.lines[i];
    const py = line.startLine;
    const decorators = this.takeDecorators();
    const bases = splitTopLevel(basesText).map((b) => b.trim()).filter((b) => b && !/^metaclass=/.test(b));
    const isEnum = bases.some((b) => ENUM_BASES.has(b.split('.').pop()!));
    const isRecord = bases.some((b) => RECORD_BASES.has(b.split('.').pop()!)) || decorators.some((d) => RECORD_DECORATORS.test(d.text));
    const isAbstract = bases.some((b) => /^(ABC|abc\.ABC)$/.test(b));
    const isInterface = bases.some((b) => /^(Protocol|typing\.Protocol)$/.test(b));
    const generics = [...pep695TypeParams, ...bases.map((b) => /^Generic\[(.+)\]$/.exec(b)?.[1]).filter(Boolean)];
    const realBases = bases.filter((b) => !/^(ABC|abc\.ABC|Protocol|typing\.Protocol|Generic\[.*\]|object)$/.test(b) && !ENUM_BASES.has(b.split('.').pop()!) && !RECORD_BASES.has(b.split('.').pop()!));

    const doc = this.docstringAfter(i);
    if (doc >= 0 && this.javadocMode !== 'none') this.skipIndex = doc;
    if (this.wantsJavadoc(doc >= 0)) {
      for (const l of this.classJavadoc(name, doc >= 0 ? this.lines[doc] : undefined, py)) this.emit(l.text, l.py);
    }
    for (const d of decorators) {
      // A record-style @dataclass is replaced by @Data below in Lombok style; don't double-annotate.
      if (this.input.lombokStyle && isRecord && RECORD_DECORATORS.test(d.text)) continue;
      this.emit(this.decoratorToAnnotation(d.text), d.py);
    }
    if (isRecord && this.input.lombokStyle) {
      this.emit('@Data', py);
    } else if (isRecord && !decorators.some((d) => RECORD_DECORATORS.test(d.text))) {
      this.emit(`/* ${bases.find((b) => RECORD_BASES.has(b.split('.').pop()!))}: value object with generated constructor/equals/hashCode */`, py);
    }

    // Field declarations for attributes assigned via self.x = ... anywhere in the class, and
    // (in Lombok style) the plan for which boilerplate we can collapse into annotations instead.
    const fields = !isEnum ? this.collectSelfFields(i, name) : [];
    // Field types resolved with the full environment beat the scan's first guess for later lookups.
    const scanned = this.scan.classes.get(name);
    if (scanned) for (const f of fields) if (f.type !== 'Object') scanned.fields.set(f.name, f.type);
    const lombokPlan = !isEnum && !isInterface ? this.buildLombokPlan(i, fields, isRecord) : undefined;
    for (const ann of lombokPlan?.annotations ?? []) this.emit(ann, py);

    let header: string;
    const typeParams = generics.length ? `<${generics.join(', ')}>` : '';
    if (isEnum) {
      header = `public enum ${name}${typeParams}`;
    } else if (isInterface) {
      header = `public interface ${name}${typeParams}`;
    } else {
      header = `public${isAbstract ? ' abstract' : ''} static class ${name}${typeParams}`;
    }
    // A class inside a function is a local class: no access modifier, never static.
    const scope = this.enclosingScope();
    if (scope && scope.kind !== 'class') header = header.replace(/^public\s+/, '').replace(/\bstatic\s+class\b/, 'class');
    if (realBases.length) {
      const [first, ...rest] = realBases.map((b) => translateType(mapExceptionName(b)));
      header += isInterface ? ` extends ${realBases.join(', ')}` : ` extends ${first}`;
      if (!isInterface && rest.length) header += ` /* also inherits: ${rest.join(', ')} */`;
    }
    this.emit(`${header} {${comment}`, py);
    this.usedNames.add(name);
    this.recordSymbol(name, 'class', py);

    // Lombok style: a backing field behind a trivial property is named after the property, so
    // @Getter/@Setter produce getPlaced()/setPlaced() rather than get_placed().
    const fieldRenames = new Map<string, string>();
    for (const [propName, plan] of lombokPlan?.properties ?? []) {
      if (plan.field !== propName && !fields.some((f) => f.name === propName)) fieldRenames.set(plan.field, propName);
    }
    const block: Block = { indent: line.indent, kind: 'class', className: name, isEnum, isRecord, isInterface, lombokPlan, fieldRenames, fields: new Set() };
    this.stack.push(block);

    if (!isEnum) {
      const declaredAtClassLevel = new Set(
        this.bodyLines(i)
          .filter((l) => l.indent === line.indent + this.indentUnit(i))
          .map((l) => /^(\w+)\s*(?::|=)/.exec(l.text)?.[1])
          .filter(Boolean),
      );
      const toEmit = fields.filter((f) => !declaredAtClassLevel.has(f.name));
      for (const f of toEmit) {
        const visibility = f.name.startsWith('_') ? 'private' : 'public';
        const fieldAnn = lombokPlan?.fieldAnnotations.get(f.name);
        if (fieldAnn) {
          const parts = [fieldAnn.getter ? '@Getter' : '', fieldAnn.setter ? '@Setter' : ''].filter(Boolean);
          this.emit(parts.join(' '), f.py);
        }
        const javaName = fieldRenames.get(f.name) ?? f.name;
        this.emit(`${visibility} ${f.type} ${javaName}; // assigned as self.${f.name} in ${f.where}`, f.py);
        this.recordSymbol(javaName, 'field', f.py);
      }
      if (toEmit.length) this.emit('', 0, 0);
    }
  }

  /**
   * Scans a class body up front (before any of its methods are emitted) to decide which
   * boilerplate can be collapsed into Lombok annotations when `input.lombokStyle` is on:
   * a pure `self.x = x` constructor -> `@AllArgsConstructor`, a trivial `__str__`/`__repr__`
   * -> `@ToString`, a trivial `__eq__`/`__hash__` -> `@EqualsAndHashCode`, and a `@property`/
   * `@x.setter` pair that just wraps a field -> `@Getter`/`@Setter` on that field. Returns
   * `undefined` when the option is off or nothing in the class qualifies.
   */
  private buildLombokPlan(i: number, fields: { name: string }[], isRecord: boolean): LombokPlan | undefined {
    if (!this.input.lombokStyle) return undefined;
    const header = this.lines[i];
    const methodIndent = header.indent + this.indentUnit(i);
    const fieldNames = new Set(fields.map((f) => f.name));

    interface DefInfo {
      index: number;
      name: string;
      params: string[];
      decorators: string[];
    }
    const defs: DefInfo[] = [];
    let pendingDecos: string[] = [];
    for (let j = i + 1; j < this.lines.length; j += 1) {
      const l = this.lines[j];
      if (l.kind !== 'code') continue;
      if (l.indent <= header.indent) break;
      if (l.indent !== methodIndent) continue;
      const code = this.splitComment(maskStrings(l.text).text).code;
      if (code.startsWith('@')) {
        pendingDecos.push(code);
        continue;
      }
      const d = /^(?:async\s+)?def\s+(\w+)\s*(?:\[[^\]]*\])?\s*\((.*)\)/.exec(code);
      if (d) {
        defs.push({ index: j, name: d[1], params: splitTopLevel(d[2]).map((p) => p.trim()).filter(Boolean), decorators: pendingDecos });
      }
      pendingDecos = [];
    }

    /** A single-statement body with no docstring: `return ...` or `self.x = ...`. */
    const isTrivial = (defIndex: number): boolean => {
      if (this.docstringAfter(defIndex) >= 0) return false;
      const body = this.bodyLines(defIndex);
      if (body.length !== 1) return false;
      const code = this.splitComment(maskStrings(body[0].text).text).code;
      return /^(return\b|self\.\w+\s*=)/.test(code);
    };

    const plan: LombokPlan = { suppressCtor: false, suppressToString: false, suppressEquals: false, suppressHash: false, annotations: [], properties: new Map(), fieldAnnotations: new Map() };

    // A dataclass-like class is already fully covered by @Data (emitted separately); a hand-written
    // __init__/__str__/__eq__/__hash__ on top of it is unusual and safer left spelled out.
    if (!isRecord) {
      const ctor = defs.find((d) => d.name === '__init__');
      if (ctor) {
        // `*` and `/` only separate keyword-only / positional-only parameters; they bind nothing.
        const ctorParams = ctor.params.filter((p) => p !== 'self' && p !== '*' && p !== '/');
        // Plain `name` or `name: Type` only: a default, `*args` or `**kwargs` has no @AllArgsConstructor equivalent.
        const simpleParams = ctorParams.every((p) => /^\w+(\s*:\s*[^=]+)?$/.test(p));
        const paramNames = ctorParams.map((p) => /^(\w+)/.exec(p)?.[1] ?? '');
        if (paramNames.length && simpleParams && paramNames.length === fields.length && this.docstringAfter(ctor.index) < 0) {
          const body = this.bodyLines(ctor.index);
          const isBoilerplate =
            body.length === paramNames.length &&
            body.every((l, idx) => new RegExp(`^self\\.${paramNames[idx]}\\s*=\\s*${paramNames[idx]}$`).test(this.splitComment(maskStrings(l.text).text).code));
          if (isBoilerplate) {
            plan.suppressCtor = true;
            plan.annotations.push('@AllArgsConstructor');
          }
        }
      }

      const strDef = defs.find((d) => d.name === '__str__') ?? defs.find((d) => d.name === '__repr__');
      if (strDef && isTrivial(strDef.index)) {
        plan.suppressToString = true;
        plan.annotations.push('@ToString');
      }

      const eqDef = defs.find((d) => d.name === '__eq__');
      const hashDef = defs.find((d) => d.name === '__hash__');
      if (eqDef && isTrivial(eqDef.index)) plan.suppressEquals = true;
      if (hashDef && isTrivial(hashDef.index)) plan.suppressHash = true;
      if (plan.suppressEquals || plan.suppressHash) plan.annotations.push('@EqualsAndHashCode');
    }

    for (const d of defs) {
      if (!d.decorators.some((deco) => /^@property\b/.test(deco)) || !isTrivial(d.index)) continue;
      const m = /^return\s+self\.(\w+)$/.exec(this.splitComment(maskStrings(this.bodyLines(d.index)[0].text).text).code);
      if (m && fieldNames.has(m[1])) plan.properties.set(d.name, { field: m[1], getter: true, setter: false });
    }
    for (const d of defs) {
      const prop = plan.properties.get(d.name);
      if (!prop || !d.decorators.some((deco) => new RegExp(`^@${d.name}\\.setter\\b`).test(deco)) || !isTrivial(d.index)) continue;
      const valueParam = /^(\w+)/.exec(d.params.filter((p) => p !== 'self')[0] ?? '')?.[1];
      if (!valueParam) continue;
      const code = this.splitComment(maskStrings(this.bodyLines(d.index)[0].text).text).code;
      if (new RegExp(`^self\\.${prop.field}\\s*=\\s*${valueParam}$`).test(code)) prop.setter = true;
    }
    for (const prop of plan.properties.values()) {
      const existing = plan.fieldAnnotations.get(prop.field) ?? { getter: false, setter: false };
      existing.getter = existing.getter || prop.getter;
      existing.setter = existing.setter || prop.setter;
      plan.fieldAnnotations.set(prop.field, existing);
    }

    return plan.annotations.length || plan.properties.size ? plan : undefined;
  }

  private indentUnit(i: number): number {
    const header = this.lines[i];
    for (let j = i + 1; j < this.lines.length; j += 1) {
      const l = this.lines[j];
      if (l.kind === 'code') return l.indent > header.indent ? l.indent - header.indent : 4;
    }
    return 4;
  }

  private collectSelfFields(i: number, className: string): FieldInfo[] {
    return collectSelfFields(this.lines, i, (masked, lits, soFar) => this.typeOf(masked, lits, { className, fields: soFar }));
  }

  // -------------------------------------------------------------------- def

  private translateDef(i: number, isAsync: boolean, name: string, paramsText: string, returnHint: string | undefined, comment: string, typeParams: string[] = []): void {
    const line = this.lines[i];
    const py = line.startLine;
    const decorators = this.takeDecorators();
    const cls = this.enclosingClass();
    const inClass = cls !== undefined && this.top() === cls;

    // Lombok style: this method is fully covered by a class-level annotation decided up front
    // in buildLombokPlan() (called from translateClass before any method is emitted) - skip it.
    if (inClass && cls!.lombokPlan) {
      const plan = cls!.lombokPlan;
      const suppressed =
        (name === '__init__' && plan.suppressCtor) ||
        ((name === '__str__' || name === '__repr__') && plan.suppressToString) ||
        (name === '__eq__' && plan.suppressEquals) ||
        (name === '__hash__' && plan.suppressHash);
      if (suppressed) {
        this.skipUntilIndentBelow(i);
        return;
      }
      const prop = plan.properties.get(name);
      if (prop) {
        const isGetterHere = decorators.some((d) => /^@property\b/.test(d.text));
        const isSetterHere = decorators.some((d) => new RegExp(`^@${name}\\.setter\\b`).test(d.text));
        if ((isGetterHere && prop.getter) || (isSetterHere && prop.setter)) {
          this.skipUntilIndentBelow(i);
          return;
        }
      }
    }

    const isStaticDecorated = decorators.some((d) => /^@(staticmethod|classmethod)\b/.test(d.text));
    const isClassMethod = decorators.some((d) => /^@classmethod\b/.test(d.text));
    const isAbstract = decorators.some((d) => /^@(abc\.)?abstractmethod\b/.test(d.text));
    const isProperty = decorators.some((d) => /^@(cached_)?property\b/.test(d.text));
    const isSetter = decorators.some((d) => /^@\w+\.setter\b/.test(d.text));
    const otherDecorators = decorators.filter((d) => !/^@(staticmethod|classmethod|(abc\.)?abstractmethod|(cached_)?property|\w+\.setter)\b/.test(d.text));

    const doc = this.docstringAfter(i);
    const docLine = doc >= 0 ? this.lines[doc] : undefined;
    if (doc >= 0 && this.javadocMode !== 'none') this.skipIndex = doc;

    // Which names the body may set to None: their primitive types are boxed (int -> Integer).
    const nullability = scanNullability(this.bodyLines(i), line.indent, this.inlineBody !== undefined ? splitTopLevel(this.inlineBody, ';') : []);

    // parameters
    const declared = new Set<string>();
    const types = new Map<string, string>();
    const params: string[] = [];
    const paramNames: string[] = [];
    const rawParams = splitTopLevel(paramsText).map((p) => p.trim()).filter(Boolean);
    rawParams.forEach((p, idx) => {
      if (p === '*' || p === '/') return;
      if (idx === 0 && inClass && !isStaticDecorated && /^(self|cls)\b/.test(p)) return;
      if (idx === 0 && isClassMethod && /^cls\b/.test(p)) return;
      let pm: RegExpExecArray | null;
      if ((pm = /^\*\*(\w+)/.exec(p))) {
        params.push(`Map<String, Object> ${pm[1]} /* **kwargs */`);
        declared.add(pm[1]);
        types.set(pm[1], 'Map<String, Object>');
        paramNames.push(pm[1]);
        return;
      }
      if ((pm = /^\*(\w+)(?::\s*(.+))?/.exec(p))) {
        const elem = pm[2] ? boxed(translateType(pm[2])) : 'Object';
        params.push(`${elem}... ${pm[1]}`);
        declared.add(pm[1]);
        types.set(pm[1], `${elem}[]`);
        paramNames.push(pm[1]);
        return;
      }
      const parsed = /^(\w+)\s*(?::\s*([^=]+?))?\s*(?:=\s*(.+))?$/.exec(p);
      if (!parsed) {
        params.push(this.expr(p));
        return;
      }
      const [, pname, hint, def] = parsed;
      declared.add(pname);
      let type = hint ? translateType(hint) : def ? typeFromDefault(def) : 'Object';
      // No hint and no telling default: what the body does with it (`p.split()` -> String).
      if (type === 'Object' && (def === undefined || def.trim() === 'None')) type = typeFromUsage(pname, this.ownBodyCode(i)) ?? 'Object';
      if (def !== undefined && def.trim() === 'None') type = nullableType(type);
      else type = boxIfNullable(type, nullability.names.has(pname));
      params.push(def !== undefined ? `${type} ${pname} /* = ${this.expr(def)} */` : `${type} ${pname}`);
      if (type !== 'Object') types.set(pname, type);
      paramNames.push(pname);
    });

    // Java varargs must come last: before `**kwargs` or keyword-only parameters, `*args` is an array.
    const varargs = params.findIndex((p) => /\.\.\. \w+$/.test(p));
    if (varargs >= 0 && varargs < params.length - 1) params[varargs] = params[varargs].replace(/\.\.\. (\w+)$/, '[] $1');

    // name, return type, modifiers
    let javaName = name;
    let ret = returnHint ? translateType(returnHint) : this.inferReturnType(i);
    const generator = this.bodyYields(i);
    let modifiers: string[] = [];
    let isCtor = false;

    if (inClass && name === '__init__') {
      isCtor = true;
      javaName = cls!.className!;
      ret = '';
      modifiers = ['public'];
    } else if (inClass && DUNDER_METHODS[name]) {
      const d = DUNDER_METHODS[name];
      javaName = d.name;
      if (!returnHint) ret = d.ret;
      modifiers = ['public'];
      if (name === '__eq__' && params.length === 1) params[0] = params[0].replace(/^Object/, 'Object');
    } else {
      const visibility = name.startsWith('__') ? 'private' : name.startsWith('_') ? 'protected' : 'public';
      modifiers = [visibility];
      if (!inClass || isStaticDecorated) modifiers.push('static');
      if (isAbstract) modifiers.push('abstract');
      if (cls?.isInterface) modifiers = [];
    }
    if (!isCtor) ret = boxIfNullable(ret, nullability.returnsNone);
    if (isAsync) ret = ret === 'void' ? 'CompletableFuture<Void> /* async */' : `CompletableFuture<${boxed(ret)}> /* async */`;

    if (this.wantsJavadoc(doc >= 0)) {
      const dunderDoc = inClass ? DUNDER_METHODS[name]?.doc : undefined;
      for (const l of this.methodJavadoc(name, docLine, isCtor, cls?.className, dunderDoc, paramNames, ret, py)) this.emit(l.text, l.py);
    }
    const enclosing = !inClass ? this.enclosingScope() : undefined;
    if (enclosing && enclosing.kind !== 'class') {
      // A function inside a function: Java has no nested methods, so it becomes a lambda.
      for (const d of decorators) this.emit(`// ${d.text}`, d.py);
      this.translateNestedDef(line, name, rawParams, ret, declared, types, nullability, enclosing, comment);
      this.top()!.hoists = planHoistedLocals(this.lines, i, declared);
      if (generator) this.startGenerator(i, ret, py);
      return;
    }
    for (const d of otherDecorators) this.emit(this.decoratorToAnnotation(d.text), d.py);
    if (isProperty) this.emit(`@Property // Python property: read as obj.${name}, rendered as obj.${name}()`, py);
    if (isSetter) this.emit(`@PropertySetter // Python setter: obj.${name} = value, rendered as obj.${name}(value)`, py);

    const generic = typeParams.length ? `<${typeParams.join(', ')}> ` : '';
    const signature = `${modifiers.join(' ')}${modifiers.length ? ' ' : ''}${generic}${isCtor ? '' : `${ret} `}${javaName}(${params.join(', ')})`;
    const body = isAbstract || cls?.isInterface ? ';' : ' {';
    this.emit(`${signature}${body}${comment}`, py);
    this.recordSymbol(javaName, 'method', py);

    if (body === ';') {
      // No block for abstract methods: consume the body (usually `...` or `pass`)
      const bodyLines = this.bodyLines(i);
      const trivial = bodyLines.every((l) => /^(pass|\.\.\.|raise NotImplementedError.*)$/.test(l.text.trim()) || isSingleLiteral(maskStrings(l.text).text));
      if (trivial) {
        this.skipUntilIndentBelow(i);
        return;
      }
      // Unusual: abstract method with a real body - reopen as a block.
      this.out[this.out.length - 1].text = this.out[this.out.length - 1].text.replace(/;(\s*\/\/.*)?$/, ' {$1');
    }
    this.stack.push({ indent: line.indent, kind: 'def', declared, types, nullability, hoists: planHoistedLocals(this.lines, i, declared) });
    if (generator && !isCtor) this.startGenerator(i, ret, py);
  }

  /**
   * A nested function as a lambda in a local variable, typed by its shape:
   *
   *   def key(o): return o.x       ->  Function<Object, Object> key = (o) -> { return o.x; };
   *   def log(msg): print(msg)     ->  Consumer<Object> log = (msg) -> { ... };
   *   def wrapper(*args, **kw):    ->  Function<Object[], Object> wrapper = (Object[] argv) -> {
   *                                        var args = Arrays.copyOfRange(argv, 0, argv.length); ...
   *
   * Calls to it in the enclosing function become `key.apply(o)`, `log.accept(msg)`, ...
   */
  private translateNestedDef(line: LogicalLine, name: string, rawParams: string[], ret: string, declared: Set<string>, types: Map<string, string>, nullability: NullabilityScan, enclosing: Block, comment: string): void {
    const py = line.startLine;
    // A def under a module-level `if`/`try` is a static field (see `moduleConditionalDefs`).
    const moduleLevel = enclosing.kind === 'static' ? this.moduleFunctions.get(name) : undefined;
    const { parsed, iface, method, arrayArgs } = moduleLevel ?? functionShape(rawParams, ret, types);
    if (moduleLevel) {
      this.assignInStaticBlock(enclosing, name, iface, undefined, py, '');
    } else {
      // Registered before the body, so the enclosing function (and recursive calls) call it right.
      enclosing.localFunctions ??= new Map();
      enclosing.localFunctions.set(name, { method, arrayArgs });
      this.declareLocal(name);
    }

    const argv = parsed.some((p) => p.name === 'argv') ? 'argv_' : 'argv';
    const lambdaParams = arrayArgs ? `(Object[] ${argv})` : `(${parsed.map((p) => p.name).join(', ')})`;
    const defaults = !arrayArgs && parsed.some((p) => p.def !== undefined) ? '; defaults are not applied, callers pass every argument' : '';
    this.emit(`${moduleLevel ? '' : `${iface} `}${name} = ${lambdaParams} -> { // ${moduleLevel ? 'defined conditionally' : 'nested function'}${defaults}${comment}`, py);
    this.recordSymbol(name, 'method', py);
    this.stack.push({ indent: line.indent, kind: 'def', declared, types, nullability, closer: '};' });
    if (!arrayArgs) return;
    // Unpack the argument array into the Python parameters.
    const star = parsed.findIndex((p) => p.star === '*');
    parsed.forEach((p, k) => {
      if (p.star === '**') this.emit(`Map<String, Object> ${p.name} = new HashMap<>(); // **${p.name}: Java has no keyword arguments`, py);
      else if (p.star === '*') this.emit(`var ${p.name} = Arrays.copyOfRange(${argv}, ${k}, ${argv}.length); // *${p.name}`, py);
      else if (star >= 0 && k > star) this.emit(`var ${p.name} = ${p.def !== undefined ? this.expr(p.def) : 'null'}; // keyword-only`, py);
      else this.emit(`var ${p.name} = ${p.def !== undefined ? `${argv}.length > ${k} ? ${argv}[${k}] : ${this.expr(p.def)}` : `${argv}[${k}]`};`, py);
    });
  }

  private skipRanges: Array<[number, number]> = [];

  private skipUntilIndentBelow(i: number): void {
    const header = this.lines[i];
    let end = i;
    for (let j = i + 1; j < this.lines.length; j += 1) {
      const l = this.lines[j];
      if (l.kind !== 'code') continue;
      if (l.indent <= header.indent) break;
      end = j;
    }
    this.skipRanges.push([i + 1, end]);
    // We cannot mutate the loop index from here; mark lines as blank instead.
    for (let j = i + 1; j <= end; j += 1) {
      if (this.lines[j].kind === 'code') this.lines[j] = { ...this.lines[j], kind: 'blank', text: '' };
    }
  }

  private inferReturnType(i: number): string {
    if (this.bodyYields(i)) return 'List<Object>';
    if (this.inlineBody !== undefined) {
      const inline = this.splitComment(maskStrings(this.inlineBody).text).code;
      return /^return\s+\S/.test(inline) ? 'Object' : 'void';
    }
    return this.ownBodyCode(i).some((code) => /^return\s+\S/.test(code)) ? 'Object' : 'void';
  }

  /** Masked code of the statements of the function at line `i`, without those of nested defs and classes. */
  private ownBodyCode(i: number): string[] {
    if (this.inlineBody !== undefined) return [this.splitComment(maskStrings(this.inlineBody).text).code];
    const codes: string[] = [];
    let nested = -1;
    for (const l of this.bodyLines(i)) {
      if (nested >= 0 && l.indent > nested) continue;
      nested = -1;
      if (/^(async\s+)?(def|class)\s/.test(l.text)) {
        nested = l.indent;
        continue;
      }
      codes.push(this.splitComment(maskStrings(l.text).text).code);
    }
    return codes;
  }

  /** Whether the function at line `i` is a generator (`yield` in its own body). */
  private bodyYields(i: number): boolean {
    return this.ownBodyCode(i).some((code) => /(?:^|[^\w.])yield\b/.test(code));
  }

  /**
   * Open a generator body: Java has no `yield` that suspends a method, so the generator
   * collects what it yields into a list and returns it (plan 1.16, eager by default):
   *
   *   def evens(xs):              List<Object> evens(Object xs) {
   *       for x in xs:                List<Object> yielded = new ArrayList<>(); // generator...
   *           if x % 2 == 0:          for (var x : xs) {
   *               yield x                 if (x % 2 == 0) { yielded.add(x); }
   *                                   }
   *                                   return yielded;
   */
  private startGenerator(i: number, ret: string, py: number): void {
    const block = this.top()!;
    const elem = /^(?:Iterator|Iterable|List|Collection)<(.+)>/.exec(ret)?.[1] ?? 'Object';
    const text = this.bodyLines(i).map((l) => l.text).join('\n') + (this.inlineBody ?? '');
    let name = 'yielded';
    for (let n = 2; new RegExp(`\\b${name}\\b`).test(text); n += 1) name = `yielded${n}`;
    block.yielded = name;
    block.yieldIterator = /^Iterator\b/.test(ret);
    block.declared?.add(name);
    // `while True:` with no way out but an exception: collecting it eagerly never ends.
    const own = this.ownBodyCode(i);
    const endless = own.some((code) => /^while\s+(True|1)\s*:/.test(code)) && !own.some((code) => /^(return|break)\b/.test(code));
    if (endless) this.warn('a generator that may never end is collected eagerly; it needs a lazy Iterator', py);
    this.emit(`List<${elem}> ${name} = new ArrayList<>(); // generator, collected eagerly${endless ? ' (may never end: needs a lazy Iterator)' : ''}`, py);
  }

  /** The generator function whose body is being translated, if the nearest function is one. */
  private generatorBlock(): Block | undefined {
    const fn = [...this.stack].reverse().find((b) => b.kind === 'def');
    return fn?.yielded ? fn : undefined;
  }

  /** `return yielded;` (or its iterator) for the generator `block`. */
  private generatorReturn(block: Block): string {
    return `return ${block.yielded}${block.yieldIterator ? '.iterator()' : ''};`;
  }

  // -------------------------------------------------------------------- for

  private translateFor(line: LogicalLine, target: string, maskedIterable: string, lits: string[], isAsync: boolean, comment: string): void {
    const py = line.startLine;
    // `for x in a, b, c:` walks a tuple.
    if (splitTopLevel(maskedIterable).length > 1) maskedIterable = `(${maskedIterable.trim()})`;
    const iterable = unmaskStrings(maskedIterable, lits);
    const asyncNote = isAsync ? ' /* async for */' : '';
    const targets = splitTopLevel(stripOuterParens(target)).map((t) => t.trim());
    const scope = this.enclosingScope();
    const declared = scope?.declared;
    const declaredBefore = new Set(targets.filter((t) => declared?.has(t)));
    // Element type from the iterable's type: List<Order> -> Order, Map<K, V>.items() -> K, V.
    const iterMasked = maskedIterable.trim();
    const view = /\.(items|values|keys)\(\)$/.exec(iterMasked)?.[1];
    const collType = this.typeOf(view ? iterMasked.replace(/\.(items|values|keys)\(\)$/, '') : iterMasked, lits);
    const mapTypes = mapTypesOf(collType);
    const elem = view === 'values' ? mapTypes?.[1] : view === 'keys' || (mapTypes && !view) ? mapTypes?.[0] : view ? undefined : elementTypeOf(collType);
    const typed = (name: string, type: string | undefined): string => {
      if (type) scope?.types?.set(name, type);
      return `${type ?? 'var'} ${name}`;
    };
    // The loop's block: what it declares goes out of scope (and out of `declared`) when it closes.
    const open = (header: string) => {
      this.emit(`${header} {${asyncNote}${comment}`, py);
      this.stack.push({ indent: line.indent, kind: 'for', blockLocals: [] });
    };
    // A loop variable already in scope (assigned before, or used after the loop and so declared
    // ahead) cannot be declared again: the loop walks a fresh variable and assigns it.
    const bind = (name: string, value: string, type: string | undefined) => this.bindLoopTarget(name, value, typed, type, lits, py, declaredBefore);
    let m: RegExpExecArray | null;

    if ((m = /^range\((.*)\)$/.exec(iterable.trim())) && targets.length === 1) {
      const args = splitTopLevel(m[1]).map((a) => this.expr(a));
      const target0 = targets[0] === UNDERSCORE_NAME ? this.unusedLoopName(line, scope) : targets[0];
      const reuse = declaredBefore.has(target0);
      const v = reuse ? this.freeLocalName(target0) : target0;
      let header: string;
      if (args.length === 1) header = `for (int ${v} = 0; ${v} < ${args[0]}; ${v}++)`;
      else if (args.length === 2) header = `for (int ${v} = ${args[0]}; ${v} < ${args[1]}; ${v}++)`;
      else {
        const step = args[2];
        const down = step.startsWith('-');
        header = `for (int ${v} = ${args[0]}; ${v} ${down ? '>' : '<'} ${args[1]}; ${v} ${down ? '-=' : '+='} ${down ? step.slice(1) : step})`;
      }
      open(header);
      if (reuse) this.emit(`${target0} = ${v};`, py);
      else {
        scope?.types?.set(v, 'int');
        this.declareLocal(v);
      }
      return;
    }
    if ((m = /^enumerate\((.*)\)$/.exec(iterable.trim())) && targets.length === 2) {
      const args = splitTopLevel(m[1]);
      const coll = this.expr(args[0]);
      const start = args[1] ? this.expr(args[1].replace(/^start\s*=\s*/, '')) : '0';
      const [idx, item] = targets;
      const simple = /^[\w.]+$/.test(coll);
      if (simple) {
        const itemType = elementTypeOf(this.typeOf(args[0].trim(), lits));
        const reuse = declaredBefore.has(idx);
        const i = reuse ? this.freeLocalName(idx) : idx;
        open(`for (int ${i} = ${start}; ${i} < ${coll}.size()${start !== '0' ? ` + ${start}` : ''}; ${i}++)`);
        if (reuse) this.emit(`${idx} = ${i};`, py);
        else {
          scope?.types?.set(idx, 'int');
          this.declareLocal(idx);
        }
        bind(item, `${coll}.get(${i}${start !== '0' ? ` - ${start}` : ''})`, itemType);
        return;
      }
    }
    if (/\.items\(\)$/.test(iterable.trim()) && targets.length === 2) {
      const mapExpr = this.expr(iterable.trim().replace(/\.items\(\)$/, ''));
      const [k, v] = targets;
      const entry = this.freeLocalName('entry');
      open(`for (var ${entry} : ${mapExpr}.entrySet())`);
      bind(k, `${entry}.getKey()`, mapTypes?.[0]);
      bind(v, `${entry}.getValue()`, mapTypes?.[1]);
      return;
    }
    if ((m = /^zip\((.*)\)$/.exec(iterable.trim())) && targets.length >= 2) {
      const colls = splitTopLevel(m[1]).map((a) => this.expr(a));
      if (colls.every((c) => /^[\w.]+$/.test(c)) && colls.length === targets.length) {
        const i = this.freeLocalName('i');
        this.emit(`for (int ${i} = 0; ${i} < ${colls[0]}.size(); ${i}++) { // zip${asyncNote}${comment}`, py);
        this.stack.push({ indent: line.indent, kind: 'for', blockLocals: [] });
        targets.forEach((t, k) => bind(t, `${colls[k]}.get(${i})`, undefined));
        return;
      }
    }
    // Iterating a Map in Python walks its keys.
    // A tuple literal walked by a loop is a plain collection: `for x in (a, b)` -> List.of(a, b).
    let iter = this.expr(iterable).replace(/^Tuple\.of\(/, 'List.of(') + (mapTypes && !view ? '.keySet()' : '');
    // A string walks its characters.
    if (/^String\b/.test(this.nameType(iterable.trim()) ?? '')) iter = `Py.chars(${iter})`;
    if (targets.length === 1) {
      if (declaredBefore.has(targets[0])) {
        const item = this.freeLocalName('item');
        open(`for (var ${item} : ${iter})`);
        this.emit(`${targets[0]} = ${item};`, py);
      } else {
        open(`for (${typed(targets[0], elem)} : ${iter})`);
        this.declareLocal(targets[0]);
      }
      return;
    }
    const unpack = unpackTargets(target);
    if (!unpack) {
      open(`for (var (${targets.join(', ')}) : ${iter})`);
      return;
    }
    // `for a, b in pairs:` walks the tuples and unpacks each one at the top of the body.
    const item = this.freeLocalName('item');
    this.emit(`for (var ${item} : ${iter}) { // tuple unpacking${asyncNote}${comment}`, py);
    this.stack.push({ indent: line.indent, kind: 'for', blockLocals: [] });
    for (const l of this.unpackingLines(unpack, item, lits)) this.emit(l, py);
  }

  /** `name = value;` at the top of a loop body; a nested target (`(a, b)`) is unpacked from it. */
  private bindLoopTarget(name: string, value: string, typed: (n: string, t: string | undefined) => string, type: string | undefined, lits: string[], py: number, declaredBefore: Set<string>): void {
    const nested = /^[(\[]/.test(name) ? unpackTargets(name) : undefined;
    if (nested) for (const l of this.unpackingLines(nested, value, lits)) this.emit(l, py);
    else if (declaredBefore.has(name)) this.emit(`${name} = ${value};`, py);
    else {
      this.emit(`${typed(name, type)} = ${value};`, py);
      this.declareLocal(name);
    }
  }

  /**
   * Record a local the statement being emitted declares: it is in scope (in `declared`) until
   * the innermost open block closes, as a Java local is. Locals of the function body itself
   * last until the function ends.
   */
  private declareLocal(name: string): void {
    const scope = this.enclosingScope();
    if (!scope?.declared) return;
    scope.declared.add(name);
    const block = this.top();
    if (block && block !== scope && block.kind !== 'class' && block.kind !== 'static') (block.blockLocals ??= []).push(name);
  }

  /**
   * A counter name for `for _ in range(n)` (`_` is renamed `unused`): `i`, `j`, `k`, ... when
   * neither the loop body nor the enclosing scope uses it, so it cannot shadow a Java local.
   * Keeps `unused` when the body does read `_`.
   */
  private unusedLoopName(line: LogicalLine, scope: Block | undefined): string {
    const at = this.lines.indexOf(line);
    const words = new Set<string>();
    for (const l of at >= 0 ? this.bodyLines(at) : []) {
      // A nested `for _ in ...` binds `_` again; that is not a read of this loop's `_`.
      const code = maskStrings(l.text).text.replace(new RegExp(`^for\\s+${UNDERSCORE_NAME}\\s+in\\b`), 'for in');
      for (const w of code.match(/\w+/g) ?? []) words.add(w);
    }
    if (words.has(UNDERSCORE_NAME)) return UNDERSCORE_NAME;
    const taken = (n: string) => words.has(n) || scope?.declared?.has(n) || scope?.types?.has(n);
    return ['i', 'j', 'k', 'n', 'm'].find((n) => !taken(n)) ?? UNDERSCORE_NAME;
  }

  // ------------------------------------------------------------------- with

  private translateWith(line: LogicalLine, itemsText: string, lits: string[], isAsync: boolean, comment: string): void {
    const py = line.startLine;
    const items = splitTopLevel(stripOuterParens(itemsText));
    const asyncNote = isAsync ? ' /* async with */' : '';
    const resources: string[] = [];
    const bound: string[] = [];
    let counter = 0;
    let allBare = true;
    for (const item of items) {
      const m = /^(.+?)\s+as\s+(\w+)$/.exec(item.trim());
      if (m) {
        allBare = false;
        bound.push(m[2]);
        resources.push(`var ${m[2]} = ${unmaskStrings(translateMaskedExpression(m[1], this.exprCtx(lits)), lits)}`);
      } else {
        const ctx = unmaskStrings(translateMaskedExpression(item.trim(), this.exprCtx(lits)), lits);
        if (/^[\w.]+$/.test(ctx) && /lock|mutex|semaphore/i.test(ctx)) {
          resources.push(`synchronized:${ctx}`);
        } else {
          counter += 1;
          resources.push(`var ctx${counter > 1 ? counter : ''} = ${ctx}`);
        }
      }
    }
    if (resources.length === 1 && resources[0].startsWith('synchronized:')) {
      this.emit(`synchronized (${resources[0].slice('synchronized:'.length)}) { // with${asyncNote}${comment}`, py);
    } else {
      const res = resources.map((r) => (r.startsWith('synchronized:') ? `var lock = ${r.slice('synchronized:'.length)}` : r));
      this.emit(`try (${res.join('; ')}) { // with${allBare ? ': context manager' : ''}${asyncNote}${comment}`, py);
    }
    this.stack.push({ indent: line.indent, kind: 'with' });
    // A resource lives in the try block.
    for (const name of bound) this.declareLocal(name);
  }

  // -------------------------------------------------------- simple statements

  private translateSimple(code: string, lits: string[], py: number, comment: string): void {
    const un = (s: string) => unmaskStrings(s, lits);
    const ex = (s: string) => un(translateMaskedExpression(s, this.exprCtx(lits)));
    const exValue = (s: string) => un(translateMaskedExpression(s, this.exprCtx(lits, true)));
    let m: RegExpExecArray | null;

    // `if not re: import re`: the import joins the import block; a comment keeps its place.
    if (this.translateImport(code, py)) return this.emit(`// ${un(code)} (see the imports)${comment}`, py);
    if (code === 'pass') return this.emit(`// pass${comment}`, py);
    if (code === '...') return this.emit(`// ...${comment}`, py);
    if (code === 'break') {
      const loop = [...this.stack].reverse().find((b) => b.kind === 'for' || b.kind === 'while' || b.kind === 'def' || b.kind === 'main');
      if (loop?.loopFlag) this.emit(`${loop.loopFlag} = true;`, py);
      return this.emit(`break;${comment}`, py);
    }
    if (code === 'continue') return this.emit(`continue;${comment}`, py);
    const generator = this.generatorBlock();
    if (code === 'return') return this.emit(`${generator ? this.generatorReturn(generator) : 'return;'}${comment}`, py);
    if (generator && (m = /^return\s+(.+)$/.exec(code))) {
      // A generator's return value only reaches `yield from` callers (StopIteration.value).
      return this.emit(`${this.generatorReturn(generator)} // return value: ${un(m[1]).replace(/\*\//g, '*&#47;')}${comment}`, py);
    }
    if ((m = /^return\s+(.+)$/.exec(code))) {
      const parts = splitTopLevel(m[1]);
      const value = parts.length > 1 ? `Tuple.of(${parts.map(exValue).join(', ')})` : exValue(m[1]);
      return this.emit(`return ${value};${comment}`, py);
    }
    if (code === 'raise') {
      const catchVar = [...this.stack].reverse().find((b) => b.catchVar)?.catchVar ?? 'e';
      return this.emit(`throw ${catchVar}; // re-raise${comment}`, py);
    }
    if ((m = /^raise\s+(.+?)(?:\s+from\s+(\w+))?$/.exec(code))) {
      let target = m[1];
      const cause = m[2] ? ` // caused by ${m[2]}` : '';
      if (/^[\w.]+$/.test(target)) target = `${target}()`;
      const translated = ex(target);
      const needsNew = !translated.startsWith('new ') && /^[A-Z]\w*(\.[A-Z]\w*)*\(/.test(translated.trim());
      return this.emit(`throw ${needsNew ? 'new ' : ''}${translated};${cause}${comment}`, py);
    }
    if ((m = /^assert\s+(.+)$/.exec(code))) {
      const parts = splitTopLevel(m[1]);
      return this.emit(`assert ${ex(parts[0])}${parts[1] ? ` : ${ex(parts[1])}` : ''};${comment}`, py);
    }
    if ((m = /^del\s+(.+)$/.exec(code))) {
      const target = m[1].trim();
      const sub = subscriptTarget(target);
      const slice = sub && this.sliceStatement(sub[0], sub[1], undefined, ex);
      if (slice) return this.emit(`${slice}${comment}`, py);
      if (sub) return this.emit(`${ex(sub[0])}.remove(${ex(sub[1])});${comment}`, py);
      return this.emit(`${ex(target)} = null; // del${comment}`, py);
    }
    if ((m = /^(global|nonlocal)\s+(.+)$/.exec(code))) return this.emit(`// ${m[1]} ${m[2]}${comment}`, py);
    if (generator && (m = /^yield\s+from\s+(.+)$/.exec(code))) {
      const source = exValue(m[1]);
      const list = /\.stream\(\)|^IntStream\.|\.boxed\(\)$/.test(source) && !/\.toList\(\)$/.test(source) ? `${source}.toList()` : source;
      return this.emit(`${generator.yielded}.addAll(${list});${comment}`, py);
    }
    if (generator && (m = /^yield(?:\s+(.*))?$/.exec(code))) {
      const parts = m[1] ? splitTopLevel(m[1]) : [];
      const value = parts.length > 1 ? `Tuple.of(${parts.map(exValue).join(', ')})` : m[1] ? exValue(m[1]) : 'null';
      return this.emit(`${generator.yielded}.add(${value});${comment}`, py);
    }
    if ((m = /^yield\s+from\s+(.+)$/.exec(code))) return this.emit(`for (var item : ${ex(m[1])}) { yield item; } // yield from: delegate to a sub-generator${comment}`, py);
    if ((m = /^yield(?:\s+(.*))?$/.exec(code))) return this.emit(`yield ${m[1] ? ex(m[1]) : 'null'}; // generator${comment}`, py);
    if (isSingleLiteral(code)) {
      // Stray string expression (e.g. a docstring not directly under a header): keep as comment.
      const text = un(code).replace(/^"""\n?/, '').replace(/"""$/, '').replace(/^"|"$/g, '').replace(/\*\//g, '*&#47;');
      const lines = text.split('\n');
      if (lines.length === 1) return this.emit(`/* ${lines[0]} */`, py);
      this.emit('/*', py);
      lines.forEach((l) => this.emit(` * ${l.trim()}`, py));
      return this.emit(' */', py);
    }

    // augmented assignment
    if ((m = /^(.+?)\s*(\+|-|\*|\/|%|\*\*|\/\/|&|\||\^|<<|>>)=\s*(.+)$/.exec(code)) && indexAtDepth0(code, /=/) > 0) {
      const target = m[1].trim();
      const op = m[2];
      const value = ex(m[3]);
      const sub = subscriptTarget(target);
      if (sub) {
        const recv = ex(sub[0]);
        const key = ex(sub[1]);
        return this.emit(`${recv}.put(${key}, ${recv}.get(${key}) ${op} ${value});${comment}`, py);
      }
      const attr = /^(.+)\.(\w+)$/.exec(target);
      const setter = attr ? this.propertySetter(attr[2]) : undefined;
      if (attr && setter) {
        const recv = ex(attr[1]);
        return this.emit(`${recv}.${setter}(${recv}.${this.propertyGetter(attr[2])} ${op} ${value});${comment}`, py);
      }
      const t = ex(target);
      if (/^\w+$/.test(target) && this.enclosingScope()?.kind === 'static') this.makeFieldMutable(target);
      if (op === '**') return this.emit(`${t} = Math.pow(${t}, ${value});${comment}`, py);
      if (op === '//') return this.emit(`${t} = Math.floorDiv(${t}, ${value});${comment}`, py);
      return this.emit(`${t} ${op}= ${value};${comment}`, py);
    }

    // assignment (possibly annotated / chained / tuple)
    const eq = this.assignmentIndex(code);
    if (eq > 0) {
      return this.translateAssignment(code, eq, lits, py, comment);
    }
    // bare annotation:  x: int
    if ((m = /^(\w+)\s*:\s*(.+)$/.exec(code)) && !/^(lambda|if|else)\b/.test(code)) {
      return this.emitFieldOrLocal(m[1], translateType(un(m[2])), undefined, py, comment);
    }

    // expression statement
    this.emit(`${ex(code)};${comment}`, py);
  }

  /** Index of the first top-level assignment `=` (not ==, !=, <=, >=, :=, keyword args). */
  private assignmentIndex(code: string): number {
    let depth = 0;
    for (let i = 0; i < code.length; i += 1) {
      const ch = code[i];
      if (ch === '(' || ch === '[' || ch === '{') depth += 1;
      else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
      else if (ch === '=' && depth === 0) {
        const prev = code[i - 1];
        const next = code[i + 1];
        if (next === '=' || prev === '=' || prev === '!' || prev === '<' || prev === '>' || prev === ':') {
          if (next === '=') i += 1;
          continue;
        }
        return i;
      }
    }
    return -1;
  }

  private translateAssignment(code: string, eq: number, lits: string[], py: number, comment: string): void {
    const un = (s: string) => unmaskStrings(s, lits);
    const ex = (s: string) => un(translateMaskedExpression(s, this.exprCtx(lits)));
    const exValue = (s: string) => un(translateMaskedExpression(s, this.exprCtx(lits, true)));

    // chained: a = b = value  -> assign right-to-left
    const segments: string[] = [];
    let rest = code;
    let idx = eq;
    while (idx > 0) {
      segments.push(rest.slice(0, idx).trim());
      rest = rest.slice(idx + 1).trim();
      idx = this.assignmentIndex(rest);
    }
    const valueMasked = rest;
    if (/^TypeVar\(/.test(valueMasked.trim()) && segments.length === 1) {
      return this.emit(`// type variable ${segments[0]} = ${un(valueMasked)}${comment}`, py);
    }
    // `x = a, b` builds a tuple, like `x = (a, b)`.
    const bareTuple = !/^lambda\b/.test(valueMasked.trim()) && splitTopLevel(valueMasked).length > 1;
    let valueJava = bareTuple ? `Tuple.of(${splitTopLevel(valueMasked).map(exValue).join(', ')})` : exValue(valueMasked);
    let valueMaskedForType = bareTuple ? `(${valueMasked})` : valueMasked;

    let m: RegExpExecArray | null;
    for (let s = segments.length - 1; s >= 0; s -= 1) {
      const target = segments[s];
      // annotated: name: Type
      const ann = /^(\w+)\s*:\s*(.+)$/.exec(target);
      if (ann) {
        let rhsJava = valueJava;
        const fieldDefault = /^field\((.*)\)$/.exec(valueMasked.trim());
        if (fieldDefault) rhsJava = this.dataclassFieldDefault(fieldDefault[1], lits);
        this.emitFieldOrLocal(ann[1], translateType(un(ann[2])), rhsJava, py, comment);
      } else if (/^self\.\w+$/.test(target)) {
        const field = target.slice(5);
        const setter = this.propertySetter(field);
        const renamed = this.nearestClass()?.fieldRenames?.get(field) ?? field;
        this.emit(setter ? `this.${setter}(${valueJava});${comment}` : `this.${renamed} = ${valueJava};${comment}`, py);
      } else if ((m = /^self\.(\w+)\s*:\s*(.+)$/.exec(target))) {
        // self.x: T = value - the type is already declared in the field list.
        const renamed = this.nearestClass()?.fieldRenames?.get(m[1]) ?? m[1];
        this.emit(`this.${renamed} = ${valueJava}; // ${translateType(un(m[2]))}${comment}`, py);
      } else if (/^\w+$/.test(target)) {
        this.emitFieldOrLocal(target, this.inferValueType(valueMaskedForType, lits), valueJava, py, comment);
      } else if (unpackTargets(target)) {
        this.emitUnpacking(unpackTargets(target)!, valueMasked, lits, py, comment);
      } else {
        const sub = subscriptTarget(target);
        const attr = /^(.+)\.(\w+)$/.exec(target);
        const setter = attr ? this.propertySetter(attr[2]) : undefined;
        const slice = sub && this.sliceStatement(sub[0], sub[1], valueJava, ex);
        if (slice) {
          this.emit(`${slice}${comment}`, py);
        } else if (sub) {
          this.emit(`${ex(sub[0])}.put(${ex(sub[1])}, ${valueJava});${comment}`, py);
        } else if (attr && setter) {
          this.emit(`${ex(attr[1])}.${setter}(${valueJava});${comment}`, py);
        } else {
          this.emit(`${ex(target)} = ${valueJava};${comment}`, py);
        }
      }
      comment = '';
      // For chained assignments the next target receives the previous one.
      valueJava = /^\w+$/.test(target) ? target : valueJava;
      valueMaskedForType = target;
    }
  }

  private dataclassFieldDefault(argsText: string, lits: string[]): string {
    const args = splitTopLevel(argsText);
    for (const a of args) {
      const m = /^(default_factory|default)\s*=\s*(.+)$/.exec(a.trim());
      if (!m) continue;
      const v = m[2].trim();
      if (m[1] === 'default') return unmaskStrings(translateMaskedExpression(v, this.exprCtx(lits)), lits);
      const factories: Record<string, string> = { list: 'new ArrayList<>()', dict: 'new HashMap<>()', set: 'new HashSet<>()' };
      return factories[v] ?? `${unmaskStrings(translateMaskedExpression(v, this.exprCtx(lits)), lits)}() /* default_factory */`;
    }
    return `null /* field(${unmaskStrings(argsText, lits)}) */`;
  }

  /** Names of the module class's static fields declared so far. */
  private moduleFields = new Set<string>();

  /**
   * Java has no statements in a class body: module- and class-level code that is not a
   * declaration (a call, `del`, `obj.attr = ...`, `if`/`for`/`try`, reassigning a field) goes
   * into a `static { }` block. Consecutive statements share one block; a declaration closes it,
   * so everything still runs in the Python order (Java runs static initializers top to bottom).
   * Enums (constants come first) and interfaces (no static blocks) keep their statements as is.
   */
  private placeInStaticBlock(code: string, py: number): void {
    const top = this.top();
    const level = top?.kind === 'static' ? this.stack[this.stack.length - 2] : top;
    if (level !== undefined && level.kind !== 'class') return; // inside a function or a block
    if (level?.isEnum || level?.isInterface) return;
    const executable = this.isStatementAtBodyLevel(code, level);
    if (executable && top?.kind !== 'static') {
      this.emit('static {', py);
      this.stack.push({ indent: level ? level.indent + 1 : -1, kind: 'static', declared: new Set(), types: new Map(), startOut: this.out.length - 1 });
    } else if (!executable && top?.kind === 'static') {
      this.stack.pop();
      // A blank line before the next declaration belongs after the block, not inside it.
      const blank = this.out[this.out.length - 1]?.text === '';
      if (blank) this.out.pop();
      this.emit('}', 0);
      if (blank) this.emit('', 0, 0);
    }
  }

  /** Whether a module/class-level statement must run in a static block (it is not a declaration). */
  private isStatementAtBodyLevel(code: string, level: Block | undefined): boolean {
    if (code.startsWith('@') || /^(?:class|def|async\s+def)\s/.test(code) || /^(?:import|from)\s/.test(code)) return false;
    if (/^if\s+__name__\s*==/.test(code) || code === 'pass' || code === '...' || isSingleLiteral(code)) return false;
    const keyword = /^(?:if|elif|else|for|while|with|try|except|finally|match|case|lambda|return|async|assert|del|raise|global|nonlocal|yield|await)\b/;
    if (keyword.test(code)) return true;
    const fields = level?.fields ?? this.moduleFields;
    const eq = this.assignmentIndex(code);
    if (eq < 0) return !/^\w+\s*:\s*[^=]+$/.test(code); // a bare annotation `x: int` declares a field
    // `x = ...`, `x: T = ...`, `a = b = ...`, `a, b = ...`: a declaration, unless a target is not a
    // plain name (`obj.attr = ...`, `d[k] = ...`) or the field exists already (a reassignment).
    const names: string[] = [];
    let rest = code;
    for (let idx = eq; idx > 0; idx = this.assignmentIndex(rest)) {
      const target = rest.slice(0, idx).trim();
      rest = rest.slice(idx + 1).trim();
      const single = /^(\w+)\s*(?::\s*.+)?$/.exec(target);
      const many = single ? undefined : unpackTargets(target);
      if (single) names.push(single[1]);
      else if (many && many.every((t) => /^\*?\w+$/.test(t))) names.push(...many.map((t) => t.replace(/^\*/, '')));
      else return true;
    }
    return names.some((n) => fields.has(n));
  }

  /**
   * `name = value` inside a static block: module and class variables are fields, so a name the
   * block assigns first is declared as a field just before the block (not final: Python may
   * assign it again, e.g. in both `try` and `except`), then assigned here.
   */
  private assignInStaticBlock(scope: Block, name: string, type: string, valueJava: string | undefined, py: number, comment: string): void {
    const level = this.stack[this.stack.indexOf(scope) - 1];
    const fields = level?.kind === 'class' ? level.fields! : this.moduleFields;
    if (!fields.has(name) && !scope.declared?.has(name)) {
      const t = type === 'var' || /^Object\b/.test(type) ? 'Object' : type;
      const at = scope.startOut!;
      const indentation = /^\s*/.exec(this.out[at].text)![0];
      this.out.splice(at, 0, { text: `${indentation}${level?.kind === 'class' ? 'public static' : 'static'} ${t} ${name};`, py });
      for (const sym of this.symbols) if (sym.javaLineRaw >= at) sym.javaLineRaw += 1;
      this.symbols.push({ name, kind: 'field', container: this.classChain(), javaLineRaw: at, py });
      scope.startOut = at + 1;
      fields.add(name);
      if (level?.kind !== 'class' && t !== 'Object') this.scan.moduleTypes.set(name, t);
    }
    else this.makeFieldMutable(name);
    if (valueJava !== undefined) this.emit(`${name} = ${valueJava};${comment}`, py);
  }

  /** Drop `final` from a field the code assigns again (`COUNT = 0` ... `COUNT += 1`). */
  private makeFieldMutable(name: string): void {
    const container = this.classChain();
    const sym = [...this.symbols].reverse().find((s) => s.kind === 'field' && s.name === name && s.container.join('.') === container.join('.'));
    if (sym && this.out[sym.javaLineRaw]) this.out[sym.javaLineRaw].text = this.out[sym.javaLineRaw].text.replace(/\bstatic final\b/, 'static');
  }

  /**
   * The continuation clauses (`except`, `else`, `finally`) that follow the body of the compound
   * statement whose header is at `i`, at the header's indent.
   */
  private clausesAfter(i: number): Set<string> {
    const header = this.lines[i];
    const clauses = new Set<string>();
    for (let j = i + 1; j < this.lines.length; j += 1) {
      const l = this.lines[j];
      if (l.kind !== 'code' || l.indent > header.indent) continue;
      if (l.indent < header.indent) break;
      const clause = /^(except|else|finally|elif)\b/.exec(l.text);
      if (!clause) break;
      clauses.add(clause[1]);
    }
    return clauses;
  }

  /** For a loop header at `i` with an `else:` clause: declare its `broke` flag and return the name. */
  private loopElseFlag(i: number, py: number): string | undefined {
    if (!this.clausesAfter(i).has('else')) return undefined;
    const flag = this.freeLocalName('broke');
    this.emit(`boolean ${flag} = false;`, py);
    return flag;
  }

  /** `base`, or `base2`, `base3`, ... : a local name nothing in this function scope uses yet (then marked used). */
  private freeLocalName(base: string): string {
    const declared = this.enclosingScope()?.declared;
    let name = base;
    for (let n = 2; declared?.has(name) || this.scan.moduleTypes.has(name); n += 1) name = `${base}${n}`;
    this.declareLocal(name);
    return name;
  }

  /**
   * Java statements that unpack the tuple or list `source` (a Java expression) into `targets`:
   * `var a = pair.get(0);`, `rest = xs.subList(1, xs.size());`, `this.x = t.get(2);`.
   * `_` targets (renamed `unused`) are skipped; names already declared get a plain assignment.
   */
  private unpackingLines(targets: string[], source: string, lits: string[]): string[] {
    const ex = (s: string) => unmaskStrings(translateMaskedExpression(s, this.exprCtx(lits)), lits);
    const star = targets.findIndex((t) => t.startsWith('*'));
    const n = targets.length;
    const out: string[] = [];
    targets.forEach((raw, k) => {
      const target = raw.replace(/^\*/, '');
      if (target === UNDERSCORE_NAME) return;
      const nested = nestedTargets(target);
      const value =
        k === star
          ? `${source}.subList(${k}, ${source}.size()${n - k - 1 > 0 ? ` - ${n - k - 1}` : ''})`
          : star >= 0 && k > star
            ? `${source}.get(${source}.size() - ${n - k})`
            : `${source}.get(${k})`;
      if (nested) {
        // `name, (f, t) = x`: the inner tuple gets a name of its own, then is unpacked in turn.
        const inner = this.freeLocalName('inner');
        out.push(`var ${inner} = ${value};`, ...this.unpackingLines(nested, inner, lits));
        return;
      }
      out.push(this.assignmentLine(target, value, ex));
    });
    return out;
  }

  /**
   * `del xs[a:b]` (no `value`) or `xs[a:b] = value` as Java statements on one line, or undefined
   * when `key` is not a slice (or has a step, or the receiver is not a plain name):
   *
   *   del xs[a:b]   -> xs.subList(a, b).clear();
   *   xs[a:b] = ys  -> xs.subList(a, b).clear(); xs.addAll(a, ys);
   *   xs[:] = ys    -> xs.clear(); xs.addAll(ys);
   *   xs[-2:] = ys  -> xs.subList(xs.size() - 2, xs.size()).clear(); xs.addAll(ys);
   *
   * A value that reads `xs` is copied first, since clearing would change it.
   */
  private sliceStatement(recvMasked: string, keyMasked: string, value: string | undefined, ex: (s: string) => string): string | undefined {
    if (indexAtDepth0(keyMasked, /:/) < 0) return undefined;
    const parts = splitTopLevel(keyMasked, ':').concat(['', '', '']).map((p) => p.trim());
    if (parts[2] !== '') return undefined;
    const recv = ex(recvMasked);
    if (!/^[\w.]+$/.test(recv)) return undefined;
    const lo = parts[0] === '' ? '' : ex(parts[0]);
    const hi = parts[1] === '' ? '' : ex(parts[1]);
    const whole = lo === '' && hi === '';
    const range = whole ? recv : `${recv}.subList(${sliceBound(recv, lo, '0')}, ${sliceBound(recv, hi, `${recv}.size()`)})`;
    const clear = `${range}.clear();`;
    if (value === undefined || value === 'new ArrayList<>()') return clear;
    let items = value;
    let prefix = '';
    if (new RegExp(`(?<![\\w.])${recv.replace(/\./g, '\\.')}(?![\\w])`).test(value)) {
      items = this.freeLocalName('items');
      prefix = `var ${items} = new ArrayList<>(${value}); `;
    }
    // Insert where the cleared range began; a range that ran to the end is refilled at the end.
    let at = sliceBound(recv, lo, '0');
    if (hi === '' && lo !== '') at = '';
    else if (/\.size\(\)/.test(at)) {
      const name = this.freeLocalName('at');
      prefix += `int ${name} = ${at}; `;
      at = name;
    }
    return `${prefix}${clear} ${recv}.addAll(${at && at !== '0' || (at === '0' && !whole) ? `${at}, ` : ''}${items});`;
  }

  /** `target = value;` for one unpacking target: declares a new local, or assigns a field / item. */
  private assignmentLine(target: string, value: string, ex: (s: string) => string): string {
    const sub = subscriptTarget(target);
    const slice = sub && this.sliceStatement(sub[0], sub[1], value, ex);
    if (slice) return slice;
    if (sub) return `${ex(sub[0])}.put(${ex(sub[1])}, ${value});`;
    if (!/^\w+$/.test(target)) {
      const attr = /^(.+)\.(\w+)$/.exec(target);
      const setter = attr ? this.propertySetter(attr[2]) : undefined;
      return attr && setter ? `${ex(attr[1])}.${setter}(${value});` : `${ex(target)} = ${value};`;
    }
    if (this.enclosingScope()?.declared?.has(target)) return `${target} = ${value};`;
    this.declareLocal(target);
    return `var ${target} = ${value};`;
  }

  /**
   * `a, b = value` (also `(a, b) = ...`, `[a, b] = ...`, `first, *rest = ...`). Java has no
   * destructuring, so this becomes one statement per name. A literal tuple of the same length
   * that does not read any of the targets is assigned element by element; a plain name is read
   * directly; anything else (a call, or a swap `a, b = b, a`) goes through a temporary first.
   */
  private emitUnpacking(targets: string[], valueMasked: string, lits: string[], py: number, comment: string): void {
    const exValue = (s: string) => unmaskStrings(translateMaskedExpression(s, this.exprCtx(lits, true)), lits);
    const scope = this.enclosingScope();
    const inFunction = scope !== undefined && scope.kind !== 'class';
    let v = valueMasked.trim();
    if (/^[(\[]/.test(v) && groupEndIndex(v) === v.length) v = v.slice(1, -1);
    const elems = splitTopLevel(v);
    const names = boundNames(targets);
    const readsTarget = elems.some((e) => names.some((name) => new RegExp(`(?<![\\w.])${name.replace(/[.[\]]/g, '\\$&')}(?![\\w])`).test(e)));

    if (elems.length === targets.length && elems.length > 1 && !targets.some((t) => t.startsWith('*')) && !readsTarget) {
      targets.forEach((t, k) => {
        if (t === UNDERSCORE_NAME) return;
        if (nestedTargets(t)) return this.emitUnpacking(nestedTargets(t)!, elems[k], lits, py, k === 0 ? comment : '');
        const value = exValue(elems[k]);
        if (!inFunction && /^\w+$/.test(t)) this.emitFieldOrLocal(t, this.inferValueType(elems[k], lits), value, py, k === 0 ? comment : '');
        else this.emit(`${this.assignmentLine(t, value, (s) => unmaskStrings(translateMaskedExpression(s, this.exprCtx(lits)), lits))}${k === 0 ? `${comment}` : ''}`, py);
      });
      return;
    }

    const whole = elems.length > 1 ? `Tuple.of(${elems.map(exValue).join(', ')})` : exValue(valueMasked);
    let source = whole;
    if (!/^[\w.]+$/.test(whole)) {
      // Evaluate the value once.
      source = this.freeLocalName('tuple');
      if (inFunction) this.emit(`var ${source} = ${whole}; // tuple unpacking${comment}`, py);
      else this.emitFieldOrLocal(source, 'Object', whole, py, ` // tuple unpacking${comment}`);
    } else if (comment) {
      this.emit(`// tuple unpacking${comment}`, py);
    }
    if (inFunction) {
      for (const l of this.unpackingLines(targets, source, lits)) this.emit(l, py);
      return;
    }
    // Module or class level: each name is a field initialized from the tuple.
    const star = targets.findIndex((t) => t.startsWith('*'));
    targets.forEach((raw, k) => {
      const t = raw.replace(/^\*/, '');
      if (t === UNDERSCORE_NAME || !/^\w+$/.test(t)) return;
      const value = k === star ? `${source}.subList(${k}, ${source}.size()${targets.length - k - 1 > 0 ? ` - ${targets.length - k - 1}` : ''})` : star >= 0 && k > star ? `${source}.get(${source}.size() - ${targets.length - k})` : `${source}.get(${k})`;
      this.emitFieldOrLocal(t, 'Object', value, py, '');
    });
  }

  /**
   * Declarations planned by `planHoistedLocals` for the statement at line `i`: a local first
   * assigned in a nested block but used outside it. Typed when every assigned value agrees, and
   * initialized, so later assignments are plain and Java sees it definitely assigned.
   */
  private emitHoistedLocals(i: number, py: number): void {
    const fn = [...this.stack].reverse().find((b) => b.kind === 'def' || b.kind === 'main');
    for (const h of fn?.hoists?.get(i) ?? []) {
      if (fn!.declared?.has(h.name)) continue;
      const types = h.values.map((v) => (v ? this.inferValueType(v.masked, v.literals) : 'Object'));
      let type = types.every((t) => t === types[0]) && !/^var$|\/\*/.test(types[0]) ? types[0] : 'Object';
      type = boxIfNullable(type, fn!.nullability?.names.has(h.name) === true);
      this.declareLocal(h.name);
      if (type !== 'Object') fn!.types?.set(h.name, type);
      this.emit(`${type} ${h.name} = ${DEFAULT_VALUES[type] ?? 'null'};`, py);
    }
  }

  /** Emit `name = value` as a field (class/module level) or a local variable (function level). */
  private emitFieldOrLocal(name: string, type: string, valueJava: string | undefined, py: number, comment: string): void {
    const scope = this.enclosingScope();
    const rhs = valueJava !== undefined ? ` = ${valueJava}` : '';
    if (!scope) {
      // module level
      const isConst = /^[A-Z][A-Z0-9_]*$/.test(name);
      const t = boxIfNullable(type === 'var' ? 'Object' : type, valueJava === 'null');
      if (t !== 'Object') this.scan.moduleTypes.set(name, t);
      this.moduleFields.add(name);
      this.emit(`${isConst ? 'public static final' : 'static'} ${t} ${name}${rhs};${comment}`, py);
      this.recordSymbol(name, 'field', py);
      return;
    }
    if (scope.kind === 'class') {
      if (scope.isEnum) {
        this.emit(`${name}${valueJava !== undefined ? `(${valueJava})` : ''},${comment}`, py);
        this.recordSymbol(name, 'field', py);
        return;
      }
      const t = boxIfNullable(type === 'var' ? 'Object' : type, valueJava === 'null');
      const isConst = /^[A-Z][A-Z0-9_]*$/.test(name);
      const visibility = name.startsWith('__') ? 'private' : name.startsWith('_') ? 'protected' : 'public';
      const modifiers = scope.isRecord ? [visibility] : [visibility, 'static', ...(isConst ? ['final'] : [])];
      scope.fields?.add(name);
      if (scope.isInterface) modifiers.length = 0;
      this.emit(`${modifiers.join(' ')}${modifiers.length ? ' ' : ''}${t} ${name}${rhs};${comment}`, py);
      this.recordSymbol(name, 'field', py);
      return;
    }
    if (scope.kind === 'static') return this.assignInStaticBlock(scope, name, type, valueJava, py, comment);
    // function scope
    const declared = scope.declared!;
    if (declared.has(name)) {
      this.emit(`${name}${rhs};${comment}`, py);
    } else {
      this.declareLocal(name);
      let t = type === 'Object' ? 'var' : type;
      const mayBeNone = valueJava === 'null' || scope.nullability?.names.has(name) === true;
      // `x = None` now, a literal later: declare it with the later type, boxed (`Integer x = null`).
      const later = scope.nullability?.laterTypes.get(name);
      if (/^Object \/\* nullable \*\/$/.test(t) && later) t = nullableType(later);
      else t = boxIfNullable(t, mayBeNone);
      if (t !== 'var') scope.types?.set(name, t);
      this.emit(`${valueJava === undefined ? (t === 'var' ? 'Object' : t) : t} ${name}${rhs};${comment}`, py);
    }
  }
}

export class RuleBasedTranslator implements Translator {
  readonly name = 'rules' as const;

  /** `resolveImports: false` keeps Python's imports as Java-looking lines (see `TranslateInput.pythonImports`). */
  constructor(private readonly options: { resolveImports?: boolean } = {}) {}

  async translate(input: TranslateInput): Promise<TranslateResult> {
    return translateWithRules(this.options.resolveImports === false ? { ...input, pythonImports: true } : input);
  }
}

/** Synchronous entry point (used by tests and the CLI). */
export function translateWithRules(input: TranslateInput): TranslateResult {
  const result = new RuleTranslation(input).translate();
  if (input.pythonImports) return result;
  // Real imports for what the JDK index and the project scan resolve; no model is asked.
  const plan = planImports(result, input.source, input.knownMembers?.modules ?? {}, input.knownMembers?.classes, input.basePackage);
  return { ...result, ...applyImports(result, plan, renderImports(plan, undefined, '')) };
}
