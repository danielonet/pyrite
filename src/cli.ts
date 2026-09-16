#!/usr/bin/env node
/**
 * Command-line entry point, useful without VS Code (CI, quick experiments).
 *
 *   pyrite <project-root> [--out .java-view]
 *   pyrite --file path/to/module.py            # print the Java view of one file to stdout
 */

import * as fs from 'fs';
import * as path from 'path';
import { createTranslator, EngineName, JavadocMode } from './translator';
import { DEFAULT_EXCLUDES, mirrorProject } from './mirror';

const JAVADOC_MODES: JavadocMode[] = ['always', 'docstringOnly', 'none'];

interface Args {
  root?: string;
  file?: string;
  out: string;
  engine: EngineName;
  javadoc: JavadocMode;
  javadocTestCode: boolean;
  lombok: boolean;
  quiet: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { out: '.java-view', engine: 'rules', javadoc: 'docstringOnly', javadocTestCode: false, lombok: true, quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--out') args.out = next();
    else if (a === '--file') args.file = next();
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
  pyrite <project-root> [--out .java-view] [--javadoc always|docstringOnly|none] [--javadoc-test-code] [--no-lombok] [--quiet]
  pyrite --file <module.py> [--javadoc always|docstringOnly|none] [--javadoc-test-code] [--no-lombok]

  --javadoc-test-code   Apply the same --javadoc rules to test code too (default: test code is never documented).
  --no-lombok           Spell out boilerplate instead of collapsing it to Lombok annotations (default: on).`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { translator, note } = createTranslator({ engine: args.engine });
  if (note) console.error(`note: ${note}`);

  if (args.file) {
    const abs = path.resolve(args.file);
    const source = fs.readFileSync(abs, 'utf8');
    const result = await translator.translate({ source, relativePath: path.basename(abs), javadocMode: args.javadoc, documentTestCode: args.javadocTestCode, lombokStyle: args.lombok });
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
    exclude: DEFAULT_EXCLUDES,
    javadocMode: args.javadoc,
    documentTestCode: args.javadocTestCode,
    lombokStyle: args.lombok,
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
