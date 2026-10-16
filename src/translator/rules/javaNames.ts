/**
 * Python identifiers that are reserved words in Java (`new`, `default`, `abstract`, `char`,
 * `_`, ...) do not compile as Java names. They are renamed once, on the Python logical lines
 * before anything else reads them, so a declaration and all of its uses get the same name:
 *
 *   new = 1; default = new + 1   ->   int new_ = 1; var default_ = new_ + 1;
 *   a, _ = pair()                ->   (a, unused) = pair()
 *
 * `int`, `float` and `super` are left alone: Python code uses them as builtins and type hints
 * far more often than as variable names, and the translator gives those uses a Java meaning.
 * After a dot they can only be attributes (`value.int` -> `value.int_`).
 */

import { LogicalLine } from './logicalLines';
import { maskStrings, unmaskStrings } from './strings';

/** Java reserved words and literals that are legal Python identifiers. */
const JAVA_RESERVED = new Set([
  'abstract', 'boolean', 'byte', 'case', 'catch', 'char', 'const', 'default', 'do', 'double',
  'enum', 'extends', 'final', 'goto', 'implements', 'instanceof', 'interface', 'long', 'native',
  'new', 'package', 'private', 'protected', 'public', 'short', 'static', 'strictfp', 'switch',
  'synchronized', 'this', 'throw', 'throws', 'transient', 'void', 'volatile',
  'true', 'false', 'null', '_',
]);

/** The name `_` gets in Java (a lone underscore has been a keyword since Java 9). */
export const UNDERSCORE_NAME = 'unused';

/** Java-safe spelling of a Python identifier: `new` -> `new_`, `_` -> `unused`, others unchanged. */
export function javaSafeName(name: string): string {
  if (name === '_') return UNDERSCORE_NAME;
  return JAVA_RESERVED.has(name) ? `${name}_` : name;
}

const RESERVED_WORD = new RegExp(`(?<![\\w\\u0001])(${[...JAVA_RESERVED].filter((w) => w !== '_').join('|')}|_)(?![\\w\\u0001])`, 'g');

/** Whether position `at` of `code` is inside brackets (where `name=` is a keyword argument, not an assignment). */
function insideBrackets(code: string, at: number): boolean {
  let depth = 0;
  for (let i = 0; i < at; i += 1) {
    if ('([{'.includes(code[i])) depth += 1;
    else if (')]}'.includes(code[i])) depth -= 1;
  }
  return depth > 0;
}

/** `int` / `float` after a dot: an attribute (`value.int`), never the builtin. */
const PRIMITIVE_ATTRIBUTE = /(?<=\.\s*)(int|float)(?![\w\u0001])/g;

/** Rename reserved identifiers in the code part of one masked statement, except names in `keep`. */
function renameInCode(code: string, isBinding: boolean, isCase: boolean, keep: Set<string>): string {
  return code.replace(PRIMITIVE_ATTRIBUTE, '$1_').replace(RESERVED_WORD, (word: string, _w: string, offset: number, whole: string) => {
    if (keep.has(word)) return word;
    // `match` patterns: `case _:` and `case` itself are Python syntax, not names.
    if (isCase && (word === '_' || (word === 'case' && /^\s*$/.test(whole.slice(0, offset))))) return word;
    // A keyword argument in a call (`field(default=1)`) names the callee's parameter: the
    // translator reads some of them (dataclass `field(default=...)`), so leave them as written.
    if (!isBinding && /^\s*=(?!=)/.test(whole.slice(offset + word.length)) && /[(,]\s*$/.test(whole.slice(0, offset)) && insideBrackets(whole, offset)) return word;
    return javaSafeName(word);
  });
}

/** Root names bound by plain `import a.b, c` statements (`a`, `c`): references to external modules. */
function importedModuleNames(lines: LogicalLine[]): Set<string> {
  const names = new Set<string>();
  for (const l of lines) {
    const m = l.kind === 'code' ? /^import\s+(.+)$/.exec(l.text.trim()) : null;
    if (!m) continue;
    for (const part of m[1].split(',')) {
      const mod = /^\s*(\w+)[\w.]*\s*$/.exec(part);
      if (mod) names.add(mod[1]);
    }
  }
  return names;
}

/** An import statement split into the module path, kept as written, and the names it binds. */
function splitImport(code: string): { kept: string; names: string } | undefined {
  const from = /^(\s*from\s+[\w.]+\s+import\b)(.*)$/.exec(code);
  if (from) return { kept: from[1], names: from[2] };
  const plain = /^\s*import\b/.exec(code);
  // `import a.b as c`: only the aliases are names of this module.
  if (plain) return { kept: code, names: '' };
  return undefined;
}

/**
 * Rename Python identifiers that are Java reserved words, in place, on every code line.
 * Module paths in imports, and modules bound by `import x`, keep their names: they refer to
 * code outside this file (`from enum import Enum`, `enum.auto()`).
 */
export function renameJavaReservedIdentifiers(lines: LogicalLine[]): void {
  const keep = importedModuleNames(lines);
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i];
    if (l.kind !== 'code' || !/\b(?:_|[a-z]+)\b/.test(l.text)) continue;
    const masked = maskStrings(l.text);
    const hash = masked.text.indexOf('#');
    const code = hash < 0 ? masked.text : masked.text.slice(0, hash);
    const rest = hash < 0 ? '' : masked.text.slice(hash);
    const isBinding = /^\s*(?:async\s+)?def\s|^\s*lambda\b/.test(code) || /\blambda\b/.test(code);
    const isCase = /^\s*case\s/.test(code);
    const imp = splitImport(code);
    const renamed = imp
      ? imp.kept.replace(/\bas\s+(\w+)/g, (m: string, alias: string) => `as ${keep.has(alias) ? alias : javaSafeName(alias)}`) + renameInCode(imp.names, true, false, keep)
      : renameInCode(code, isBinding, isCase, keep);
    if (renamed !== code) lines[i] = { ...l, text: unmaskStrings(renamed + rest, masked.literals) };
  }
}
