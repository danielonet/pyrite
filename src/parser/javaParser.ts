/**
 * Java parsing via tree-sitter, for the parse gate (see translator/parseGate.ts): it finds the
 * generated lines that are not valid Java. Degrades to "no information" like the Python parser.
 */

import type { Node, Parser as ParserType } from 'web-tree-sitter';
import { loadParser } from './treeSitter';

let parserPromise: Promise<ParserType | undefined> | undefined;

/** The shared Java parser, or undefined when the runtime is unavailable. Loaded once, lazily. */
export function javaParser(): Promise<ParserType | undefined> {
  if (!parserPromise) parserPromise = loadParser('tree-sitter-java', 'tree-sitter-java.wasm');
  return parserPromise;
}

/**
 * 0-based rows where the Java text has a syntax error (an unexpected or a missing token), in
 * order, without duplicates. Undefined when the parser is unavailable; empty when the text parses.
 */
export async function javaErrorRows(java: string): Promise<number[] | undefined> {
  const parser = await javaParser();
  const tree = parser?.parse(java);
  if (!tree) return undefined;
  try {
    const rows = new Set<number>();
    const visit = (node: Node): void => {
      if (node.isError || node.isMissing) rows.add(node.startPosition.row);
      if (!node.hasError) return;
      for (const child of node.children) if (child) visit(child);
    };
    if (tree.rootNode.hasError) visit(tree.rootNode);
    return [...rows].sort((a, b) => a - b);
  } finally {
    tree.delete();
  }
}
