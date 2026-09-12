#!/usr/bin/env node
/**
 * Command-line entry point, useful without VS Code (CI, quick experiments).
 *
 *   pyrite <project-root> [--out .java-view] [--engine rules|llm] [--model claude-opus-5] [--effort low|medium|high]
 *   pyrite --file path/to/module.py            # print the Java view of one file to stdout
 */

import * as fs from 'fs';
import * as path from 'path';
import { createTranslator, EngineName } from './translator';
import { DEFAULT_EXCLUDES, mirrorProject } from './mirror';

interface Args {
  root?: string;
  file?: string;
  out: string;
  engine: EngineName;
  model?: string;
  effort?: 'low' | 'medium' | 'high';
  quiet: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { out: '.java-view', engine: 'rules', quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--out') args.out = next();
    else if (a === '--engine') args.engine = next() as EngineName;
    else if (a === '--model') args.model = next();
    else if (a === '--effort') args.effort = next() as Args['effort'];
    else if (a === '--file') args.file = next();
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
  pyrite <project-root> [--out .java-view] [--engine rules|llm] [--model <id>] [--effort low|medium|high] [--quiet]
  pyrite --file <module.py> [--engine rules|llm]

Environment:
  ANTHROPIC_API_KEY   API key for the llm engine.`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { translator, note } = createTranslator({ engine: args.engine, llm: { model: args.model, effort: args.effort } });
  if (note) console.error(`note: ${note}`);

  if (args.file) {
    const abs = path.resolve(args.file);
    const source = fs.readFileSync(abs, 'utf8');
    const result = await translator.translate({ source, relativePath: path.basename(abs) });
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
    onProgress: (rel, i, total) => {
      if (!args.quiet) console.error(`[${i + 1}/${total}] ${rel}`);
    },
  });
  for (const w of summary.warnings) console.error(`warning: ${w}`);
  console.error(`Wrote ${summary.files} file(s) to ${summary.outputRoot} using the ${summary.engine} engine.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
