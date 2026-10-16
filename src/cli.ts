#!/usr/bin/env node
/**
 * Command-line entry point, useful without VS Code (CI, quick experiments).
 *
 *   pyrite <project-root> [--out .java-view] [--package com.acme.shop]
 *   pyrite --file path/to/module.py            # print the Java view of one file to stdout
 */

import * as fs from 'fs';
import * as path from 'path';
import { basePackageFor, createTranslator, EngineName, JavadocMode, ollamaCacheFile } from './translator';
import { DEFAULT_EXCLUDES, mirrorProject } from './mirror';
import { InvalidJavaMode, applyParseGate } from './translator/parseGate';

const JAVADOC_MODES: JavadocMode[] = ['always', 'docstringOnly', 'none'];

interface Args {
  root?: string;
  file?: string;
  out: string;
  /** Base package; unset means the project folder's name. */
  basePackage?: string;
  engine: EngineName;
  ollamaUrl?: string;
  ollamaModel?: string;
  javaImports: boolean;
  javadoc: JavadocMode;
  javadocTestCode: boolean;
  lombok: boolean;
  lineWidth: number;
  invalidJava: InvalidJavaMode;
  quiet: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { out: '.java-view', engine: 'rules', javaImports: true, javadoc: 'docstringOnly', javadocTestCode: false, lombok: true, lineWidth: 120, invalidJava: 'stub', quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--out') args.out = next();
    else if (a === '--package') args.basePackage = next();
    else if (a === '--file') args.file = next();
    else if (a === '--engine') {
      const value = next();
      if (value !== 'rules' && value !== 'hybrid') {
        console.error(`Invalid --engine value: ${value} (expected rules or hybrid)`);
        process.exit(2);
      }
      args.engine = value;
    } else if (a === '--ollama-url') args.ollamaUrl = next();
    else if (a === '--ollama-model') args.ollamaModel = next();
    else if (a === '--no-java-imports') args.javaImports = false;
    else if (a === '--javadoc') {
      const value = next();
      if (!JAVADOC_MODES.includes(value as JavadocMode)) {
        console.error(`Invalid --javadoc value: ${value} (expected one of: ${JAVADOC_MODES.join(', ')})`);
        process.exit(2);
      }
      args.javadoc = value as JavadocMode;
    } else if (a === '--javadoc-test-code') args.javadocTestCode = true;
    else if (a === '--lombok') args.lombok = true;
    else if (a === '--no-lombok') args.lombok = false;
    else if (a === '--line-width') {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 0) {
        console.error('--line-width needs a whole number of columns (0 turns wrapping off)');
        process.exit(2);
      }
      args.lineWidth = n;
    }
    else if (a === '--invalid-java') {
      const value = argv[++i];
      if (value !== 'stub' && value !== 'keep') {
        console.error('--invalid-java must be stub or keep');
        process.exit(2);
      }
      args.invalidJava = value;
    }
    else if (a === '--quiet' || a === '-q') args.quiet = true;
    else if (a === '--help' || a === '-h') {
      printUsage();
      process.exit(0);
    } else if (!a.startsWith('-')) args.root = a;
    else {
      console.error(`Unknown option: ${a}`);
      printUsage();
      process.exit(2);
    }
  }
  return args;
}

function printUsage(): void {
  console.log(`Usage:
  pyrite <project-root> [--out .java-view] [--package com.acme.shop] [--javadoc always|docstringOnly|none] [--javadoc-test-code] [--no-lombok] [--line-width 120] [--invalid-java stub|keep] [--engine rules|hybrid] [--quiet]
  pyrite --file <module.py> [--package com.acme.shop] [--javadoc always|docstringOnly|none] [--javadoc-test-code] [--no-lombok] [--line-width 120] [--invalid-java stub|keep]

  --out <folder>        Output folder; laid out as a Java project (src/main/java, src/test/java).
  --package <name>      Package every view starts with (default: the project folder's name).
  --javadoc-test-code   Apply the same --javadoc rules to test code too (default: test code is never documented).
  --no-lombok           Spell out boilerplate instead of collapsing it to Lombok annotations (default: on).
  --line-width <n>      Wrap generated lines longer than n columns (default: 120, 0 = no wrapping).
  --invalid-java keep   Leave statements that are not valid Java as they are, only report them
                        (default: stub, replace each one with a TODO(pyrite) stub that parses).
  --engine hybrid       Also rewrite hard functions with a local Ollama model (--ollama-url, --ollama-model),
                        and replace the Python-shaped imports with real Java ones.
  --no-java-imports     With --engine hybrid: keep the rules engine's imports as they are.`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { translator, note } = createTranslator({
    engine: args.engine,
    ollama: { resolveImports: args.javaImports, ...(args.root && { cacheFile: ollamaCacheFile(path.resolve(args.root), args.out) }), ...(args.ollamaUrl && { url: args.ollamaUrl }), ...(args.ollamaModel && { model: args.ollamaModel }) },
  });
  if (note) console.error(`note: ${note}`);

  if (args.file) {
    const abs = path.resolve(args.file);
    const source = fs.readFileSync(abs, 'utf8');
    const translated = await translator.translate({ source, relativePath: path.basename(abs), javadocMode: args.javadoc, documentTestCode: args.javadocTestCode, lombokStyle: args.lombok, lineWidth: args.lineWidth, basePackage: args.basePackage && basePackageFor(args.basePackage) });
    const gate = await applyParseGate(translated, source, args.invalidJava, args.lineWidth);
    const result = gate.result;
    if (gate.stubbed) result.warnings.push(`${gate.stubbed} statement(s) were not valid Java and became TODO(pyrite) stubs`);
    if (gate.remaining) result.warnings.push(`${gate.remaining} line(s) are still not valid Java`);
    process.stdout.write(result.java);
    for (const w of result.warnings) console.error(`warning: ${w}`);
    return;
  }

  if (!args.root) {
    printUsage();
    process.exit(2);
  }
  const root = path.resolve(args.root);
  if (!fs.statSync(root).isDirectory()) {
    console.error(`Not a directory: ${root}`);
    process.exit(2);
  }
  const summary = await mirrorProject(translator, {
    root,
    outputFolder: args.out,
    basePackage: args.basePackage,
    exclude: DEFAULT_EXCLUDES,
    javadocMode: args.javadoc,
    documentTestCode: args.javadocTestCode,
    lombokStyle: args.lombok,
    lineWidth: args.lineWidth,
    invalidJava: args.invalidJava,
    onProgress: (rel, i, total) => {
      if (!args.quiet) console.error(`[${i + 1}/${total}] ${rel}`);
    },
  });
  for (const w of summary.warnings) console.error(`warning: ${w}`);
  const skipped = summary.skipped ? ` Skipped ${summary.skipped} __init__.py file(s) that only mark a package.` : '';
  console.error(`Wrote ${summary.files} file(s) to ${summary.outputRoot} using the ${summary.engine} engine.${skipped}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
