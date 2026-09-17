/**
 * Member scan: what a module declares, gathered up front so the translator can render
 * property reads as method calls, name Lombok accessors, and infer types from calls.
 *
 *  - classes: their bases, `@property` accessors, field types, method return types
 *  - module-level functions and their return types
 *  - every plain attribute name (`self.x = ...`, `x: T` in a class body), so a property
 *    name that is also an ordinary attribute somewhere is never rewritten
 *
 * `KnownMembers` is the JSON-serializable, name-keyed form shared across files: the
 * project mirror merges one per file and hands the result to every translation.
 */

import { LogicalLine, splitLogicalLines } from './logicalLines';
import { isSingleLiteral, maskStrings, unmaskStrings } from './strings';
import { splitTopLevel, translateType } from './typeHints';
import { indexAtDepth0 } from './expressions';

export interface PropertyInfo {
  name: string;
  /** The `self.<field>` a trivial getter returns (and a trivial setter assigns), if the accessor is that simple. */
  trivialField?: string;
  hasSetter: boolean;
  /** Java return type from the getter's `-> T` hint, when present. */
  returnType?: string;
}

export interface FieldInfo {
  name: string;
  /** Java type. */
  type: string;
  /** 1-based Python line of the first assignment. */
  py: number;
  /** Where the field is first assigned: `__init__()` or `class body`. */
  where: string;
}

export interface ClassMembers {
  name: string;
  bases: string[];
  properties: Map<string, PropertyInfo>;
  /** Method name -> Java return type (from the `-> T` hint). */
  methods: Map<string, string>;
  /** Field name -> Java type, from `self.x` assignments and class-level annotations. */
  fields: Map<string, string>;
}

export interface MemberScan {
  classes: Map<string, ClassMembers>;
  /** Module-level function name -> Java return type (from the `-> T` hint). */
  functions: Map<string, string>;
  /** Module-level annotated names -> Java type. */
  moduleTypes: Map<string, string>;
  /** Every plain attribute name declared in any class. */
  attributes: Set<string>;
}

/** Cross-file knowledge, keyed by bare names (JSON-friendly). */
export interface KnownMembers {
  /** Property name -> how it is accessed. */
  properties: Record<string, { trivial: boolean; boolean: boolean; setter: boolean }>;
  /** Names that are ordinary attributes somewhere: never treated as properties. */
  attributes: string[];
  /** `Class.method` or `function` -> Java return type. Conflicting definitions are dropped. */
  returnTypes: Record<string, string>;
  /** `Class.field` -> Java type. */
  fieldTypes: Record<string, string>;
}

/** Java type of a literal / simple value on the right-hand side of an assignment; 'var' when unknown. */
export function inferTypeFromMaskedValue(masked: string, literals: string[]): string {
  const v = masked.trim();
  void literals;
  if (/^-?\d+$/.test(v)) return 'int';
  if (/^-?\d*\.\d+(e-?\d+)?$/i.test(v)) return 'double';
  if (isSingleLiteral(v)) return 'String';
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

export function typeFromDefault(def: string): string {
  const masked = maskStrings(def);
  const t = inferTypeFromMaskedValue(masked.text, masked.literals);
  return t === 'var' ? 'Object' : t;
}

/** Statement text of a code line without its trailing comment. */
function codeOf(line: LogicalLine): string {
  const masked = maskStrings(line.text).text;
  const idx = masked.indexOf('#');
  return (idx < 0 ? masked : masked.slice(0, idx)).trim();
}

/** Code lines strictly inside the block whose header is at `i`. */
function bodyLines(lines: LogicalLine[], i: number): LogicalLine[] {
  const header = lines[i];
  const body: LogicalLine[] = [];
  for (let j = i + 1; j < lines.length; j += 1) {
    const l = lines[j];
    if (l.kind !== 'code') continue;
    if (l.indent <= header.indent) break;
    body.push(l);
  }
  return body;
}

/** Indentation of the first code line inside the block at `i`, relative to its header (4 when empty). */
export function indentUnitAt(lines: LogicalLine[], i: number): number {
  const header = lines[i];
  for (let j = i + 1; j < lines.length; j += 1) {
    const l = lines[j];
    if (l.kind === 'code') return l.indent > header.indent ? l.indent - header.indent : 4;
  }
  return 4;
}

/** Parameter name -> Java type for the `def` at `i`, from hints or defaults. */
export function paramTypesOf(paramsText: string): Map<string, string> {
  const types = new Map<string, string>();
  for (const p of splitTopLevel(paramsText)) {
    const pm = /^\**(\w+)\s*(?::\s*([^=]+?))?\s*(?:=\s*(.+))?$/.exec(p.trim());
    if (!pm) continue;
    if (pm[2]) types.set(pm[1], translateType(pm[2]));
    else if (pm[3]) types.set(pm[1], typeFromDefault(pm[3]));
  }
  return types;
}

/** Optional hook that resolves the type of an assigned expression (calls, attribute chains) from context. */
export type ValueTypeResolver = (masked: string, literals: string[], fieldsSoFar: Map<string, FieldInfo>) => string | undefined;

/**
 * Fields assigned as `self.x = ...` anywhere in the class whose header is at `i`, with
 * a Java type from the annotation, the assigned parameter's hint, the literal, or `resolve`.
 */
export function collectSelfFields(lines: LogicalLine[], i: number, resolve?: ValueTypeResolver): FieldInfo[] {
  const header = lines[i];
  const seen = new Map<string, FieldInfo>();
  let currentDef = '';
  let paramTypes = new Map<string, string>();
  for (let j = i + 1; j < lines.length; j += 1) {
    const l = lines[j];
    if (l.kind !== 'code') continue;
    if (l.indent <= header.indent) break;
    const d = /^(?:async\s+)?def\s+(\w+)\s*(?:\[[^\]]*\])?\s*\((.*)\)/.exec(l.text);
    if (d) {
      currentDef = d[1];
      paramTypes = paramTypesOf(d[2]);
      continue;
    }
    const masked = maskStrings(l.text);
    const code = codeOf(l);
    const m = /^self\.(\w+)\s*(?::\s*([^=]+?))?\s*(?:=|\+=|-=)\s*(.+)$/.exec(code);
    if (m && !seen.has(m[1])) {
      const rhs = m[3].trim();
      const fromParam = /^\w+$/.test(rhs) ? paramTypes.get(rhs) : /^(\w+)\s+or\s+/.exec(rhs) ? paramTypes.get(/^(\w+)/.exec(rhs)![1]) : undefined;
      let type = m[2] ? translateType(unmaskStrings(m[2], masked.literals)) : fromParam ?? inferTypeFromMaskedValue(m[3], masked.literals);
      if (type === 'var' && resolve) type = resolve(m[3], masked.literals, seen) ?? 'var';
      seen.set(m[1], { name: m[1], type: type === 'var' ? 'Object' : type, py: l.startLine, where: currentDef ? `${currentDef}()` : 'class body' });
    }
  }
  return [...seen.values()];
}

/** The single `return self.<field>` / `self.<field> = <param>` statement of a trivial accessor, or undefined. */
function trivialAccessorField(lines: LogicalLine[], defIndex: number, setterParam?: string): string | undefined {
  const body = bodyLines(lines, defIndex);
  if (body.length !== 1) return undefined;
  const code = codeOf(body[0]);
  if (isSingleLiteral(code)) return undefined;
  if (setterParam === undefined) return /^return\s+self\.(\w+)$/.exec(code)?.[1];
  const m = /^self\.(\w+)\s*=\s*(\w+)$/.exec(code);
  return m && m[2] === setterParam ? m[1] : undefined;
}

/** Scan a module's logical lines. */
export function scanMembers(lines: LogicalLine[]): MemberScan {
  const scan: MemberScan = { classes: new Map(), functions: new Map(), moduleTypes: new Map(), attributes: new Set() };
  // Class headers with the indent of their members, innermost last.
  const classStack: { members: ClassMembers; indent: number; memberIndent: number }[] = [];
  let pendingDecorators: string[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i];
    if (l.kind !== 'code') continue;
    while (classStack.length && l.indent <= classStack[classStack.length - 1].indent) classStack.pop();
    const code = codeOf(l);
    // Structure is matched on masked text; type hints are unmasked so `-> "Order"` reads as Order.
    const literals = maskStrings(l.text).literals;
    const unmask = (t: string) => unmaskStrings(t, literals);
    if (code.startsWith('@')) {
      pendingDecorators.push(code);
      continue;
    }
    const decorators = pendingDecorators;
    pendingDecorators = [];
    const enclosing = classStack[classStack.length - 1];
    const atMemberLevel = enclosing !== undefined && l.indent === enclosing.memberIndent;

    let m: RegExpExecArray | null;
    if ((m = /^class\s+(\w+)\s*(?:\[[^\]]*\])?\s*(?:\((.*)\))?\s*:$/.exec(code))) {
      const bases = splitTopLevel(m[2] ?? '').map((b) => b.trim()).filter((b) => b && !/^metaclass=/.test(b));
      const members: ClassMembers = { name: m[1], bases, properties: new Map(), methods: new Map(), fields: new Map() };
      for (const f of collectSelfFields(lines, i)) {
        members.fields.set(f.name, f.type);
        scan.attributes.add(f.name);
      }
      // Nested classes shadow module-level ones of the same name only within their parent; keep the first seen.
      if (!scan.classes.has(members.name)) scan.classes.set(members.name, members);
      classStack.push({ members, indent: l.indent, memberIndent: l.indent + indentUnitAt(lines, i) });
      continue;
    }
    if ((m = /^(?:async\s+)?def\s+(\w+)\s*(?:\[[^\]]*\])?\s*\((.*)\)\s*(?:->\s*(.+?))?\s*:$/.exec(code))) {
      const [, name, params, hint] = m;
      const ret = hint ? translateType(unmask(hint)) : undefined;
      if (atMemberLevel) {
        const cls = enclosing!.members;
        const isGetter = decorators.some((d) => /^@(cached_)?property\b/.test(d));
        const isSetter = decorators.some((d) => new RegExp(`^@${name}\\.setter\\b`).test(d));
        if (isGetter) {
          const existing = cls.properties.get(name);
          cls.properties.set(name, { name, trivialField: trivialAccessorField(lines, i), hasSetter: existing?.hasSetter ?? false, returnType: ret });
        } else if (isSetter) {
          const valueParam = splitTopLevel(params).map((p) => p.trim()).filter((p) => p && p !== 'self')[0]?.replace(/[:=].*$/, '').trim();
          const prop = cls.properties.get(name) ?? { name, hasSetter: false };
          prop.hasSetter = true;
          // A setter that does more than assign the getter's field makes the pair non-trivial.
          if (prop.trivialField && trivialAccessorField(lines, i, valueParam) !== prop.trivialField) prop.trivialField = undefined;
          cls.properties.set(name, prop);
        } else if (ret) {
          cls.methods.set(name, ret);
        }
      } else if (!enclosing && l.indent === 0 && ret) {
        scan.functions.set(name, ret);
      }
      continue;
    }
    if (atMemberLevel && (m = /^(\w+)\s*:\s*([^=]+?)\s*(?:=.*)?$/.exec(code)) && !/^(lambda|if|else)\b/.test(code)) {
      const cls = enclosing!.members;
      if (!cls.fields.has(m[1])) cls.fields.set(m[1], translateType(unmask(m[2])));
      scan.attributes.add(m[1]);
      continue;
    }
    if (atMemberLevel && (m = /^(\w+)\s*=/.exec(code)) && !/^(\w+)\s*==/.test(code)) {
      scan.attributes.add(m[1]);
      continue;
    }
    if (!enclosing && l.indent === 0 && (m = /^(\w+)\s*:\s*([^=]+?)\s*=/.exec(code))) {
      scan.moduleTypes.set(m[1], translateType(unmask(m[2])));
    }
  }
  return scan;
}

/** Whether a Java type is boolean-valued. */
function isBooleanType(t: string | undefined): boolean {
  return t !== undefined && /^boolean\b/.test(t.replace(/\/\*.*?\*\//g, '').trim());
}

/** The cross-file, name-keyed form of a scan. */
export function toKnownMembers(scan: MemberScan): KnownMembers {
  const known: KnownMembers = { properties: {}, attributes: [...scan.attributes], returnTypes: {}, fieldTypes: {} };
  for (const [fn, ret] of scan.functions) known.returnTypes[fn] = ret;
  for (const cls of scan.classes.values()) {
    for (const [method, ret] of cls.methods) known.returnTypes[`${cls.name}.${method}`] = ret;
    for (const [field, type] of cls.fields) known.fieldTypes[`${cls.name}.${field}`] = type;
    for (const prop of cls.properties.values()) {
      const boolean = isBooleanType(prop.returnType) || (prop.trivialField !== undefined && isBooleanType(cls.fields.get(prop.trivialField)));
      known.properties[prop.name] = { trivial: prop.trivialField !== undefined, boolean, setter: prop.hasSetter };
      if (prop.returnType) known.returnTypes[`${cls.name}.${prop.name}`] = prop.returnType;
      else if (prop.trivialField && cls.fields.has(prop.trivialField)) known.returnTypes[`${cls.name}.${prop.name}`] = cls.fields.get(prop.trivialField)!;
    }
  }
  return known;
}

/** Scan raw source text (used by the project pre-pass). */
export function knownMembersOf(source: string): KnownMembers {
  return toKnownMembers(scanMembers(splitLogicalLines(source)));
}

/** Merge per-file knowledge; a name defined differently in two files is treated as unknown. */
export function mergeKnownMembers(parts: KnownMembers[]): KnownMembers {
  const merged: KnownMembers = { properties: {}, attributes: [], returnTypes: {}, fieldTypes: {} };
  const attributes = new Set<string>();
  const conflicts = new Set<string>();
  const fieldConflicts = new Set<string>();
  for (const part of parts) {
    for (const a of part.attributes) attributes.add(a);
    for (const [name, info] of Object.entries(part.properties)) {
      const prev = merged.properties[name];
      merged.properties[name] = prev ? { trivial: prev.trivial && info.trivial, boolean: prev.boolean && info.boolean, setter: prev.setter || info.setter } : info;
    }
    for (const [key, type] of Object.entries(part.returnTypes)) {
      if (key in merged.returnTypes && merged.returnTypes[key] !== type) conflicts.add(key);
      else merged.returnTypes[key] = type;
    }
    for (const [key, type] of Object.entries(part.fieldTypes)) {
      if (key in merged.fieldTypes && merged.fieldTypes[key] !== type) fieldConflicts.add(key);
      else merged.fieldTypes[key] = type;
    }
  }
  for (const key of conflicts) delete merged.returnTypes[key];
  for (const key of fieldConflicts) delete merged.fieldTypes[key];
  merged.attributes = [...attributes];
  return merged;
}

/** Element type of a Java collection type, or undefined: `List<Order>` -> `Order`, `Order[]` -> `Order`. */
export function elementTypeOf(javaType: string | undefined): string | undefined {
  if (!javaType) return undefined;
  const t = javaType.replace(/\/\*.*?\*\//g, '').trim();
  const arr = /^(.+)\[\]$/.exec(t);
  if (arr) return arr[1];
  const m = /^(List|Set|Iterable|Collection|Iterator|Deque|Queue|SortedSet|LinkedHashSet|ArrayList|HashSet|Sequence)<(.+)>$/.exec(t);
  if (!m || m[2] === '?') return undefined;
  return unbox(m[2].trim());
}

/** Key and value types of a Java map type, or undefined: `Map<String, List<Order>>` -> [String, List<Order>]. */
export function mapTypesOf(javaType: string | undefined): [string, string] | undefined {
  if (!javaType) return undefined;
  const t = javaType.replace(/\/\*.*?\*\//g, '').trim();
  const m = /^(Map|HashMap|LinkedHashMap|SortedMap|TreeMap)<(.+)>$/.exec(t);
  if (!m) return undefined;
  const parts = splitAngle(m[2]);
  return parts.length === 2 ? [unbox(parts[0]), unbox(parts[1])] : undefined;
}

/** Split `A, Map<B, C>` at top-level commas, honouring `<>` nesting. */
function splitAngle(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of text) {
    if (ch === '<') depth += 1;
    else if (ch === '>') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

const UNBOX: Record<string, string> = { Integer: 'int', Double: 'double', Boolean: 'boolean', Character: 'char', Long: 'long' };
function unbox(t: string): string {
  return UNBOX[t] ?? t;
}

/** Bare class name of a Java type: `Order` (a trailing nullable comment is ignored), `List<Order>` -> `List`. */
export function classNameOf(javaType: string | undefined): string | undefined {
  if (!javaType) return undefined;
  const t = javaType.replace(/\/\*.*?\*\//g, '').trim().replace(/<.*$/, '').replace(/\[\]$/, '');
  return /^[A-Z]\w*$/.test(t) ? t : undefined;
}
