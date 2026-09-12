/**
 * Rule-based Python -> Java-flavored translator.
 *
 * Deterministic, offline, dependency-free. The output is a *reading view*: it
 * looks like Java, keeps the structure and names of the Python source, but is
 * not guaranteed (or intended) to compile.
 *
 * Structure of the generated file:
 *
 *   package a.b;                       // from the folder path
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
import { indexAtDepth0, mapExceptionName, translateExpression, translateMaskedExpression } from './expressions';
import { SymbolInfo, SymbolKind, TranslateInput, TranslateResult, Translator, packageFromPath, toPascalCase } from '../types';

type BlockKind = 'class' | 'def' | 'if' | 'for' | 'while' | 'try' | 'with' | 'match' | 'case' | 'main' | 'other';

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
  /** Name bound by `except ... as name` for this catch block. */
  catchVar?: string;
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

const DUNDER_METHODS: Record<string, { name: string; ret: string; params?: string }> = {
  __str__: { name: 'toString', ret: 'String' },
  __repr__: { name: 'toString /* __repr__ */', ret: 'String' },
  __eq__: { name: 'equals', ret: 'boolean' },
  __ne__: { name: 'notEquals /* __ne__ */', ret: 'boolean' },
  __hash__: { name: 'hashCode', ret: 'int' },
  __len__: { name: 'size', ret: 'int' },
  __bool__: { name: 'isTruthy /* __bool__ */', ret: 'boolean' },
  __iter__: { name: 'iterator', ret: 'Iterator<Object>' },
  __next__: { name: 'next', ret: 'Object' },
  __contains__: { name: 'contains', ret: 'boolean' },
  __getitem__: { name: 'get /* __getitem__ */', ret: 'Object' },
  __setitem__: { name: 'put /* __setitem__ */', ret: 'void' },
  __delitem__: { name: 'remove /* __delitem__ */', ret: 'void' },
  __call__: { name: 'call /* __call__ */', ret: 'Object' },
  __enter__: { name: 'enter /* __enter__: try-with-resources open */', ret: 'Object' },
  __exit__: { name: 'close /* __exit__: try-with-resources close */', ret: 'void' },
  __lt__: { name: 'compareTo /* __lt__ */', ret: 'boolean' },
  __le__: { name: 'lessOrEqual /* __le__ */', ret: 'boolean' },
  __gt__: { name: 'greaterThan /* __gt__ */', ret: 'boolean' },
  __ge__: { name: 'greaterOrEqual /* __ge__ */', ret: 'boolean' },
  __add__: { name: 'plus /* __add__ */', ret: 'Object' },
  __sub__: { name: 'minus /* __sub__ */', ret: 'Object' },
  __mul__: { name: 'times /* __mul__ */', ret: 'Object' },
  __post_init__: { name: '__post_init__ /* runs after the generated constructor */', ret: 'void' },
};

/** Remove one pair of enclosing parentheses when they wrap the whole text. */
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

function inferTypeFromMaskedValue(masked: string, literals: string[]): string {
  const v = masked.trim();
  if (/^-?\d+$/.test(v)) return 'int';
  if (/^-?\d*\.\d+(e-?\d+)?$/i.test(v)) return 'double';
  if (isSingleLiteral(v)) return literals.length && literals[0].startsWith('"""') ? 'String' : 'String';
  if (v === 'True' || v === 'False') return 'boolean';
  if (v === 'None') return 'Object /* nullable */';
  if (/^\[/.test(v) || /^list\(/.test(v)) return 'List<Object>';
  if (/^\{/.test(v)) return indexAtDepth0(v.slice(1, -1), /:/) >= 0 || v === '{}' ? 'Map<String, Object>' : 'Set<Object>';
  if (/^dict\(/.test(v)) return 'Map<String, Object>';
  if (/^set\(/.test(v)) return 'Set<Object>';
  if (/^\(/.test(v)) return 'Tuple';
  if (/^lambda\b/.test(v)) return 'Function<?, ?>';
  const ctor = /^([A-Z]\w*)\(/.exec(v);
  if (ctor) return ctor[1];
  const qualifiedCtor = /^[\w.]*\.([A-Z]\w*)\(/.exec(v);
  if (qualifiedCtor) return qualifiedCtor[1];
  if (/^logging\.getLogger\(/.test(v)) return 'Logger';
  if (/^Path\(/.test(v)) return 'Path';
  return 'var';
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
  private readonly packageParts: string[];
  private skipIndex = -1;
  private readonly moduleClass: string;
  private readonly usedNames = new Set<string>();
  /** Classes, methods and fields declared so far, for "Go to Definition"; rebased in assemble(). */
  private readonly symbols: RawSymbol[] = [];

  constructor(private readonly input: TranslateInput) {
    this.lines = splitLogicalLines(input.source);
    this.packageParts = packageFromPath(input.relativePath).split('.').filter(Boolean);
    const base = input.relativePath.split('/').pop() ?? 'Module';
    this.moduleClass = base === '__init__.py' ? toPascalCase(input.relativePath.split('/').slice(-2, -1)[0] ?? 'Package') + 'Package' : toPascalCase(base);
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
      if (k === 'def' || k === 'main' || k === 'class') return this.stack[i];
    }
    return undefined;
  }

  private exprCtx() {
    return { className: this.enclosingClass()?.className };
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
      if (continuation && block.indent === indent) {
        this.lastClosedKind = block.kind;
        return; // the continuation header emits "} else {" itself
      }
      this.emit('}', 0, this.depth);
    }
  }

  private closeAll(): void {
    while (this.stack.length > 0) {
      this.stack.pop();
      this.emit('}', 0, this.depth);
    }
  }

  /** Next code line index after i (skipping blanks/comments) if it is a docstring for the block opened at i. */
  private docstringAfter(i: number): number {
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

  private javadocLines(line: LogicalLine): OutLine[] {
    const raw = line.text.replace(/^[rRuUbB]*("""|'''|"|')/, '').replace(/("""|'''|"|')$/, '');
    const bodyLines = raw.split('\n').map((l) => l.trim());
    while (bodyLines.length && bodyLines[0] === '') bodyLines.shift();
    while (bodyLines.length && bodyLines[bodyLines.length - 1] === '') bodyLines.pop();
    const result: OutLine[] = [];
    if (bodyLines.length === 1) {
      result.push({ text: `/** ${bodyLines[0]} */`, py: line.startLine });
    } else {
      result.push({ text: '/**', py: line.startLine });
      for (const b of bodyLines) result.push({ text: ` * ${b}`.replace(/\s+$/, ''), py: line.startLine });
      result.push({ text: ' */', py: line.startLine });
    }
    return result;
  }

  private emitJavadoc(line: LogicalLine): void {
    for (const l of this.javadocLines(line)) this.emit(l.text, l.py);
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
    const args = m[2] ? this.expr(m[2].slice(1, -1)) : '';
    const pascal = name.charAt(0).toUpperCase() + name.slice(1);
    return args ? `@${pascal}(${args.replace(/(\w+)\s*=\s*/g, '$1 = ')})` : `@${pascal}`;
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
    if (first >= 0 && isSingleLiteral(maskStrings(this.lines[first].text).text)) {
      this.moduleDoc = this.javadocLines(this.lines[first]);
      this.skipIndex = first;
    }

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
    const pkg = packageFromPath(this.input.relativePath);
    if (pkg) header.push({ text: `package ${pkg};`, py: 0 });
    header.push({ text: '', py: 0 });
    header.push({ text: 'import java.util.*;', py: 0 });
    header.push({ text: 'import java.util.function.*;', py: 0 });
    header.push({ text: 'import java.util.stream.*;', py: 0 });
    if (this.imports.length) {
      header.push({ text: '', py: 0 });
      header.push(...this.imports);
    }
    header.push({ text: '', py: 0 });
    header.push(...this.moduleDoc);
    header.push({ text: `public final class ${this.moduleClass} {`, py: 0 });

    // Trim trailing blank lines from body
    while (this.out.length && this.out[this.out.length - 1].text === '') this.out.pop();
    const all = [...header, ...this.out, { text: '}', py: 0 }, { text: '', py: 0 }];
    const symbols: SymbolInfo[] = [
      { name: this.moduleClass, kind: 'class', container: [], javaLine: header.length - 1, pythonLine: 1 },
      ...this.symbols.map((s) => ({ name: s.name, kind: s.kind, container: s.container, javaLine: header.length + s.javaLineRaw, pythonLine: s.py })),
    ];
    return {
      java: all.map((l) => l.text).join('\n'),
      sourceMap: all.map((l) => l.py),
      symbols,
      warnings: this.warnings,
      engine: 'rules',
    };
  }

  private translateCode(i: number): void {
    const line = this.lines[i];
    const masked = maskStrings(line.text);
    const split = this.splitComment(masked.text);
    const code = split.code;
    let comment = split.comment;
    const lits = masked.literals;
    const py = line.startLine;
    const un = (s: string) => unmaskStrings(s, lits);

    if (code === '') {
      if (comment) this.emit(comment.trim(), py);
      return;
    }

    const continuation = /^(elif\b|else\b|except\b|finally\b|case\b)/.test(code);
    this.closeBlocksTo(line.indent, continuation);
    if (continuation) {
      // Comments between a block and its else/except belong inside the closing block.
      this.pendingTrivia = this.pendingTrivia.filter((t) => t.kind !== 'blank');
    }
    this.flushTrivia();

    // decorators
    if (code.startsWith('@')) {
      this.pendingDecorators.push({ text: un(code), py });
      return;
    }

    // imports
    let m: RegExpExecArray | null;
    if ((m = /^import\s+(.+)$/.exec(code))) {
      for (const part of splitTopLevel(m[1])) {
        const [mod, alias] = part.split(/\s+as\s+/).map((s) => s.trim());
        this.imports.push({ text: `import ${mod};${alias ? ` // as ${alias}` : ''}`, py });
      }
      return;
    }
    if ((m = /^from\s+(\S+)\s+import\s+(.+)$/.exec(code))) {
      if (m[1] === '__future__') return;
      const mod = this.resolveModule(m[1]);
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
      return;
    }

    // compound statements
    if ((m = /^class\s+(\w+)\s*(?:\((.*)\))?\s*:$/.exec(code))) {
      this.translateClass(i, m[1], m[2] ?? '', comment);
      return;
    }
    if ((m = /^(async\s+)?def\s+(\w+)\s*\((.*)\)\s*(?:->\s*(.+?))?\s*:$/.exec(code))) {
      this.translateDef(i, Boolean(m[1]), m[2], un(m[3]), m[4] ? un(m[4]) : undefined, comment);
      return;
    }
    if (/^if\s+__name__\s*==\s*.\d+.\s*:$/.test(code)) {
      this.emit(`public static void main(String[] args) {${comment}`, py);
      this.stack.push({ indent: line.indent, kind: 'main', declared: new Set(['args']) });
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
      const prev = this.lastClosedKind;
      const note = prev === 'for' || prev === 'while' ? ' // loop-else: runs when the loop was not broken out of' : prev === 'try' ? ' // try-else: runs when no exception was raised' : '';
      this.emit(`} else {${note}${comment}`, py);
      this.stack.push({ indent: line.indent, kind: 'if' });
      return;
    }
    if ((m = /^while\s+(.+):$/.exec(code))) {
      this.emit(`while (${this.condition(m[1], lits)}) {${comment}`, py);
      this.stack.push({ indent: line.indent, kind: 'while' });
      return;
    }
    if ((m = /^(async\s+)?for\s+(.+?)\s+in\s+(.+):$/.exec(code))) {
      this.translateFor(line, m[2], un(m[3]), Boolean(m[1]), comment);
      return;
    }
    if (/^try\s*:$/.test(code)) {
      this.emit(`try {${comment}`, py);
      this.stack.push({ indent: line.indent, kind: 'try' });
      return;
    }
    if ((m = /^except\s*(?:\(?([^)]*?)\)?)?\s*(?:as\s+(\w+))?\s*:$/.exec(code))) {
      const types = (m[1] ?? '').trim();
      const names = types ? splitTopLevel(types).map((t) => mapExceptionName(t.trim())).join(' | ') : 'Exception';
      const variable = m[2] ?? (types ? 'ignored' : 'e');
      this.emit(`} catch (${names} ${variable}) {${comment}`, py);
      this.stack.push({ indent: line.indent, kind: 'try', catchVar: variable });
      return;
    }
    if (/^finally\s*:$/.test(code)) {
      this.emit(`} finally {${comment}`, py);
      this.stack.push({ indent: line.indent, kind: 'try' });
      return;
    }
    if ((m = /^(async\s+)?with\s+(.+):$/.exec(code))) {
      this.translateWith(line, m[2], lits, Boolean(m[1]), comment);
      return;
    }
    if ((m = /^match\s+(.+):$/.exec(code))) {
      this.emit(`switch (${un(translateMaskedExpression(m[1], this.exprCtx()))}) {${comment}`, py);
      this.stack.push({ indent: line.indent, kind: 'match' });
      return;
    }
    if ((m = /^case\s+(.+):$/.exec(code))) {
      const pattern = m[1].trim() === '_' ? 'default' : `case ${un(translateMaskedExpression(m[1], this.exprCtx()))}`;
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

  private lastClosedKind: BlockKind | undefined;

  /** Resolve a relative module (".models", "..repository") against this file's package. */
  private resolveModule(mod: string): string {
    const dots = /^\.+/.exec(mod)?.[0].length ?? 0;
    if (dots === 0) return mod;
    const base = this.packageParts.slice(0, Math.max(0, this.packageParts.length - (dots - 1)));
    const rest = mod.slice(dots);
    return [...base, rest].filter(Boolean).join('.');
  }

  private condition(maskedCond: string, lits: string[]): string {
    const translated = unmaskStrings(translateMaskedExpression(maskedCond.trim(), this.exprCtx()), lits);
    // Python truthiness: a bare value is "true" when non-null and non-empty.
    if (/^!?[\w.]+(\(\))?$/.test(translated) && !/^(true|false|null)$/.test(translated)) {
      return `${translated} /* ${translated.startsWith('!') ? 'falsy: null or empty' : 'truthy: non-null and non-empty'} */`;
    }
    return translated;
  }

  // ------------------------------------------------------------------ class

  private translateClass(i: number, name: string, basesText: string, comment: string): void {
    const line = this.lines[i];
    const py = line.startLine;
    const decorators = this.takeDecorators();
    const bases = splitTopLevel(basesText).map((b) => b.trim()).filter((b) => b && !/^metaclass=/.test(b));
    const isEnum = bases.some((b) => ENUM_BASES.has(b.split('.').pop()!));
    const isRecord = bases.some((b) => RECORD_BASES.has(b.split('.').pop()!)) || decorators.some((d) => RECORD_DECORATORS.test(d.text));
    const isAbstract = bases.some((b) => /^(ABC|abc\.ABC)$/.test(b));
    const isInterface = bases.some((b) => /^(Protocol|typing\.Protocol)$/.test(b));
    const generics = bases.map((b) => /^Generic\[(.+)\]$/.exec(b)?.[1]).filter(Boolean);
    const realBases = bases.filter((b) => !/^(ABC|abc\.ABC|Protocol|typing\.Protocol|Generic\[.*\]|object)$/.test(b) && !ENUM_BASES.has(b.split('.').pop()!) && !RECORD_BASES.has(b.split('.').pop()!));

    const doc = this.docstringAfter(i);
    if (doc >= 0) {
      this.emitJavadoc(this.lines[doc]);
      this.skipIndex = doc;
    }
    for (const d of decorators) {
      this.emit(this.decoratorToAnnotation(d.text), d.py);
    }
    if (isRecord && !decorators.some((d) => RECORD_DECORATORS.test(d.text))) {
      this.emit(`/* ${bases.find((b) => RECORD_BASES.has(b.split('.').pop()!))}: value object with generated constructor/equals/hashCode */`, py);
    }

    let header: string;
    const typeParams = generics.length ? `<${generics.join(', ')}>` : '';
    if (isEnum) {
      header = `public enum ${name}${typeParams}`;
    } else if (isInterface) {
      header = `public interface ${name}${typeParams}`;
    } else {
      header = `public${isAbstract ? ' abstract' : ''} static class ${name}${typeParams}`;
    }
    if (realBases.length) {
      const [first, ...rest] = realBases.map((b) => translateType(mapExceptionName(b)));
      header += isInterface ? ` extends ${realBases.join(', ')}` : ` extends ${first}`;
      if (!isInterface && rest.length) header += ` /* also inherits: ${rest.join(', ')} */`;
    }
    this.emit(`${header} {${comment}`, py);
    this.usedNames.add(name);
    this.recordSymbol(name, 'class', py);

    const block: Block = { indent: line.indent, kind: 'class', className: name, isEnum, isRecord, isInterface };
    this.stack.push(block);

    // Field declarations for attributes assigned via self.x = ... anywhere in the class.
    if (!isEnum) {
      const fields = this.collectSelfFields(i);
      const declaredAtClassLevel = new Set(
        this.bodyLines(i)
          .filter((l) => l.indent === line.indent + this.indentUnit(i))
          .map((l) => /^(\w+)\s*(?::|=)/.exec(l.text)?.[1])
          .filter(Boolean),
      );
      const toEmit = fields.filter((f) => !declaredAtClassLevel.has(f.name));
      for (const f of toEmit) {
        const visibility = f.name.startsWith('_') ? 'private' : 'public';
        this.emit(`${visibility} ${f.type} ${f.name}; // assigned as self.${f.name} in ${f.where}`, f.py);
        this.recordSymbol(f.name, 'field', f.py);
      }
      if (toEmit.length) this.emit('', 0, 0);
    }
  }

  private indentUnit(i: number): number {
    const header = this.lines[i];
    for (let j = i + 1; j < this.lines.length; j += 1) {
      const l = this.lines[j];
      if (l.kind === 'code') return l.indent > header.indent ? l.indent - header.indent : 4;
    }
    return 4;
  }

  private collectSelfFields(i: number): { name: string; type: string; py: number; where: string }[] {
    const header = this.lines[i];
    const seen = new Map<string, { name: string; type: string; py: number; where: string }>();
    let currentDef = '';
    let paramTypes = new Map<string, string>();
    for (let j = i + 1; j < this.lines.length; j += 1) {
      const l = this.lines[j];
      if (l.kind !== 'code') continue;
      if (l.indent <= header.indent) break;
      const d = /^(?:async\s+)?def\s+(\w+)\s*\((.*)\)/.exec(l.text);
      if (d) {
        currentDef = d[1];
        paramTypes = new Map();
        for (const p of splitTopLevel(d[2])) {
          const pm = /^\**(\w+)\s*(?::\s*([^=]+?))?\s*(?:=\s*(.+))?$/.exec(p.trim());
          if (!pm) continue;
          if (pm[2]) paramTypes.set(pm[1], translateType(pm[2]));
          else if (pm[3]) paramTypes.set(pm[1], this.typeFromDefault(pm[3]));
        }
        continue;
      }
      const masked = maskStrings(l.text);
      const code = this.splitComment(masked.text).code;
      const m = /^self\.(\w+)\s*(?::\s*([^=]+?))?\s*(?:=|\+=|-=)\s*(.+)$/.exec(code);
      if (m && !seen.has(m[1])) {
        const rhs = m[3].trim();
        const fromParam = /^\w+$/.test(rhs) ? paramTypes.get(rhs) : /^(\w+)\s+or\s+/.exec(rhs) ? paramTypes.get(/^(\w+)/.exec(rhs)![1]) : undefined;
        const type = m[2] ? translateType(unmaskStrings(m[2], masked.literals)) : fromParam ?? inferTypeFromMaskedValue(m[3], masked.literals);
        seen.set(m[1], { name: m[1], type: type === 'var' ? 'Object' : type, py: l.startLine, where: currentDef ? `${currentDef}()` : 'class body' });
      }
    }
    return [...seen.values()];
  }

  // -------------------------------------------------------------------- def

  private translateDef(i: number, isAsync: boolean, name: string, paramsText: string, returnHint: string | undefined, comment: string): void {
    const line = this.lines[i];
    const py = line.startLine;
    const decorators = this.takeDecorators();
    const cls = this.enclosingClass();
    const inClass = cls !== undefined && this.top() === cls;
    const isStaticDecorated = decorators.some((d) => /^@(staticmethod|classmethod)\b/.test(d.text));
    const isClassMethod = decorators.some((d) => /^@classmethod\b/.test(d.text));
    const isAbstract = decorators.some((d) => /^@(abc\.)?abstractmethod\b/.test(d.text));
    const isProperty = decorators.some((d) => /^@(cached_)?property\b/.test(d.text));
    const isSetter = decorators.some((d) => /^@\w+\.setter\b/.test(d.text));
    const otherDecorators = decorators.filter((d) => !/^@(staticmethod|classmethod|(abc\.)?abstractmethod|(cached_)?property|\w+\.setter)\b/.test(d.text));

    const doc = this.docstringAfter(i);
    if (doc >= 0) {
      this.emitJavadoc(this.lines[doc]);
      this.skipIndex = doc;
    }
    for (const d of otherDecorators) this.emit(this.decoratorToAnnotation(d.text), d.py);
    if (isProperty) this.emit('@Property // accessed like a field in Python: obj.name', py);
    if (isSetter) this.emit('@Setter // assigned like a field in Python: obj.name = value', py);

    // parameters
    const declared = new Set<string>();
    const params: string[] = [];
    const rawParams = splitTopLevel(paramsText).map((p) => p.trim()).filter(Boolean);
    rawParams.forEach((p, idx) => {
      if (p === '*' || p === '/') return;
      if (idx === 0 && inClass && !isStaticDecorated && /^(self|cls)\b/.test(p)) return;
      if (idx === 0 && isClassMethod && /^cls\b/.test(p)) return;
      let pm: RegExpExecArray | null;
      if ((pm = /^\*\*(\w+)/.exec(p))) {
        params.push(`Map<String, Object> ${pm[1]} /* **kwargs */`);
        declared.add(pm[1]);
        return;
      }
      if ((pm = /^\*(\w+)(?::\s*(.+))?/.exec(p))) {
        params.push(`${pm[2] ? boxed(translateType(pm[2])) : 'Object'}... ${pm[1]}`);
        declared.add(pm[1]);
        return;
      }
      const parsed = /^(\w+)\s*(?::\s*([^=]+?))?\s*(?:=\s*(.+))?$/.exec(p);
      if (!parsed) {
        params.push(this.expr(p));
        return;
      }
      const [, pname, hint, def] = parsed;
      declared.add(pname);
      let type = hint ? translateType(hint) : def ? this.typeFromDefault(def) : 'Object';
      if (def !== undefined && def.trim() === 'None' && !/nullable/.test(type)) type += ' /* nullable */';
      params.push(def !== undefined ? `${type} ${pname} /* = ${this.expr(def)} */` : `${type} ${pname}`);
    });

    // name, return type, modifiers
    let javaName = name;
    let ret = returnHint ? translateType(returnHint) : this.inferReturnType(i);
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
    if (isAsync) ret = ret === 'void' ? 'CompletableFuture<Void> /* async */' : `CompletableFuture<${boxed(ret)}> /* async */`;

    const nested = !inClass && this.enclosingScope() && this.enclosingScope()!.kind !== 'class';
    if (nested) {
      this.emit(`// nested function ${name}() - closes over the enclosing scope`, py);
      modifiers = modifiers.filter((mod) => mod !== 'static');
    }

    const signature = `${modifiers.join(' ')}${modifiers.length ? ' ' : ''}${isCtor ? '' : `${ret} `}${javaName}(${params.join(', ')})`;
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
    this.stack.push({ indent: line.indent, kind: 'def', declared });
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

  private typeFromDefault(def: string): string {
    const masked = maskStrings(def);
    const t = inferTypeFromMaskedValue(masked.text, masked.literals);
    return t === 'var' ? 'Object' : t;
  }

  private inferReturnType(i: number): string {
    const body = this.bodyLines(i);
    const headerIndent = this.lines[i].indent;
    let sawValue = false;
    let sawYield = false;
    for (const l of body) {
      // Do not look into nested defs/classes.
      if (/^(async\s+)?(def|class)\s/.test(l.text) && l.indent > headerIndent) {
        // skip nested block lines
        continue;
      }
      const code = this.splitComment(maskStrings(l.text).text).code;
      if (/^return\s+\S/.test(code)) sawValue = true;
      if (/\byield\b/.test(code)) sawYield = true;
    }
    if (sawYield) return 'Iterator<Object> /* generator */';
    return sawValue ? 'Object' : 'void';
  }

  // -------------------------------------------------------------------- for

  private translateFor(line: LogicalLine, target: string, iterable: string, isAsync: boolean, comment: string): void {
    const py = line.startLine;
    const asyncNote = isAsync ? ' /* async for */' : '';
    const targets = splitTopLevel(stripOuterParens(target)).map((t) => t.trim());
    const declared = this.enclosingScope()?.declared;
    targets.forEach((t) => declared?.add(t));
    let m: RegExpExecArray | null;

    if ((m = /^range\((.*)\)$/.exec(iterable.trim())) && targets.length === 1) {
      const args = splitTopLevel(m[1]).map((a) => this.expr(a));
      const v = targets[0];
      let header: string;
      if (args.length === 1) header = `for (int ${v} = 0; ${v} < ${args[0]}; ${v}++)`;
      else if (args.length === 2) header = `for (int ${v} = ${args[0]}; ${v} < ${args[1]}; ${v}++)`;
      else {
        const step = args[2];
        const down = step.startsWith('-');
        header = `for (int ${v} = ${args[0]}; ${v} ${down ? '>' : '<'} ${args[1]}; ${v} ${down ? '-=' : '+='} ${down ? step.slice(1) : step})`;
      }
      this.emit(`${header} {${asyncNote}${comment}`, py);
      this.stack.push({ indent: line.indent, kind: 'for' });
      return;
    }
    if ((m = /^enumerate\((.*)\)$/.exec(iterable.trim())) && targets.length === 2) {
      const args = splitTopLevel(m[1]);
      const coll = this.expr(args[0]);
      const start = args[1] ? this.expr(args[1].replace(/^start\s*=\s*/, '')) : '0';
      const [idx, item] = targets;
      const simple = /^[\w.]+$/.test(coll);
      if (simple) {
        this.emit(`for (int ${idx} = ${start}; ${idx} < ${coll}.size()${start !== '0' ? ` + ${start}` : ''}; ${idx}++) {${asyncNote}${comment}`, py);
        this.stack.push({ indent: line.indent, kind: 'for' });
        this.emit(`var ${item} = ${coll}.get(${idx}${start !== '0' ? ` - ${start}` : ''});`, py);
        return;
      }
    }
    if (/\.items\(\)$/.test(iterable.trim()) && targets.length === 2) {
      const mapExpr = this.expr(iterable.trim().replace(/\.items\(\)$/, ''));
      const [k, v] = targets;
      this.emit(`for (var entry : ${mapExpr}.entrySet()) {${asyncNote}${comment}`, py);
      this.stack.push({ indent: line.indent, kind: 'for' });
      this.emit(`var ${k} = entry.getKey();`, py);
      this.emit(`var ${v} = entry.getValue();`, py);
      return;
    }
    if ((m = /^zip\((.*)\)$/.exec(iterable.trim())) && targets.length >= 2) {
      const colls = splitTopLevel(m[1]).map((a) => this.expr(a));
      if (colls.every((c) => /^[\w.]+$/.test(c)) && colls.length === targets.length) {
        this.emit(`for (int i = 0; i < ${colls[0]}.size(); i++) { // zip${asyncNote}${comment}`, py);
        this.stack.push({ indent: line.indent, kind: 'for' });
        targets.forEach((t, k) => this.emit(`var ${t} = ${colls[k]}.get(i);`, py));
        return;
      }
    }
    const iter = this.expr(iterable);
    if (targets.length === 1) {
      this.emit(`for (var ${targets[0]} : ${iter}) {${asyncNote}${comment}`, py);
    } else {
      this.emit(`for (var (${targets.join(', ')}) : ${iter}) { // tuple unpacking${asyncNote}${comment}`, py);
    }
    this.stack.push({ indent: line.indent, kind: 'for' });
  }

  // ------------------------------------------------------------------- with

  private translateWith(line: LogicalLine, itemsText: string, lits: string[], isAsync: boolean, comment: string): void {
    const py = line.startLine;
    const items = splitTopLevel(stripOuterParens(itemsText));
    const declared = this.enclosingScope()?.declared;
    const asyncNote = isAsync ? ' /* async with */' : '';
    const resources: string[] = [];
    let counter = 0;
    let allBare = true;
    for (const item of items) {
      const m = /^(.+?)\s+as\s+(\w+)$/.exec(item.trim());
      if (m) {
        allBare = false;
        declared?.add(m[2]);
        resources.push(`var ${m[2]} = ${unmaskStrings(translateMaskedExpression(m[1], this.exprCtx()), lits)}`);
      } else {
        const ctx = unmaskStrings(translateMaskedExpression(item.trim(), this.exprCtx()), lits);
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
  }

  // -------------------------------------------------------- simple statements

  private translateSimple(code: string, lits: string[], py: number, comment: string): void {
    const un = (s: string) => unmaskStrings(s, lits);
    const ex = (s: string) => un(translateMaskedExpression(s, this.exprCtx()));
    let m: RegExpExecArray | null;

    if (code === 'pass') return this.emit(`// pass${comment}`, py);
    if (code === '...') return this.emit(`// ...${comment}`, py);
    if (code === 'break' || code === 'continue') return this.emit(`${code};${comment}`, py);
    if (code === 'return') return this.emit(`return;${comment}`, py);
    if ((m = /^return\s+(.+)$/.exec(code))) {
      const parts = splitTopLevel(m[1]);
      const value = parts.length > 1 ? `Tuple.of(${parts.map(ex).join(', ')})` : ex(m[1]);
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
      const sub = /^(.+)\[(.+)\]$/.exec(target);
      if (sub) return this.emit(`${ex(sub[1])}.remove(${ex(sub[2])});${comment}`, py);
      return this.emit(`${ex(target)} = null; // del${comment}`, py);
    }
    if ((m = /^(global|nonlocal)\s+(.+)$/.exec(code))) return this.emit(`// ${m[1]} ${m[2]}${comment}`, py);
    if ((m = /^yield\s+from\s+(.+)$/.exec(code))) return this.emit(`for (var item : ${ex(m[1])}) { yield item; } // yield from: delegate to a sub-generator${comment}`, py);
    if ((m = /^yield\s*(.*)$/.exec(code))) return this.emit(`yield ${m[1] ? ex(m[1]) : 'null'}; // generator${comment}`, py);
    if (isSingleLiteral(code)) {
      // Stray string expression (e.g. a docstring not directly under a header): keep as comment.
      const text = un(code).replace(/^"""\n?/, '').replace(/"""$/, '').replace(/^"|"$/g, '');
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
      const sub = /^(.+)\[(.+)\]$/.exec(target);
      if (sub) {
        const recv = ex(sub[1]);
        const key = ex(sub[2]);
        return this.emit(`${recv}.put(${key}, ${recv}.get(${key}) ${op} ${value});${comment}`, py);
      }
      const t = ex(target);
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
    const ex = (s: string) => un(translateMaskedExpression(s, this.exprCtx()));

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
    let valueJava = ex(valueMasked);
    let valueMaskedForType = valueMasked;

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
        this.emit(`this.${target.slice(5)} = ${valueJava};${comment}`, py);
      } else if ((m = /^self\.(\w+)\s*:\s*(.+)$/.exec(target))) {
        // self.x: T = value - the type is already declared in the field list.
        this.emit(`this.${m[1]} = ${valueJava}; // ${translateType(un(m[2]))}${comment}`, py);
      } else if (/^\w+$/.test(target)) {
        this.emitFieldOrLocal(target, inferTypeFromMaskedValue(valueMaskedForType, lits), valueJava, py, comment);
      } else if (/^\(?[\w.]+(\s*,\s*[\w.]+)+\)?$/.test(target) || /^\[.*\]$/.test(target) && !/^\w+\[/.test(target)) {
        const names = splitTopLevel(target.replace(/^[(\[]|[)\]]$/g, '')).map((n) => n.trim());
        const scope = this.enclosingScope();
        const isNew = names.every((n) => !scope?.declared?.has(n));
        names.forEach((n) => scope?.declared?.add(n));
        this.emit(`${isNew ? 'var ' : ''}(${names.join(', ')}) = ${valueJava}; // tuple unpacking${comment}`, py);
      } else {
        const sub = /^(.+)\[(.+)\]$/.exec(target);
        if (sub) {
          this.emit(`${ex(sub[1])}.put(${ex(sub[2])}, ${valueJava});${comment}`, py);
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
      if (m[1] === 'default') return unmaskStrings(translateMaskedExpression(v, this.exprCtx()), lits);
      const factories: Record<string, string> = { list: 'new ArrayList<>()', dict: 'new HashMap<>()', set: 'new HashSet<>()' };
      return factories[v] ?? `${unmaskStrings(translateMaskedExpression(v, this.exprCtx()), lits)}() /* default_factory */`;
    }
    return `null /* field(${unmaskStrings(argsText, lits)}) */`;
  }

  /** Emit `name = value` as a field (class/module level) or a local variable (function level). */
  private emitFieldOrLocal(name: string, type: string, valueJava: string | undefined, py: number, comment: string): void {
    const scope = this.enclosingScope();
    const rhs = valueJava !== undefined ? ` = ${valueJava}` : '';
    if (!scope) {
      // module level
      const isConst = /^[A-Z][A-Z0-9_]*$/.test(name);
      const t = type === 'var' ? 'Object' : type;
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
      const t = type === 'var' ? 'Object' : type;
      const isConst = /^[A-Z][A-Z0-9_]*$/.test(name);
      const visibility = name.startsWith('__') ? 'private' : name.startsWith('_') ? 'protected' : 'public';
      const modifiers = scope.isRecord ? [visibility] : [visibility, 'static', ...(isConst ? ['final'] : [])];
      if (scope.isInterface) modifiers.length = 0;
      this.emit(`${modifiers.join(' ')}${modifiers.length ? ' ' : ''}${t} ${name}${rhs};${comment}`, py);
      this.recordSymbol(name, 'field', py);
      return;
    }
    // function scope
    const declared = scope.declared!;
    if (declared.has(name)) {
      this.emit(`${name}${rhs};${comment}`, py);
    } else {
      declared.add(name);
      const t = type === 'Object' ? 'var' : type;
      this.emit(`${valueJava === undefined ? (t === 'var' ? 'Object' : t) : t} ${name}${rhs};${comment}`, py);
    }
  }
}

export class RuleBasedTranslator implements Translator {
  readonly name = 'rules' as const;

  async translate(input: TranslateInput): Promise<TranslateResult> {
    return translateWithRules(input);
  }
}

/** Synchronous entry point (used by tests and the CLI). */
export function translateWithRules(input: TranslateInput): TranslateResult {
  return new RuleTranslation(input).translate();
}
