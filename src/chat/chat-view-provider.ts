import * as vscode from 'vscode';
import * as fs from 'fs';
import type { LLMProvider } from '../providers/types';
import type { WebviewMessage, ExtensionMessage, SessionSummary } from '../webview/protocol';
import { Conversation } from './conversation';
import { handleUserMessage, parseSlashCommand, expandSlashCommand } from './message-handler';
import { ChangeTracker } from '../tools/change-tracker';
import { SessionStore, deriveTitle, messageToTurn, type StoredSession } from './session-store';

/**
 * WebviewViewProvider that renders the chat panel in the sidebar,
 * matching the GitHub Copilot Chat placement and UX.
 */
export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'goPilot.chatView';

  private view?: vscode.WebviewView;
  private conversation = new Conversation();
  private streamCancelled = false;
  private isProcessing = false;
  private alwaysAllow = false;
  private changeTracker = new ChangeTracker();
  private sessionStore!: SessionStore;
  /** Title of the currently active session (derived from first user message) */
  private currentSessionTitle = '';

  constructor(
    private readonly extensionUri: vscode.Uri,
    private provider: LLMProvider,
    private activeModel: string,
    globalState?: vscode.Memento
  ) {
    if (globalState) {
      this.sessionStore = new SessionStore(globalState);
    }
  }

  updateProvider(provider: LLMProvider, activeModel: string): void {
    this.provider = provider;
    this.activeModel = activeModel;
    void this.provider.listModels().then(models => {
      this.postMessage({ type: 'modelsLoaded', models, activeModel: this.activeModel });
    });
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist')],
    };

    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(
      (msg: WebviewMessage) => void this.handleMessage(msg)
    );

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.sendInitialState();
      }
    });
  }

  newConversation(): void {
    this.conversation.clear();
    this.currentSessionTitle = '';
    this.streamCancelled = false;
    this.isProcessing = false;
    this.alwaysAllow = false;
    this.changeTracker.clear();
    this.postMessage({ type: 'clear' });
    this.postMessage({ type: 'welcome' });
  }

  private sendInitialState(): void {
    void this.provider.listModels().then(models => {
      this.postMessage({ type: 'modelsLoaded', models, activeModel: this.activeModel });
    });
    if (this.conversation.length === 0) {
      this.postMessage({ type: 'welcome' });
    }
    this.sendSessionsList();
  }

  private sendSessionsList(): void {
    if (!this.sessionStore) return;
    const sessions = this.sessionStore.list();
    const summaries: SessionSummary[] = sessions.map(s => ({
      id: s.id,
      title: s.title,
      updatedAt: s.updatedAt,
      turnCount: s.turns.filter(t => t.role === 'user').length,
    }));
    this.postMessage({ type: 'sessionsLoaded', sessions: summaries });
  }

  /** Snapshot the current conversation into persistent storage */
  private async saveCurrentSession(): Promise<void> {
    if (!this.sessionStore) return;
    const messages = this.conversation.toMessages();
    if (messages.length === 0) return;

    const turns = messages
      .map(m => messageToTurn(m))
      .filter((t): t is NonNullable<typeof t> => t !== null);

    if (turns.length === 0) return;

    // Title = first user turn text
    if (!this.currentSessionTitle) {
      const firstUser = turns.find(t => t.role === 'user');
      this.currentSessionTitle = firstUser ? deriveTitle(firstUser.text) : 'Conversation';
    }

    const existing = this.sessionStore.getById(this.conversation.id);
    const session: StoredSession = {
      id: this.conversation.id,
      title: existing?.title ?? this.currentSessionTitle,
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      turns,
      messages,
    };

    await this.sessionStore.save(session);
    this.sendSessionsList();
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        this.sendInitialState();
        break;

      case 'sendMessage':
        if (this.isProcessing) return;
        await this.handleSendMessage(message.text);
        break;

      case 'cancelStream':
        this.streamCancelled = true;
        break;

      case 'selectModel':
        this.activeModel = message.modelId;
        break;

      case 'newConversation':
        this.newConversation();
        break;

      case 'insertCode':
        await this.insertCodeAtCursor(message.code);
        break;

      case 'copyCode':
        await vscode.env.clipboard.writeText(message.code);
        void vscode.window.showInformationMessage('Code copied to clipboard');
        break;

      case 'openFile':
        await this.openFile(message.filePath, message.line);
        break;

      case 'applyDiff':
        await this.applyDiff(message.filePath, message.oldText, message.newText);
        break;

      case 'showDiff':
        await this.changeTracker.showDiff(message.changeId);
        break;

      case 'keepChange':
        // "Keep" is a no-op — the change is already on disk. Just acknowledge.
        break;

      case 'discardChange':
        await this.changeTracker.discardChange(message.changeId);
        this.sendChangesUpdate();
        break;

      case 'keepAll':
        // All changes are already on disk — just hide the panel
        this.changeTracker.clear();
        this.sendChangesUpdate();
        break;

      case 'discardAll':
        for (const change of this.changeTracker.getChanges()) {
          await this.changeTracker.discardChange(change.id);
        }
        this.sendChangesUpdate();
        break;

      case 'loadSession':
        await this.loadSession(message.sessionId);
        break;

      case 'deleteSession':
        await this.deleteSession(message.sessionId);
        break;
    }
  }

  private async loadSession(sessionId: string): Promise<void> {
    if (!this.sessionStore) return;
    const session = this.sessionStore.getById(sessionId);
    if (!session) return;

    // Save the current conversation before switching (if it has messages)
    await this.saveCurrentSession();

    // Restore the selected session into the active conversation
    this.conversation.clear();
    this.conversation.restoreMessages(session.messages, session.id);
    this.currentSessionTitle = session.title;
    this.alwaysAllow = false;
    this.changeTracker.clear();

    // Tell the webview to render the history
    this.postMessage({
      type: 'sessionRestored',
      sessionId: session.id,
      title: session.title,
      turns: session.turns,
    });
    this.sendChangesUpdate();
  }

  private async deleteSession(sessionId: string): Promise<void> {
    if (!this.sessionStore) return;
    await this.sessionStore.delete(sessionId);
    // If the deleted session is the active one, start fresh
    if (this.conversation.id === sessionId) {
      this.newConversation();
    }
    this.sendSessionsList();
  }

  private async handleSendMessage(rawText: string): Promise<void> {
    this.isProcessing = true;
    this.streamCancelled = false;

    // Handle slash commands
    let text = rawText;
    const slashCmd = parseSlashCommand(rawText);
    if (slashCmd) {
      // If args are empty and there's selected text, use that
      let args = slashCmd.args;
      if (!args) {
        const editor = vscode.window.activeTextEditor;
        if (editor && !editor.selection.isEmpty) {
          const sel = editor.document.getText(editor.selection);
          const lang = editor.document.languageId;
          args = `\`\`\`${lang}\n${sel}\n\`\`\``;
        }
      }
      text = expandSlashCommand(slashCmd.command, args);
    }

    // Handle @-mentions: replace @file references with file content
    text = await this.expandMentions(text);

    try {
      await handleUserMessage(text, {
        provider: this.provider,
        model: this.activeModel,
        conversation: this.conversation,
        postMessage: (msg) => this.postMessage(msg),
        isCancelled: () => this.streamCancelled,
        alwaysAllow: this.alwaysAllow,
        setAlwaysAllow: (v) => { this.alwaysAllow = v; },
        changeTracker: this.changeTracker,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.postMessage({ type: 'streamError', error: msg });
    } finally {
      this.isProcessing = false;
      this.sendChangesUpdate();
      void this.saveCurrentSession();
    }
  }

  private async expandMentions(text: string): Promise<string> {
    // Replace @path/to/file with file contents
    const mentionRegex = /@(\S+\.\w+)/g;
    let result = text;
    let match: RegExpExecArray | null;

    while ((match = mentionRegex.exec(text)) !== null) {
      const filePath = match[1];
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!root) continue;

      const fullPath = require('path').isAbsolute(filePath)
        ? filePath
        : require('path').join(root, filePath);

      try {
        const content = fs.readFileSync(fullPath, 'utf8');
        const ext = require('path').extname(fullPath).slice(1);
        result = result.replace(match[0], `\n\`\`\`${ext}\n// ${filePath}\n${content}\n\`\`\`\n`);
      } catch {
        // Leave the mention as-is if file not found
      }
    }

    // Replace #terminal with recent terminal output placeholder
    if (result.includes('#terminal')) {
      result = result.replace(/#terminal/g, '[Recent terminal output is included in the workspace context]');
    }

    return result;
  }

  private async insertCodeAtCursor(code: string): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showWarningMessage('No active editor to insert code into');
      return;
    }
    await editor.edit(editBuilder => {
      editBuilder.insert(editor.selection.active, code);
    });
  }

  private async openFile(filePath: string, line?: number): Promise<void> {
    try {
      const doc = await vscode.workspace.openTextDocument(filePath);
      const editor = await vscode.window.showTextDocument(doc, { preview: false });
      if (line) {
        const position = new vscode.Position(line - 1, 0);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
      }
    } catch {
      void vscode.window.showErrorMessage(`Could not open file: ${filePath}`);
    }
  }

  private async applyDiff(filePath: string, oldText: string, newText: string): Promise<void> {
    try {
      const fullPath = require('path').isAbsolute(filePath)
        ? filePath
        : require('path').join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '', filePath);

      const content = fs.readFileSync(fullPath, 'utf8');
      if (!content.includes(oldText)) {
        void vscode.window.showErrorMessage('Could not find the text to replace in the file.');
        return;
      }
      const updated = content.replace(oldText, newText);
      fs.writeFileSync(fullPath, updated, 'utf8');

      const doc = await vscode.workspace.openTextDocument(fullPath);
      await vscode.window.showTextDocument(doc, { preview: false });
      void vscode.window.showInformationMessage(`Applied changes to ${filePath}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`Failed to apply diff: ${msg}`);
    }
  }

  private sendChangesUpdate(): void {
    const changes = this.changeTracker.toWebviewData();
    const stats = this.changeTracker.getStats();
    this.postMessage({ type: 'changesUpdated', changes, stats });
  }

  private postMessage(message: ExtensionMessage): void {
    void this.view?.webview.postMessage(message);
  }

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.js')
    );
    const nonce = getNonce();
    const csp = [
      `default-src 'none'`,
      `script-src 'nonce-${nonce}'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `img-src ${webview.cspSource} https: data:`,
      `font-src ${webview.cspSource}`,
    ].join('; ');

    const htmlPath = vscode.Uri.joinPath(this.extensionUri, 'src', 'webview', 'index.html');
    let html = fs.readFileSync(htmlPath.fsPath, 'utf8');

    html = html
      .replace('{{NONCE}}', nonce)
      .replace('{{SCRIPT_URI}}', scriptUri.toString())
      .replace('{{CSP}}', csp);

    return html;
  }
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i++) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}
