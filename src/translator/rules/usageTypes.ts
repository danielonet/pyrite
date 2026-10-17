/**
 * The type of an unhinted parameter, from how the function uses it (duck typing): a parameter
 * that is only ever appended to and indexed is a list, one that is only `split` and `strip`ped is
 * a string, one whose `items()` are walked is a dict.
 *
 *   def total(lines):              ->   total(List<Object> lines)
 *       lines.append(0); lines[0]
 *   def clean(text):               ->   clean(String text)
 *       return text.strip().lower()
 *
 * Every use must agree, and the parameter must not be assigned in the body (its type could
 * change); otherwise the answer is undefined and the parameter stays `Object`.
 */

type Kind = 'list' | 'str' | 'dict';

const METHODS: Record<Kind, Set<string>> = {
  list: new Set(['append', 'extend', 'insert', 'sort', 'reverse', 'remove']),
  str: new Set([
    'startswith', 'endswith', 'split', 'rsplit', 'splitlines', 'strip', 'lstrip', 'rstrip', 'lower', 'upper', 'casefold',
    'replace', 'encode', 'find', 'rfind', 'isdigit', 'isalpha', 'isalnum', 'isspace', 'islower', 'isupper', 'isidentifier',
    'partition', 'rpartition', 'zfill', 'center', 'ljust', 'rjust', 'title', 'capitalize', 'expandtabs', 'format', 'removeprefix',
    'removesuffix',
  ]),
  dict: new Set(['items', 'keys', 'values', 'setdefault', 'popitem']),
};

/** Methods every kind has (or that do not tell the kinds apart): neutral votes. */
const NEUTRAL = new Set(['copy', 'count', 'index', 'pop', 'clear', 'get', 'update']);

const JAVA_TYPE: Record<Kind, string> = { list: 'List<Object>', str: 'String', dict: 'Map<String, Object>' };

/** Java type of parameter `name` from its uses in the masked code lines of the function body, or undefined. */
export function typeFromUsage(name: string, codes: string[]): string | undefined {
  const votes = new Set<Kind>();
  const escaped = name.replace(/[$]/g, '\\$');
  const use = new RegExp(`(?<![\\w.\\u0001])${escaped}(?![\\w\\u0001])(\\s*(?:\\.\\s*(\\w+)\\s*(\\()?|\\[\\s*([^\\]]*)\\]))?`, 'g');
  for (const code of codes) {
    // Assigned (or rebound by a loop / with) in the body: its type may change.
    if (new RegExp(`(?:^|[,(]\\s*)${escaped}\\s*(?:[-+*/%|&^]|//|\\*\\*)?=(?!=)|\\bfor\\s+[\\w\\s,()]*\\b${escaped}\\b[\\w\\s,()]*\\s+in\\b|\\bas\\s+${escaped}\\b`).test(code)) return undefined;
    for (const m of code.matchAll(use)) {
      const [, , method, call, subscript] = m;
      if (method !== undefined) {
        // An attribute (not a call), or a method no kind owns: some other object.
        if (!call) return undefined;
        if (NEUTRAL.has(method)) continue;
        const kind = (Object.keys(METHODS) as Kind[]).find((k) => METHODS[k].has(method));
        if (!kind) return undefined;
        votes.add(kind);
      } else if (subscript !== undefined) {
        const key = subscript.trim();
        // A string key is a dict; an integer index a list (a slice could be a str too).
        if (/^\u0001\d+\u0001$/.test(key)) votes.add('dict');
        else if (/^-?\d+$/.test(key)) votes.add('list');
      }
    }
  }
  return votes.size === 1 ? JAVA_TYPE[[...votes][0]] : undefined;
}
