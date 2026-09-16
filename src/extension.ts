/**
 * VS Code entry point for Pyrite.
 *
 * Commands
 *   pyrite.generateView        translate every Python file in the workspace into <outputFolder>/
 *   pyrite.translateCurrentFile translate only the active Python file
 *   pyrite.openJavaView        jump from a Python file/line to the matching Java view line
 *   pyrite.goToPythonSource    jump from a Java view line back to the Python source line
 *   pyrite.clearView           delete the generated folder
 *
 * A file watcher keeps the view in sync on save (setting pyrite.watch). A
 * DefinitionProvider also gives the Java view its own "Go to Definition"
 * (F12 / Ctrl+Click / right-click), resolved against the sidecar symbol
 * index built by mirror.ts (see definitionIndex.ts) rather than Python.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { createTranslator, EngineName, JavadocMode, Translator } from './translator';
import { javaLineFor, javaPathFor, mirrorFile, pythonLineFor, readSourceMap, removeMirroredFile, isExcluded } from './mirror';
import { runMirrorInBackground } from './backgroundMirror';
import { buildSymbolIndex, resolveDefinition } from './definitionIndex';
import { PyriteAboutViewProvider } from './aboutView';

let output: vscode.OutputChannel;
let statusItem: vscode.StatusBarItem;

interface Settings {
  engine: EngineName;
  outputFolder: string;
  exclude: string[];
  watch: boolean;
  javadoc: JavadocMode;
  javadocTestCode: boolean;
  lombok: boolean;
}

function settings(): Settings {
  const cfg = vscode.workspace.getConfiguration('pyrite');
  return {
    engine: cfg.get<EngineName>('engine', 'rules'),
    outputFolder: cfg.get<string>('outputFolder', '.java-view'),
    exclude: cfg.get<string[]>('exclude', []),
    watch: cfg.get<boolean>('watch', true),
    javadoc: cfg.get<JavadocMode>('javadoc', 'docstringOnly'),
    javadocTestCode: cfg.get<boolean>('javadocTestCode', false),
    lombok: cfg.get<boolean>('lombok', true),
  };
}

function buildTranslator(): Translator {
  const s = settings();
  const { translator, note } = createTranslator({ engine: s.engine });
  if (note) {
    output.appendLine(note);
    void vscode.window.showWarningMessage(note);
  }
  return translator;
}

/** Workspace folder that contains the given file, or the first workspace folder. */
function rootFor(uri?: vscode.Uri): vscode.WorkspaceFolder | undefined {
  if (uri) {
    const wf = vscode.workspace.getWorkspaceFolder(uri);
    if (wf) return wf;
  }
  return vscode.workspace.workspaceFolders?.[0];
}

function relPath(root: vscode.WorkspaceFolder, abs: string): string {
  return path.relative(root.uri.fsPath, abs).split(path.sep).join('/');
}

function isInsideOutput(root: vscode.WorkspaceFolder, abs: string): boolean {
  const out = path.join(root.uri.fsPath, settings().outputFolder);
  const rel = path.relative(out, abs);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

async function generateView(folderUri?: vscode.Uri): Promise<void> {
  const root = rootFor(folderUri);
  if (!root) {
    void vscode.window.showErrorMessage('Pyrite: open a folder first.');
    return;
  }
  const s = settings();
  const scopeRoot = folderUri && fs.statSync(folderUri.fsPath).isDirectory() ? folderUri.fsPath : root.uri.fsPath;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Pyrite: generating Java view', cancellable: true },
    async (progress, token) => {
      const started = Date.now();
      // The translation runs on a worker thread so a large project never freezes the extension host;
      // this thread only relays progress (at most every 100 ms) and the Cancel button.
      let reported = 0;
      const run = runMirrorInBackground(
        {
          engine: s.engine,
          options: {
            root: root.uri.fsPath,
            outputFolder: s.outputFolder,
            exclude: [...s.exclude, ...(scopeRoot !== root.uri.fsPath ? [] : [])],
            javadocMode: s.javadoc,
            documentTestCode: s.javadocTestCode,
            lombokStyle: s.lombok,
          },
        },
        (rel, i, total) => {
          if (scopeRoot !== root.uri.fsPath && !path.join(root.uri.fsPath, rel).startsWith(scopeRoot)) return;
          const percent = ((i + 1) / Math.max(total, 1)) * 100;
          progress.report({ message: `${i + 1}/${total} ${rel}`, increment: percent - reported });
          reported = percent;
        },
      );
      const cancelListener = token.onCancellationRequested(() => run.cancel());
      let summary;
      try {
        summary = await run.result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        output.appendLine(`error: generating the Java view failed: ${msg}`);
        void vscode.window.showErrorMessage(`Pyrite: generating the Java view failed: ${msg}`);
        return;
      } finally {
        cancelListener.dispose();
      }
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      output.appendLine(`Generated ${summary.files} file(s) in ${summary.outputRoot} (${summary.engine} engine, ${secs}s${summary.skipped ? `, ${summary.skipped} package-marker __init__.py skipped` : ''}).`);
      for (const w of summary.warnings) output.appendLine(`  warning: ${w}`);
      const msg =
        (summary.cancelled ? `Pyrite: cancelled after ${summary.files} file(s) translated to ${s.outputFolder}/` : `Pyrite: ${summary.files} file(s) translated to ${s.outputFolder}/ (${summary.engine} engine)`) +
        (summary.warnings.length ? `, ${summary.warnings.length} warning(s)` : '');
      const pick = await vscode.window.showInformationMessage(msg, 'Open folder', summary.warnings.length ? 'Show warnings' : 'OK');
      if (pick === 'Open folder') {
        await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(summary.outputRoot));
      } else if (pick === 'Show warnings') {
        output.show(true);
      }
    },
  );
}

async function translateOne(pyUri: vscode.Uri, reveal: boolean, quiet = false): Promise<vscode.Uri | undefined> {
  const root = rootFor(pyUri);
  if (!root) return undefined;
  if (isInsideOutput(root, pyUri.fsPath)) return undefined;
  const s = settings();
  const rel = relPath(root, pyUri.fsPath);
  if (isExcluded(rel, s.exclude)) return undefined;
  const translator = buildTranslator();
  statusItem.text = '$(sync~spin) Pyrite';
  statusItem.show();
  try {
    const outcome = await mirrorFile(translator, root.uri.fsPath, rel, { outputFolder: s.outputFolder, javadocMode: s.javadoc, documentTestCode: s.javadocTestCode, lombokStyle: s.lombok });
    if (outcome.skipped) {
      // Only tell the user when they asked for this file explicitly, not on every watched save.
      if (!quiet) void vscode.window.showInformationMessage(`Pyrite: ${rel} only marks a Python package (Java packages are plain folders), so it has no Java view.`);
      return undefined;
    }
    const { javaAbs, result } = outcome;
    for (const w of result.warnings) output.appendLine(`warning: ${w}`);
    const javaUri = vscode.Uri.file(javaAbs);
    if (reveal) {
      await vscode.window.showTextDocument(javaUri, { preview: false, viewColumn: vscode.ViewColumn.Beside });
    }
    return javaUri;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    output.appendLine(`error: ${rel}: ${msg}`);
    void vscode.window.showErrorMessage(`Pyrite: failed to translate ${rel}: ${msg}`);
    return undefined;
  } finally {
    statusItem.text = '$(file-code) Pyrite';
  }
}

async function openJavaView(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'python') {
    void vscode.window.showInformationMessage('Pyrite: open a Python file first.');
    return;
  }
  const root = rootFor(editor.document.uri);
  if (!root) return;
  if (editor.document.isDirty) await editor.document.save();
  const s = settings();
  const rel = relPath(root, editor.document.uri.fsPath);
  const javaAbs = path.join(root.uri.fsPath, s.outputFolder, javaPathFor(rel));
  const javaUri = fs.existsSync(javaAbs) ? vscode.Uri.file(javaAbs) : await translateOne(editor.document.uri, false);
  if (!javaUri) return;
  const map = readSourceMap(root.uri.fsPath, javaUri.fsPath, s.outputFolder);
  const line = map ? javaLineFor(map, editor.selection.active.line + 1) : 0;
  const target = await vscode.window.showTextDocument(javaUri, { preview: false, viewColumn: vscode.ViewColumn.Beside, preserveFocus: false });
  const pos = new vscode.Position(line, 0);
  target.selection = new vscode.Selection(pos, pos);
  target.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
}

async function goToPythonSource(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const root = rootFor(editor.document.uri);
  if (!root) return;
  const s = settings();
  const map = readSourceMap(root.uri.fsPath, editor.document.uri.fsPath, s.outputFolder);
  if (!map) {
    void vscode.window.showInformationMessage('Pyrite: this file is not a generated Java view (no source map found).');
    return;
  }
  const pyAbs = path.join(root.uri.fsPath, map.python);
  if (!fs.existsSync(pyAbs)) {
    void vscode.window.showWarningMessage(`Pyrite: Python source not found: ${map.python}`);
    return;
  }
  const line = Math.max(0, pythonLineFor(map, editor.selection.active.line) - 1);
  const doc = await vscode.workspace.openTextDocument(pyAbs);
  const target = await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.One });
  const pos = new vscode.Position(Math.min(line, doc.lineCount - 1), 0);
  target.selection = new vscode.Selection(pos, pos);
  target.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
}

/**
 * "Go to Definition" inside the generated Java view: resolves the identifier under the
 * cursor (a class, method or field name) against the project-wide symbol index and jumps
 * to where it's declared, in whichever mirrored file that is. Only active inside the
 * output folder - real Java projects elsewhere in the workspace are left to their own
 * definition provider.
 */
class PyriteDefinitionProvider implements vscode.DefinitionProvider {
  provideDefinition(document: vscode.TextDocument, position: vscode.Position): vscode.Location[] | undefined {
    const root = rootFor(document.uri);
    if (!root || !isInsideOutput(root, document.uri.fsPath)) return undefined;
    const range = document.getWordRangeAtPosition(position);
    if (!range) return undefined;
    const word = document.getText(range);
    const s = settings();
    const fromFile = relPath(root, document.uri.fsPath);
    const index = buildSymbolIndex(root.uri.fsPath, s.outputFolder);
    const matches = resolveDefinition(index, word, fromFile, position.line);
    if (!matches.length) return undefined;
    return matches.map((m) => new vscode.Location(vscode.Uri.file(path.join(root.uri.fsPath, m.javaFile)), new vscode.Position(m.javaLine, 0)));
  }
}

async function clearView(): Promise<void> {
  const root = rootFor();
  if (!root) return;
  const s = settings();
  const out = path.join(root.uri.fsPath, s.outputFolder);
  if (!fs.existsSync(out)) {
    void vscode.window.showInformationMessage(`Pyrite: nothing to delete (${s.outputFolder}/ does not exist).`);
    return;
  }
  const pick = await vscode.window.showWarningMessage(`Delete the generated folder ${s.outputFolder}/?`, { modal: true }, 'Delete');
  if (pick !== 'Delete') return;
  fs.rmSync(out, { recursive: true, force: true });
  void vscode.window.showInformationMessage(`Pyrite: deleted ${s.outputFolder}/.`);
}

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('Pyrite');
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
  statusItem.text = '$(file-code) Pyrite';
  statusItem.tooltip = 'Pyrite: generate the Java view of this workspace';
  statusItem.command = 'pyrite.generateView';
  statusItem.show();

  context.subscriptions.push(
    output,
    statusItem,
    vscode.commands.registerCommand('pyrite.generateView', (uri?: vscode.Uri) => generateView(uri)),
    vscode.commands.registerCommand('pyrite.translateCurrentFile', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'python') {
        void vscode.window.showInformationMessage('Pyrite: open a Python file first.');
        return;
      }
      if (editor.document.isDirty) await editor.document.save();
      await translateOne(editor.document.uri, true);
    }),
    vscode.commands.registerCommand('pyrite.openJavaView', () => openJavaView()),
    vscode.commands.registerCommand('pyrite.goToPythonSource', () => goToPythonSource()),
    vscode.commands.registerCommand('pyrite.clearView', () => clearView()),
    vscode.window.registerWebviewViewProvider(PyriteAboutViewProvider.viewType, new PyriteAboutViewProvider(context)),
    vscode.languages.registerDefinitionProvider({ language: 'java' }, new PyriteDefinitionProvider()),
  );

  // Keep the view in sync with saves / deletes.
  const watcher = vscode.workspace.createFileSystemWatcher('**/*.py');
  const onChange = async (uri: vscode.Uri) => {
    if (!settings().watch) return;
    const root = rootFor(uri);
    if (!root) return;
    const outDir = path.join(root.uri.fsPath, settings().outputFolder);
    if (!fs.existsSync(outDir)) return; // the user has not generated a view yet - stay quiet
    await translateOne(uri, false, true);
  };
  context.subscriptions.push(
    watcher,
    watcher.onDidChange(onChange),
    watcher.onDidCreate(onChange),
    watcher.onDidDelete((uri) => {
      const root = rootFor(uri);
      if (!root || !settings().watch) return;
      removeMirroredFile(root.uri.fsPath, relPath(root, uri.fsPath), settings().outputFolder);
    }),
  );
}

export function deactivate(): void {
  // nothing to clean up: subscriptions are disposed by VS Code
}
