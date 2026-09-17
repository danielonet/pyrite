/**
 * Real Python parsing via tree-sitter (WebAssembly, offline, no Python installation needed).
 *
 * Today this is a checker beside the rules engine, not its front end:
 *  - `checkSyntax` finds syntax errors so a broken file is flagged instead of silently
 *    producing a garbled view;
 *  - `definitions` lists the classes and functions a module declares, which the corpus
 *    test uses as an oracle against the symbols the rules engine emitted.
 *
 * See architecture/tree-sitter.md for the plan to move the translator's front end onto it.
 * Every entry point degrades to "no information" when the WebAssembly runtime cannot be
 * loaded, so a packaging problem never breaks translation.
 */

import * as path from 'path';
import type { Node, Parser as ParserType, Tree } from 'web-tree-sitter';

export interface SyntaxIssue {
  /** 1-based line. */
  line: number;
  /** 0-based column. */
  column: number;
  message: string;
}

export interface Definition {
  kind: 'class' | 'function';
  name: string;
  /** 1-based line of the `class`/`def` keyword. */
  line: number;
  /** Enclosing class names, outermost first. */
  container: string[];
}

let parserPromise: Promise<ParserType | undefined> | undefined;

/** The shared parser, or undefined when the runtime is unavailable. Loaded once, lazily. */
export function pythonParser(): Promise<ParserType | undefined> {
  if (!parserPromise) {
    parserPromise = (async () => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { Parser, Language } = require('web-tree-sitter') as typeof import('web-tree-sitter');
        await Parser.init();
        const grammar = path.join(path.dirname(require.resolve('tree-sitter-python/package.json')), 'tree-sitter-python.wasm');
        const language = await Language.load(grammar);
        const parser = new Parser();
        parser.setLanguage(language);
        return parser;
      } catch {
        return undefined;
      }
    })();
  }
  return parserPromise;
}

/** Parse a module; undefined when the runtime is unavailable. */
export async function parsePython(source: string): Promise<Tree | undefined> {
  const parser = await pythonParser();
  return parser?.parse(source) ?? undefined;
}

const MAX_ISSUES = 20;

/** Syntax errors in a tree (missing or unexpected tokens), first `MAX_ISSUES` only. */
export function syntaxIssues(tree: Tree): SyntaxIssue[] {
  const issues: SyntaxIssue[] = [];
  if (!tree.rootNode.hasError) return issues;
  const visit = (node: Node): void => {
    if (issues.length >= MAX_ISSUES) return;
    if (node.isError) {
      const snippet = node.text.split('\n')[0].slice(0, 40);
      issues.push({ line: node.startPosition.row + 1, column: node.startPosition.column, message: `unexpected ${JSON.stringify(snippet)}` });
      return;
    }
    if (node.isMissing) {
      issues.push({ line: node.startPosition.row + 1, column: node.startPosition.column, message: `missing ${node.type}` });
      return;
    }
    if (!node.hasError) return;
    for (const child of node.children) if (child) visit(child);
  };
  visit(tree.rootNode);
  return issues;
}

/** Syntax errors in a source text; empty when the file parses or the runtime is unavailable. */
export async function checkSyntax(source: string): Promise<SyntaxIssue[]> {
  const tree = await parsePython(source);
  if (!tree) return [];
  try {
    return syntaxIssues(tree);
  } finally {
    tree.delete();
  }
}

/** Classes and functions declared at module level or directly in a class body (not inside functions). */
export function definitions(tree: Tree): Definition[] {
  const out: Definition[] = [];
  const visitBlock = (block: Node, container: string[]): void => {
    for (const child of block.children) {
      if (!child) continue;
      visitStatement(child, container);
    }
  };
  const visitStatement = (node: Node, container: string[]): void => {
    switch (node.type) {
      case 'decorated_definition': {
        const inner = node.childForFieldName('definition');
        if (inner) visitStatement(inner, container);
        return;
      }
      case 'class_definition': {
        const name = node.childForFieldName('name')?.text;
        if (!name) return;
        out.push({ kind: 'class', name, line: node.startPosition.row + 1, container });
        const body = node.childForFieldName('body');
        if (body) visitBlock(body, [...container, name]);
        return;
      }
      case 'function_definition': {
        const name = node.childForFieldName('name')?.text;
        if (name) out.push({ kind: 'function', name, line: node.startPosition.row + 1, container });
        return; // nested definitions are local to the function
      }
      // Definitions under module-level control flow (if TYPE_CHECKING:, try/except ImportError) still count.
      case 'if_statement':
      case 'elif_clause':
      case 'else_clause':
      case 'try_statement':
      case 'except_clause':
      case 'finally_clause':
      case 'with_statement':
      case 'for_statement':
      case 'while_statement': {
        for (const child of node.children) {
          if (!child) continue;
          if (child.type === 'block') visitBlock(child, container);
          else if (/_clause$/.test(child.type)) visitStatement(child, container);
        }
        return;
      }
      default:
        return;
    }
  };
  visitBlock(tree.rootNode, []);
  return out;
}
