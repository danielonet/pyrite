#!/usr/bin/env node
// How far the rules engine's Java views are from compiling, on a folder of Python files
// (for example the standard library: `node scripts/measure-java.js /usr/lib/python3.12 --javac`).
// Run `npm run compile` first: this reads the compiled translator from out/.
//
//  1. Parse level: every file is translated and run through the parse gate; reports how many
//     files need no stub, and the stubs (`TODO(pyrite)`) the gate wrote.
//  2. With --javac: the gated files that parse are compiled together (one package per module,
//     so generated classes cannot shadow each other) and the errors are grouped by cause.
//     Needs `javac` on PATH. Attribution runs despite earlier errors (-XDshould-stop.at=FLOW).
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const out = path.join(__dirname, '..', 'out');
const { translateWithRules } = require(path.join(out, 'translator', 'rules', 'ruleTranslator'));
const { applyParseGate } = require(path.join(out, 'translator', 'parseGate'));

const args = process.argv.slice(2);
const root = args.find((a) => !a.startsWith('--'));
const withJavac = args.includes('--javac');
if (!root) {
  console.error('usage: node scripts/measure-java.js <folder of .py files> [--javac]');
  process.exit(2);
}

/** javac errors grouped by what would fix them, checked in this order. */
function causeOf(msg, extra, modules) {
  const sym = /symbol:\s+(class|variable|method)\s+(\w+)/.exec(extra);
  const loc = /location:\s+(.*)/.exec(extra);
  if (/expected$|illegal escape|illegal start|<identifier>|not a statement|unclosed|varargs parameter must be the last|illegal character/.test(msg)) return 'syntax javac rejects (the parse gate accepted it)';
  if (sym && ['Tuple', 'Py', 'Property', 'Setter'].includes(sym[2])) return 'runtime library (Tuple, Py, @Property)';
  if (/^package \S+ does not exist$/.test(msg) || (sym && sym[1] !== 'method' && modules.has(sym[2]))) return 'Python module reference (os.path, sys.argv, ...)';
  if (/exception/.test(msg) && /unreported|never thrown/.test(msg)) return 'checked exceptions';
  if (/cannot be converted to boolean|for unary operator '!'/.test(msg)) return 'truthiness (if x / not x on non-booleans)';
  if (sym && sym[1] === 'method' && loc && /of type Object\b|class Object\b/.test(loc[1])) return 'method called on Object (untyped value)';
  if (/bad operand type|Object cannot be converted|for-each not applicable|incompatible types/.test(msg)) return 'types (Object / mismatches)';
  if (sym && sym[1] === 'method') return 'unknown method (Python API on a Java type, undefined function)';
  if (sym && sym[1] === 'variable') return 'unknown name (undeclared local, Python builtin, module global)';
  if (sym && sym[1] === 'class') return 'unknown class';
  if (/static context/.test(msg)) return 'static context';
  if (/cannot be applied to given types|no suitable/.test(msg)) return 'call arity / overload (keyword arguments, defaults)';
  return `other: ${msg.replace(/'[^']*'/g, "'_'").slice(0, 60)}`;
}

/** Names of Python modules (to tell `os.path` from an undeclared local `path`). */
function pythonModules() {
  const names = new Set(fs.readdirSync(root).map((f) => f.replace(/\.py$/, '')));
  const py = spawnSync('python3', ['-I', '-c', 'import sys,pkgutil;print("\\n".join(set(sys.builtin_module_names)|{m.name for m in pkgutil.iter_modules()}))'], { encoding: 'utf8' });
  if (py.status === 0) for (const n of py.stdout.split('\n')) if (n) names.add(n);
  return names;
}

(async () => {
  const files = fs.readdirSync(root).filter((f) => f.endsWith('.py')).sort();
  const dir = withJavac ? fs.mkdtempSync(path.join(os.tmpdir(), 'pyrite-javac-')) : '';
  const javaFiles = [];
  let noStub = 0;
  let parses = 0;
  let stubs = 0;
  for (const f of files) {
    const source = fs.readFileSync(path.join(root, f), 'utf8');
    let result;
    try {
      result = translateWithRules({ source, relativePath: f });
    } catch (err) {
      console.error(`${f}: translator error: ${err.message}`);
      continue;
    }
    const gate = await applyParseGate(result, source, 'stub', 0);
    if (gate.stubbed === 0 && gate.remaining === 0) noStub += 1;
    if (gate.remaining > 0) continue;
    parses += 1;
    stubs += (gate.result.java.match(/TODO\(pyrite\)/g) ?? []).length;
    if (!withJavac) continue;
    const pkg = `py_${f.replace(/\.py$/, '').replace(/\W/g, '_')}`;
    const cls = /public (?:final )?(?:class|interface|enum|record) (\w+)/.exec(gate.result.java)?.[1] ?? pkg;
    const file = path.join(dir, pkg, `${cls}.java`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, gate.result.java.replace(/^package [\w.]+;\n|^(?=import |public |final |class |interface |enum |@)/m, `package ${pkg};\n`));
    javaFiles.push(file);
  }
  console.log(`${files.length} files: ${noStub} need no stub, ${parses} parse after the gate, ${stubs} stubs`);
  if (!withJavac) return;

  // Pyrite's runtime library, which the views import (pyrite.runtime.Py, Tuple, ...).
  const runtime = path.join(__dirname, '..', 'runtime', 'src', 'main', 'java', 'pyrite', 'runtime');
  const runtimeFiles = fs.readdirSync(runtime).filter((f) => f.endsWith('.java')).map((f) => path.join(runtime, f));
  fs.writeFileSync(path.join(dir, 'files.txt'), [...javaFiles, ...runtimeFiles].join('\n'));
  const classes = path.join(dir, 'classes');
  fs.mkdirSync(classes);
  const javac = spawnSync('javac', ['-proc:none', '-implicit:none', '-nowarn', '-encoding', 'UTF-8', '-Xmaxerrs', '1000000', '-XDshould-stop.ifError=FLOW', '-XDshould-stop.at=FLOW', '-d', classes, `@${path.join(dir, 'files.txt')}`], { encoding: 'utf8', maxBuffer: 1 << 30 });
  if (javac.error) {
    console.error(`javac did not run: ${javac.error.message}`);
    process.exit(1);
  }
  const lines = (javac.stderr + javac.stdout).split('\n');
  const modules = pythonModules();
  const counts = new Map();
  const failing = new Set();
  let total = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^(.*\.java):\d+: error: (.*)$/.exec(lines[i]);
    if (!m) continue;
    let extra = '';
    for (let j = i + 1; j < lines.length && !/\.java:\d+: error:/.test(lines[j]); j += 1) extra += `${lines[j]}\n`;
    const cause = causeOf(m[2], extra, modules);
    counts.set(cause, (counts.get(cause) ?? 0) + 1);
    failing.add(m[1]);
    total += 1;
  }
  console.log(`javac: ${total} errors in ${failing.size} of ${javaFiles.length} files`);
  for (const [cause, n] of [...counts].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
    console.log(`${String(n).padStart(7)} ${((n / total) * 100).toFixed(1).padStart(5)}%  ${cause}`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
})();
