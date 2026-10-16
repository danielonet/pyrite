/**
 * Shared tree-sitter (WebAssembly) loading: the runtime is initialized once, then each grammar
 * is loaded from its npm package's `.wasm` file. Every loader resolves to undefined when the
 * runtime or the grammar cannot be loaded, so a packaging problem never breaks translation.
 */

import * as path from 'path';
import type { Parser as ParserType } from 'web-tree-sitter';

let runtime: Promise<typeof import('web-tree-sitter') | undefined> | undefined;

function treeSitterRuntime(): Promise<typeof import('web-tree-sitter') | undefined> {
  if (!runtime) {
    runtime = (async () => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const ts = require('web-tree-sitter') as typeof import('web-tree-sitter');
        await ts.Parser.init();
        return ts;
      } catch {
        return undefined;
      }
    })();
  }
  return runtime;
}

/** A parser for the grammar in `<grammarPackage>/<wasmFile>`, or undefined when it cannot be loaded. */
export async function loadParser(grammarPackage: string, wasmFile: string): Promise<ParserType | undefined> {
  const ts = await treeSitterRuntime();
  if (!ts) return undefined;
  try {
    const grammar = path.join(path.dirname(require.resolve(`${grammarPackage}/package.json`)), wasmFile);
    const language = await ts.Language.load(grammar);
    const parser = new ts.Parser();
    parser.setLanguage(language);
    return parser;
  } catch {
    return undefined;
  }
}
