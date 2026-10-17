/**
 * Python standard-library modules with a Java counterpart for translated code. `os`, `sys`, `re`,
 * `warnings` and `time` map to classes of Pyrite's runtime library (`runtime/`), named after the
 * module (`os.path.join(a, b)` -> `Os.path.join(a, b)`); `math` maps to `java.lang.Math`.
 *
 * Only the members listed here are rewritten: anything else keeps its Python spelling, so what
 * has no counterpart yet stays visible instead of turning into a call that does not exist.
 */

import { RUNTIME_PACKAGE } from './runtimePackage';

export interface RuntimeModule {
  /** Java class, relative to the runtime package (`Os.path` is a nested class). */
  javaClass: string;
  /** Members the runtime class implements, under their Python names. */
  members: Set<string>;
}

const names = (text: string): Set<string> => new Set(text.split(/\s+/).filter(Boolean));

export const RUNTIME_MODULES: Record<string, RuntimeModule> = {
  os: {
    javaClass: 'Os',
    members: names(`environ name sep altsep pathsep linesep curdir pardir extsep devnull fspath getenv getcwd listdir
      mkdir makedirs remove unlink rmdir rename replace getpid cpu_count urandom`),
  },
  'os.path': {
    javaClass: 'Os.path',
    members: names(`join exists lexists isdir isfile islink isabs basename dirname split splitext abspath normpath
      normcase realpath relpath expanduser getsize getmtime`),
  },
  sys: {
    javaClass: 'Sys',
    members: names(`argv path modules platform maxsize byteorder stdout stderr stdin exit audit getrecursionlimit
      getdefaultencoding getfilesystemencoding intern`),
  },
  re: {
    javaClass: 'Re',
    members: names('A ASCII I IGNORECASE L LOCALE M MULTILINE S DOTALL U UNICODE X VERBOSE compile match fullmatch search findall finditer sub split escape purge'),
  },
  warnings: { javaClass: 'Warnings', members: names('warn simplefilter filterwarnings catch_warnings') },
  time: { javaClass: 'Time', members: names('time time_ns monotonic perf_counter perf_counter_ns sleep') },
};

/** Runtime classes for module references, for the import resolver. */
export const RUNTIME_MODULE_CLASSES = new Set(Object.values(RUNTIME_MODULES).map((m) => m.javaClass.split('.')[0]));

/**
 * `math` members as Java expressions; `$1`, `$2` are the call's arguments. Where Python and
 * Java differ (`floor` returns an int, `log` takes a base), the template says so.
 */
export const MATH_MEMBERS: Record<string, string> = {
  pi: 'Math.PI',
  e: 'Math.E',
  tau: '(2 * Math.PI)',
  inf: 'Double.POSITIVE_INFINITY',
  nan: 'Double.NaN',
  sqrt: 'Math.sqrt($1)',
  exp: 'Math.exp($1)',
  sin: 'Math.sin($1)',
  cos: 'Math.cos($1)',
  tan: 'Math.tan($1)',
  asin: 'Math.asin($1)',
  acos: 'Math.acos($1)',
  atan: 'Math.atan($1)',
  atan2: 'Math.atan2($1, $2)',
  hypot: 'Math.hypot($1, $2)',
  pow: 'Math.pow($1, $2)',
  fabs: 'Math.abs($1)',
  floor: '(long) Math.floor($1)',
  ceil: '(long) Math.ceil($1)',
  trunc: '(long) ($1)',
  log10: 'Math.log10($1)',
  log2: '(Math.log($1) / Math.log(2))',
  log1p: 'Math.log1p($1)',
  expm1: 'Math.expm1($1)',
  degrees: 'Math.toDegrees($1)',
  radians: 'Math.toRadians($1)',
  copysign: 'Math.copySign($1, $2)',
  isnan: 'Double.isNaN($1)',
  isinf: 'Double.isInfinite($1)',
  isfinite: 'Double.isFinite($1)',
};

/** `math.log(x)` / `math.log(x, base)`. */
export function mathLog(args: string[]): string {
  return args.length > 1 ? `(Math.log(${args[0]}) / Math.log(${args[1]}))` : `Math.log(${args[0] ?? ''})`;
}

/**
 * The Java import for a Python `from <module> import <name>` target (`os.path.join`), when the
 * runtime has it: a module is a class import, a member a static import. Undefined otherwise.
 */
export function runtimeImportFor(target: string): { fqn: string; isStatic: boolean } | undefined {
  const mod = RUNTIME_MODULES[target];
  if (mod) return { fqn: `${RUNTIME_PACKAGE}.${mod.javaClass}`, isStatic: false };
  const dot = target.lastIndexOf('.');
  const owner = RUNTIME_MODULES[target.slice(0, dot)];
  const member = target.slice(dot + 1);
  if (owner?.members.has(member)) return { fqn: `${RUNTIME_PACKAGE}.${owner.javaClass}.${member}`, isStatic: true };
  return undefined;
}
