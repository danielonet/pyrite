/**
 * Webview shown in Pyrite's Activity Bar panel: an "About" view with a
 * summary of the current configuration and shortcuts to the commands you'd
 * otherwise have to find in the Command Palette. Extend `renderBody()` when
 * there is more to configure than a few settings.
 */

import * as vscode from 'vscode';

export class PyriteAboutViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'pyrite.about';

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri],
    };

    const render = () => {
      webviewView.webview.html = this.html(webviewView.webview);
    };
    render();

    webviewView.webview.onDidReceiveMessage((message: { type: string; command?: string; args?: unknown[] }) => {
      if (message.type === 'command' && message.command) {
        void vscode.commands.executeCommand(message.command, ...(message.args ?? []));
      } else if (message.type === 'openReadme') {
        void this.openReadme();
      }
    });

    // Keep the settings summary current if the user edits pyrite.* elsewhere
    // (Settings UI, settings.json) while this panel is open.
    const configListener = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('pyrite') && webviewView.visible) render();
    });
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) render();
    });
    webviewView.onDidDispose(() => configListener.dispose());
  }

  private async openReadme(): Promise<void> {
    const uri = await this.findReadmeUri();
    if (!uri) {
      void vscode.window.showWarningMessage('Pyrite: could not find README.md in the installed extension.');
      return;
    }
    try {
      await vscode.commands.executeCommand('markdown.showPreview', uri);
    } catch {
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { preview: true });
    }
  }

  /**
   * Locate the extension's root README. Packaging with `vsce` lowercases the
   * root readme to `readme.md` in the published .vsix, while the source tree
   * (and an unpacked Extension Development Host) uses `README.md`; on a
   * case-sensitive filesystem only one of the two actually exists.
   */
  private async findReadmeUri(): Promise<vscode.Uri | undefined> {
    for (const name of ['README.md', 'readme.md']) {
      const uri = vscode.Uri.joinPath(this.context.extensionUri, name);
      try {
        await vscode.workspace.fs.stat(uri);
        return uri;
      } catch {
        // try the next candidate
      }
    }
    return undefined;
  }

  private html(webview: vscode.Webview): string {
    const pkg = this.context.extension.packageJSON as { version?: string; description?: string };
    const cfg = vscode.workspace.getConfiguration('pyrite');
    const engine = cfg.get<string>('engine', 'rules');
    const outputFolder = cfg.get<string>('outputFolder', '.java-view');
    const watch = cfg.get<boolean>('watch', true);
    const javadoc = cfg.get<string>('javadoc', 'docstringOnly');
    const javadocTestCode = cfg.get<boolean>('javadocTestCode', false);
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<style>
  body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    padding: 0 12px 12px;
  }
  h2 { margin-bottom: 2px; }
  .version { color: var(--vscode-descriptionForeground); font-size: 0.9em; margin-bottom: 12px; }
  .desc { margin-bottom: 16px; line-height: 1.4; }
  h3 {
    margin: 16px 0 6px;
    font-size: 0.85em;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--vscode-descriptionForeground);
  }
  table { width: 100%; border-collapse: collapse; margin-bottom: 8px; }
  td { padding: 3px 0; font-size: 0.9em; vertical-align: top; }
  td.key { color: var(--vscode-descriptionForeground); width: 45%; }
  td.val { font-family: var(--vscode-editor-font-family); }
  button {
    display: block;
    width: 100%;
    margin: 6px 0;
    padding: 6px 10px;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    border-radius: 2px;
    cursor: pointer;
    font-size: 0.9em;
    text-align: left;
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
</style>
</head>
<body>
  <h2>Pyrite</h2>
  <div class="version">v${escapeHtml(pkg.version ?? '0.0.0')}</div>
  <div class="desc">${escapeHtml(pkg.description ?? '')}</div>

  <h3>Current configuration</h3>
  <table>
    <tr><td class="key">Engine</td><td class="val">${escapeHtml(engine)}</td></tr>
    <tr><td class="key">Output folder</td><td class="val">${escapeHtml(outputFolder)}/</td></tr>
    <tr><td class="key">Watch on save</td><td class="val">${watch ? 'on' : 'off'}</td></tr>
    <tr><td class="key">Javadoc</td><td class="val">${escapeHtml(javadoc)}</td></tr>
    <tr><td class="key">Javadoc test code</td><td class="val">${javadocTestCode ? 'on' : 'off'}</td></tr>
  </table>

  <h3>Actions</h3>
  <button data-command="pyrite.generateView">Generate Java View for Workspace</button>
  <button class="secondary" data-command="workbench.action.openSettings" data-args='["@ext:danielonnet.pyrite"]'>Open Settings</button>
  <button class="secondary" id="readme">View README</button>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.querySelectorAll('button[data-command]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const command = btn.getAttribute('data-command');
        const argsAttr = btn.getAttribute('data-args');
        vscode.postMessage({ type: 'command', command, args: argsAttr ? JSON.parse(argsAttr) : [] });
      });
    });
    document.getElementById('readme').addEventListener('click', () => {
      vscode.postMessage({ type: 'openReadme' });
    });
  </script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) text += possible.charAt(Math.floor(Math.random() * possible.length));
  return text;
}

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}
