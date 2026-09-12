/**
 * VS Code entry point for Pyrite.
 *
 * Commands
 *   pyrite.generateView        translate every Python file in the workspace into <outputFolder>/
 *   pyrite.translateCurrentFile translate only the active Python file
 *   pyrite.openJavaView        jump from a Python file/line to the matching Java view line
 *   pyrite.goToPythonSource    jump from a Java view line back to the Python source line
 *   pyrite.clearView           delete the generated folder
 *   pyrite.setApiKey           store the LLM API key in VS Code's secret storage
 *
 * A file watcher keeps the view in sync on save (setting pyrite.watch).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { createTranslator, EngineName, Translator } from './translator';
import { javaLineFor, javaPathFor, mirrorFile, mirrorProject, pythonLineFor, readSourceMap, removeMirroredFile, isExcluded } from './mirror';

const SECRET_KEY = 'pyrite.llm.apiKey';
let output: vscode.OutputChannel;
let statusItem: vscode.StatusBarItem;

interface Settings {
  engine: EngineName;
  outputFolder: string;
  exclude: string[];
  watch: boolean;
  llm: { model: string; effort: 'low' | 'medium' | 'high'; fallbackToRules: boolean };
}

function settings(): Settings {
  const cfg = vscode.workspace.getConfiguration('pyrite');
  return {
    engine: cfg.get<EngineName>('engine', 'rules'),
    outputFolder: cfg.get<string>('outputFolder', '.java-view'),
    exclude: cfg.get<string[]>('exclude', []),
    watch: cfg.get<boolean>('watch', true),
    llm: {
      model: cfg.get<string>('llm.model', 'claude-opus-5'),
      effort: cfg.get<'low' | 'medium' | 'high'>('llm.effort', 'medium'),
      fallbackToRules: cfg.get<boolean>('llm.fallbackToRules', true),
    },
  };
}

async function buildTranslator(context: vscode.ExtensionContext): Promise<Translator> {
  const s = settings();
  const apiKey = s.engine === 'llm' ? (await context.secrets.get(SECRET_KEY)) ?? process.env.ANTHROPIC_API_KEY : undefined;
  const { translator, note } = createTranslator({ engine: s.engine, llm: { apiKey, ...s.llm } });
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

async function generateView(context: vscode.ExtensionContext, folderUri?: vscode.Uri): Promise<void> {
  const root = rootFor(folderUri);
  if (!root) {
    void vscode.window.showErrorMessage('Pyrite: open a folder first.');
    return;
  }
  const s = settings();
  const translator = await buildTranslator(context);
  const scopeRoot = folderUri && fs.statSync(folderUri.fsPath).isDirectory() ? folderUri.fsPath : root.uri.fsPath;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Pyrite: generating Java view', cancellable: true },
    async (progress, token) => {
      const started = Date.now();
      // When invoked on a sub-folder, translate only that folder but keep paths relative to the workspace root.
      const summary = await mirrorProject(translator, {
        root: root.uri.fsPath,
        outputFolder: s.outputFolder,
        exclude: [...s.exclude, ...(scopeRoot !== root.uri.fsPath ? [] : [])],
        isCancelled: () => token.isCancellationRequested,
        onProgress: (rel, i, total) => {
          if (scopeRoot !== root.uri.fsPath && !path.join(root.uri.fsPath, rel).startsWith(scopeRoot)) return;
          progress.report({ message: `${i + 1}/${total} ${rel}`, increment: 100 / Math.max(total, 1) });
        },
      });
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      output.appendLine(`Generated ${summary.files} file(s) in ${summary.outputRoot} (${summary.engine} engine, ${secs}s).`);
      for (const w of summary.warnings) output.appendLine(`  warning: ${w}`);
      const msg = `Pyrite: ${summary.files} file(s) translated to ${s.outputFolder}/ (${summary.engine} engine)` + (summary.warnings.length ? `, ${summary.warnings.length} warning(s)` : '');
      const pick = await vscode.window.showInformationMessage(msg, 'Open folder', summary.warnings.length ? 'Show warnings' : 'OK');
      if (pick === 'Open folder') {
        await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(summary.outputRoot));
      } else if (pick === 'Show warnings') {
        output.show(true);
      }
    },
  );
}

async function translateOne(context: vscode.ExtensionContext, pyUri: vscode.Uri, reveal: boolean): Promise<vscode.Uri | undefined> {
  const root = rootFor(pyUri);
  if (!root) return undefined;
  if (isInsideOutput(root, pyUri.fsPath)) return undefined;
  const s = settings();
  const rel = relPath(root, pyUri.fsPath);
  if (isExcluded(rel, s.exclude)) return undefined;
  const translator = await buildTranslator(context);
  statusItem.text = '$(sync~spin) Pyrite';
  statusItem.show();
  try {
    const { javaAbs, result } = await mirrorFile(translator, root.uri.fsPath, rel, s.outputFolder);
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

async function openJavaView(context: vscode.ExtensionContext): Promise<void> {
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
  const javaUri = fs.existsSync(javaAbs) ? vscode.Uri.file(javaAbs) : await translateOne(context, editor.document.uri, false);
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

async function setApiKey(context: vscode.ExtensionContext): Promise<void> {
  const key = await vscode.window.showInputBox({
    prompt: 'Anthropic API key for the Pyrite LLM engine (stored in VS Code secret storage)',
    password: true,
    ignoreFocusOut: true,
    placeHolder: 'sk-ant-...',
  });
  if (key === undefined) return;
  if (key.trim() === '') {
    await context.secrets.delete(SECRET_KEY);
    void vscode.window.showInformationMessage('Pyrite: API key removed.');
    return;
  }
  await context.secrets.store(SECRET_KEY, key.trim());
  const cfg = vscode.workspace.getConfiguration('pyrite');
  if (cfg.get<string>('engine') !== 'llm') {
    const pick = await vscode.window.showInformationMessage('Pyrite: API key saved. Switch the engine to "llm"?', 'Yes', 'No');
    if (pick === 'Yes') await cfg.update('engine', 'llm', vscode.ConfigurationTarget.Workspace);
  } else {
    void vscode.window.showInformationMessage('Pyrite: API key saved.');
  }
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
    vscode.commands.registerCommand('pyrite.generateView', (uri?: vscode.Uri) => generateView(context, uri)),
    vscode.commands.registerCommand('pyrite.translateCurrentFile', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'python') {
        void vscode.window.showInformationMessage('Pyrite: open a Python file first.');
        return;
      }
      if (editor.document.isDirty) await editor.document.save();
      await translateOne(context, editor.document.uri, true);
    }),
    vscode.commands.registerCommand('pyrite.openJavaView', () => openJavaView(context)),
    vscode.commands.registerCommand('pyrite.goToPythonSource', () => goToPythonSource()),
    vscode.commands.registerCommand('pyrite.clearView', () => clearView()),
    vscode.commands.registerCommand('pyrite.setApiKey', () => setApiKey(context)),
  );

  // Keep the view in sync with saves / deletes.
  const watcher = vscode.workspace.createFileSystemWatcher('**/*.py');
  const onChange = async (uri: vscode.Uri) => {
    if (!settings().watch) return;
    const root = rootFor(uri);
    if (!root) return;
    const outDir = path.join(root.uri.fsPath, settings().outputFolder);
    if (!fs.existsSync(outDir)) return; // the user has not generated a view yet - stay quiet
    await translateOne(context, uri, false);
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
