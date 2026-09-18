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
import { javaLineFor, javaPathFor, mirrorFile, pythonLineFor, readSourceMap, removeMirroredFile, removeMirroredFolder, isExcluded } from './mirror';
import { runMirrorInBackground } from './backgroundMirror';
import { SymbolIndexCache, ViewStats, resolveDefinition } from './definitionIndex';
import { PyriteAboutViewProvider } from './aboutView';

let output: vscode.OutputChannel;
let statusItem: vscode.StatusBarItem;

/** Status bar label: the logo alone, from the extension's own icon font (contributed in package.json). */
const STATUS_IDLE = '$(pyrite-logo)';
/** Same place while a translation is running, with the built-in spinner. */
const STATUS_BUSY = '$(sync~spin)';

/** One symbol index per workspace folder + output folder, kept warm between "Go to Definition" calls. */
const symbolIndexes = new Map<string, SymbolIndexCache>();

function symbolIndexFor(root: vscode.WorkspaceFolder, outputFolder = settings().outputFolder): SymbolIndexCache {
  const key = `${root.uri.fsPath}\0${outputFolder}`;
  let cache = symbolIndexes.get(key);
  if (!cache) {
    cache = new SymbolIndexCache(root.uri.fsPath, outputFolder);
    symbolIndexes.set(key, cache);
  }
  return cache;
}

interface Settings {
  engine: EngineName;
  outputFolder: string;
  exclude: string[];
  watch: boolean;
  javadoc: JavadocMode;
  javadocTestCode: boolean;
  lombok: boolean;
  lineWidth: number;
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
    lineWidth: cfg.get<number>('lineWidth', 120),
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
  // Invoked on a sub-folder from the Explorer: translate only that folder, keeping paths relative to the workspace root.
  const subfolder = scopeRoot !== root.uri.fsPath ? relPath(root, scopeRoot) : undefined;
  if (subfolder && isInsideOutput(root, scopeRoot)) {
    void vscode.window.showInformationMessage(`Pyrite: ${subfolder} is part of the generated Java view, not Python sources.`);
    return;
  }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: subfolder ? `Pyrite: generating Java view for ${subfolder}` : 'Pyrite: generating Java view', cancellable: true },
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
            exclude: s.exclude,
            subfolder,
            javadocMode: s.javadoc,
            documentTestCode: s.javadocTestCode,
            lombokStyle: s.lombok,
            lineWidth: s.lineWidth,
          },
        },
        (rel, i, total) => {
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
        symbolIndexFor(root, s.outputFolder).invalidateAll();
        void refreshStatusReport(root.uri);
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
  statusItem.text = STATUS_BUSY;
  statusItem.show();
  try {
    const outcome = await mirrorFile(translator, root.uri.fsPath, rel, { outputFolder: s.outputFolder, javadocMode: s.javadoc, documentTestCode: s.javadocTestCode, lombokStyle: s.lombok, lineWidth: s.lineWidth });
    symbolIndexFor(root, s.outputFolder).invalidatePython(rel);
    void refreshStatusReport(pyUri);
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
    output.appendLine(`error: ${rel}: ${msg} (a placeholder view saying so was written in place of the old one)`);
    void vscode.window.showErrorMessage(`Pyrite: failed to translate ${rel}: ${msg}`);
    return undefined;
  } finally {
    statusItem.text = STATUS_IDLE;
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
  async provideDefinition(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Location[] | undefined> {
    const root = rootFor(document.uri);
    if (!root || !isInsideOutput(root, document.uri.fsPath)) return undefined;
    const range = document.getWordRangeAtPosition(position);
    if (!range) return undefined;
    const word = document.getText(range);
    const s = settings();
    const fromFile = relPath(root, document.uri.fsPath);
    const index = await symbolIndexFor(root, s.outputFolder).get();
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
  symbolIndexFor(root, s.outputFolder).invalidateAll();
  void refreshStatusReport(root.uri);
  void vscode.window.showInformationMessage(`Pyrite: deleted ${s.outputFolder}/.`);
}

/** How long ago, in words, for the tooltip's footer. */
function timeAgo(when: Date): string {
  const seconds = Math.max(0, Math.round((Date.now() - when.getTime()) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

function count(n: number, singular: string, plural = `${singular}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? singular : plural}`;
}

/** The status bar tooltip: what the Java view contains and what went wrong, as Markdown. */
export function buildStatusReport(stats: ViewStats, outputFolder: string): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.supportThemeIcons = true;
  // Command links are what a tooltip has instead of buttons; only Pyrite's own commands are trusted.
  md.isTrusted = { enabledCommands: [HOVER_GENERATE, HOVER_CLEAR] };
  md.appendMarkdown('**Pyrite — Java view**\n\n');
  if (stats.files === 0) {
    md.appendMarkdown(`No Java view in \`${outputFolder}/\` yet.`);
    appendActions(md, false);
    return md;
  }
  md.appendMarkdown(`$(file-code) ${count(stats.files, 'file')} translated to \`${outputFolder}/\`\n\n`);
  // The declaration counts are their own group, fenced by rules. Headings enlarge the text and,
  // since a hover renders codicons at the inherited font size, the icons with it.
  md.appendMarkdown('---\n\n');
  md.appendMarkdown(`### $(symbol-class) ${count(stats.classes, 'class', 'classes')}\n\n`);
  md.appendMarkdown(`### $(symbol-method) ${count(stats.methods, 'method')}\n\n`);
  md.appendMarkdown(`### $(symbol-field) ${count(stats.fields, 'field')}\n\n`);
  md.appendMarkdown('---\n\n');
  const problems: string[] = [];
  if (stats.failed) problems.push(`$(error) ${count(stats.failed, 'file')} failed to translate`);
  if (stats.syntaxErrors) problems.push(`$(warning) ${count(stats.syntaxErrors, 'file')} with Python syntax errors`);
  if (stats.warnings) problems.push(`$(info) ${count(stats.warnings, 'warning')}`);
  md.appendMarkdown(problems.length ? `${problems.join('\n\n')}\n\n` : '$(check) No errors or warnings\n\n');
  if (stats.lastGenerated) md.appendMarkdown(`Last updated ${timeAgo(stats.lastGenerated)}.`);
  appendActions(md, stats.files > 0);
  return md;
}

/**
 * Commands behind the report's buttons. They are registered in code but not contributed in
 * package.json, so they stay out of the Command Palette: their only job is to close the report
 * before the real command opens a progress notification or a confirmation dialog.
 */
const HOVER_GENERATE = 'pyrite.generateViewFromStatus';
const HOVER_CLEAR = 'pyrite.clearViewFromStatus';
/** Clicking the status bar item opens its report instead of translating anything. */
const SHOW_REPORT = 'pyrite.showStatusReport';

/**
 * Close the status bar report, then run `action`.
 *
 * VS Code has no API to close a workbench hover. Clicking a button in the report leaves the
 * hover focused, and it closes when focus moves away, so focus is handed back to the editor
 * (or the status bar when no editor is open) before the command opens its progress
 * notification or confirmation dialog. Replacing the tooltip forces a re-render on top of
 * that, and `editor.action.hideHover` clears an editor hover if one happens to be open.
 */
async function dismissStatusReport(): Promise<void> {
  const run = (command: string) => vscode.commands.executeCommand(command).then(undefined, () => undefined);
  if (statusItem) statusItem.tooltip = new vscode.MarkdownString('**Pyrite** — working...');
  await run(vscode.window.visibleTextEditors.length ? 'workbench.action.focusActiveEditorGroup' : 'workbench.action.focusStatusBar');
  await run('editor.action.hideHover');
  // Let the hover widget go before anything is drawn over it.
  await new Promise((resolve) => setTimeout(resolve, 80));
}

async function runFromHover(action: () => Promise<void> | void): Promise<void> {
  await dismissStatusReport();
  try {
    await action();
  } finally {
    await refreshStatusReport();
  }
}

/** The report's action row: command links, which render as buttons in a hover. */
function appendActions(md: vscode.MarkdownString, hasView: boolean): void {
  md.appendMarkdown('\n\n---\n\n');
  const generate = `[$(play) ${hasView ? 'Regenerate Java view' : 'Generate Java view'}](command:${HOVER_GENERATE})`;
  md.appendMarkdown(hasView ? `${generate} &nbsp;&nbsp; [$(trash) Delete view](command:${HOVER_CLEAR})` : generate);
}

/**
 * Open the status bar item's report. Clicking the item focuses it, and VS Code's
 * `workbench.action.showHover` opens (and focuses) the hover of the focused element, so the
 * report appears on a click and can be reached from the keyboard, not only by hovering.
 */
async function showStatusReport(): Promise<void> {
  await refreshStatusReport();
  try {
    await vscode.commands.executeCommand('workbench.action.showHover');
  } catch {
    // Older VS Code without that command: the hover still opens on hover.
  }
}

/** Recompute the status bar tooltip from the sidecar maps of the active workspace folder. */
async function refreshStatusReport(uri?: vscode.Uri): Promise<void> {
  const root = rootFor(uri);
  if (!root || !statusItem) return;
  const s = settings();
  try {
    const stats = await symbolIndexFor(root, s.outputFolder).stats();
    statusItem.tooltip = buildStatusReport(stats, s.outputFolder);
  } catch {
    statusItem.tooltip = new vscode.MarkdownString('**Pyrite**\n\nClick to generate the Java view of this workspace.');
  }
}

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('Pyrite');
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
  statusItem.text = STATUS_IDLE;
  // The label is the logo alone; screen readers and the status bar menu still need a name.
  statusItem.name = 'Pyrite';
  statusItem.accessibilityInformation = { label: 'Pyrite: Java view' };
  // Clicking opens the report; only its buttons act. Translating on a stray click is too easy to do by accident.
  statusItem.command = SHOW_REPORT;
  statusItem.tooltip = new vscode.MarkdownString('**Pyrite**\n\nReading the generated Java view...');
  statusItem.show();
  void refreshStatusReport();

  context.subscriptions.push(
    output,
    statusItem,
    vscode.commands.registerCommand('pyrite.generateView', (uri?: vscode.Uri) => generateView(uri)),
    vscode.commands.registerCommand(HOVER_GENERATE, () => runFromHover(() => generateView())),
    vscode.commands.registerCommand(HOVER_CLEAR, () => runFromHover(() => clearView())),
    vscode.commands.registerCommand(SHOW_REPORT, () => showStatusReport()),
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
  // Deletions are watched on everything, not just *.py: removing a folder fires one event for the
  // folder, none for the files inside it, and that folder's whole mirrored subtree must go too.
  const deleteWatcher = vscode.workspace.createFileSystemWatcher('**', true, true, false);
  context.subscriptions.push(
    watcher,
    watcher.onDidChange(onChange),
    watcher.onDidCreate(onChange),
    deleteWatcher,
    deleteWatcher.onDidDelete((uri) => {
      const root = rootFor(uri);
      if (!root || !settings().watch || isInsideOutput(root, uri.fsPath)) return;
      const rel = relPath(root, uri.fsPath);
      const s = settings();
      if (rel.endsWith('.py')) {
        removeMirroredFile(root.uri.fsPath, rel, s.outputFolder);
        symbolIndexFor(root, s.outputFolder).invalidatePython(rel);
      } else if (!path.extname(rel)) {
        // Probably a folder (it no longer exists, so it cannot be checked); harmless when nothing was mirrored there.
        removeMirroredFolder(root.uri.fsPath, rel, s.outputFolder);
        symbolIndexFor(root, s.outputFolder).invalidateAll();
      }
      void refreshStatusReport(uri);
    }),
  );

  // Maps can also change outside this window (the CLI, another VS Code window, git checkout of the output folder).
  const mapWatcher = vscode.workspace.createFileSystemWatcher('**/.pyrite/maps/**/*.json');
  const onMapChange = (uri: vscode.Uri) => {
    for (const cache of symbolIndexes.values()) {
      const rel = path.relative(cache.mapsRoot, uri.fsPath);
      if (!rel.startsWith('..') && !path.isAbsolute(rel)) cache.invalidateMap(uri.fsPath);
    }
  };
  context.subscriptions.push(mapWatcher, mapWatcher.onDidChange(onMapChange), mapWatcher.onDidCreate(onMapChange), mapWatcher.onDidDelete(onMapChange));
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => void refreshStatusReport(editor?.document.uri)),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('pyrite')) void refreshStatusReport();
    }),
  );
}

export function deactivate(): void {
  // nothing to clean up: subscriptions are disposed by VS Code
}
