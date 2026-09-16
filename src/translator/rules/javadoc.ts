/**
 * Javadoc generation for the rules engine.
 *
 * Every class and method gets a Javadoc comment:
 *  - if the Python source has a docstring, its text becomes the Javadoc description;
 *  - otherwise a description is extrapolated from the class/method name.
 * Methods additionally get `@param`/`@return` tags, always extrapolated from the
 * Java signature (never from the docstring text, which is not parsed for sections).
 */

const BOOLISH_PREFIXES = new Set(['is', 'has', 'can', 'should']);

/** Whether a module (by its path) looks like Python test code, by common pytest/unittest conventions. */
export function isTestFile(relativePath: string): boolean {
  const segments = relativePath.split('/');
  const base = segments[segments.length - 1] ?? '';
  if (/^test_.*\.py$/.test(base) || /_test\.py$/.test(base) || base === 'conftest.py') return true;
  return segments.slice(0, -1).some((seg) => seg === 'test' || seg === 'tests');
}

/** Split a Python identifier (snake_case, camelCase, PascalCase, SCREAMING_SNAKE, dunder) into lowercase words. */
export function splitIdentifierWords(name: string): string[] {
  const cleaned = name.replace(/^_+|_+$/g, '');
  const words: string[] = [];
  for (const part of cleaned.split('_').filter(Boolean)) {
    const pieces = part.match(/[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+|\d+/g);
    words.push(...(pieces ?? [part]));
  }
  return words.map((w) => w.toLowerCase());
}

function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** Best-effort third-person singular present tense, for a leading verb ("fetch" -> "fetches"). */
function verbThirdPerson(word: string): string {
  if (/[sxz]$/.test(word) || /(ch|sh)$/.test(word)) return `${word}es`;
  if (/[^aeiou]y$/.test(word)) return `${word.slice(0, -1)}ies`;
  return `${word}s`;
}

/** One-line description for a class with no docstring, extrapolated from its name. */
export function describeClassSummary(name: string): string {
  const words = splitIdentifierWords(name);
  return words.length ? `${capitalize(words.join(' '))}.` : `${name}.`;
}

/** One-line description for a method with no docstring, extrapolated from its name/kind. */
export function describeMethodSummary(pythonName: string, isCtor: boolean, className: string | undefined, dunderDoc: string | undefined): string {
  if (dunderDoc) return dunderDoc;
  if (isCtor) return `Constructs a new ${className ?? 'instance'}.`;
  const words = splitIdentifierWords(pythonName);
  if (words.length === 0) return `${pythonName}.`;
  const [head, ...tail] = words;
  const rest = tail.join(' ');
  if (head === 'get') return `Returns the ${rest || 'value'}.`;
  if (head === 'set') return `Sets the ${rest || 'value'}.`;
  if (BOOLISH_PREFIXES.has(head)) return `Returns whether ${rest || 'this condition holds'}.`;
  if (head === 'to' && rest) return `Converts to ${rest}.`;
  return `${capitalize(verbThirdPerson(head))}${rest ? ` ${rest}` : ''}.`;
}

/** `@param` tag for a parameter, extrapolated from its (Python-cased) name. */
export function paramTag(name: string): string {
  const words = splitIdentifierWords(name);
  return `@param ${name} the ${words.length ? words.join(' ') : name}`;
}

/** `@return` tag for a method, extrapolated from its name and Java return type. Undefined when nothing is returned. */
export function returnTag(pythonName: string, javaReturnType: string, isCtor: boolean): string | undefined {
  if (isCtor) return undefined;
  const effective = javaReturnType.replace(/\/\*.*?\*\//g, '').trim();
  if (effective === '' || effective === 'void' || effective === 'CompletableFuture<Void>') return undefined;
  const words = splitIdentifierWords(pythonName);
  const [head, ...tail] = words;
  const rest = tail.join(' ');
  if (BOOLISH_PREFIXES.has(head) || effective === 'boolean') {
    return `@return true if ${rest || 'the condition holds'}, false otherwise`;
  }
  if (head === 'get' && rest) return `@return the ${rest}`;
  return '@return the result';
}

/** Render a Javadoc comment's lines (including the comment delimiters) from a description and tags. */
export function renderJavadoc(description: string[], paramTags: string[] = [], returnTagLine?: string): string[] {
  // A literal `*/` in a docstring (glob patterns, comment examples) would end the Javadoc early.
  const body: string[] = description.map((line) => line.replace(/\*\//g, '*&#47;'));
  const tags = returnTagLine ? [...paramTags, returnTagLine] : [...paramTags];
  if (tags.length) {
    if (body.length) body.push('');
    body.push(...tags);
  }
  if (body.length === 0) return [];
  if (body.length === 1) return [`/** ${body[0]} */`];
  const out = ['/**'];
  for (const line of body) out.push((line === '' ? ' *' : ` * ${line}`).replace(/\s+$/, ''));
  out.push(' */');
  return out;
}
