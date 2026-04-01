import * as vscode from 'vscode';
import * as fs from 'fs';
import type { LLMProvider } from '../providers/types';
import type { WebviewMessage, ExtensionMessage } from '../webview/protocol';
import { Conversation } from './conversation';
import { handleUserMessage, parseSlashCommand, expandSlashCommand } from './message-handler';
import { ChangeTracker } from '../tools/change-tracker';

/**
 * WebviewPanel-based chat for "pop-out to editor" mode.
 * The primary chat lives in the sidebar (ChatViewProvider).
 */
export class ChatPanel {
  private static instance: ChatPanel | undefined;
  static readonly viewType = 'goPilot.chatPanel';

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private readonly conversation: Conversation;
  private provider: LLMProvider;
  private activeModel: string;
  private streamCancelled = false;
  private isProcessing = false;
  private alwaysAllow = false;
  private changeTracker = new ChangeTracker();
  private readonly disposables: vscode.Disposable[] = [];

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    provider: LLMProvider,
    activeModel: string
  ) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.provider = provider;
    this.activeModel = activeModel;
    this.conversation = new Conversation();

    this.panel.webview.html = this.getHtml();
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (msg: WebviewMessage) => void this.handleWebviewMessage(msg),
      null,
      this.disposables
    );

    void this.provider.listModels().then(models => {
      this.postMessage({ type: 'modelsLoaded', models, activeModel: this.activeModel });
    });
  }

  static createOrShow(
    extensionUri: vscode.Uri,
    provider: LLMProvider,
    activeModel: string
  ): ChatPanel {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

    if (ChatPanel.instance) {
      ChatPanel.instance.panel.reveal(column);
      ChatPanel.instance.updateProvider(provider, activeModel);
      return ChatPanel.instance;
    }

    const panel = vscode.window.createWebviewPanel(
      ChatPanel.viewType,
      'GoPilot',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist')],
      }
    );

    ChatPanel.instance = new ChatPanel(panel, extensionUri, provider, activeModel);
    return ChatPanel.instance;
  }

  updateProvider(provider: LLMProvider, activeModel: string): void {
    this.provider = provider;
    this.activeModel = activeModel;
    void this.provider.listModels().then(models => {
      this.postMessage({ type: 'modelsLoaded', models, activeModel: this.activeModel });
    });
  }

  private async handleWebviewMessage(message: WebviewMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        void this.provider.listModels().then(models => {
          this.postMessage({ type: 'modelsLoaded', models, activeModel: this.activeModel });
        });
        if (this.conversation.length === 0) {
          this.postMessage({ type: 'welcome' });
        }
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
        this.conversation.clear();
        this.alwaysAllow = false;
        this.changeTracker.clear();
        this.postMessage({ type: 'clear' });
        this.postMessage({ type: 'welcome' });
        break;

      case 'insertCode':
        await this.insertCodeAtCursor(message.code);
        break;

      case 'copyCode':
        await vscode.env.clipboard.writeText(message.code);
        break;

      case 'showDiff':
        await this.changeTracker.showDiff(message.changeId);
        break;

      case 'discardChange':
        await this.changeTracker.discardChange(message.changeId);
        this.sendChangesUpdate();
        break;

      case 'keepAll':
        this.changeTracker.clear();
        this.sendChangesUpdate();
        break;

      case 'discardAll':
        for (const change of this.changeTracker.getChanges()) {
          await this.changeTracker.discardChange(change.id);
        }
        this.sendChangesUpdate();
        break;
    }
  }

  private async handleSendMessage(rawText: string): Promise<void> {
    this.isProcessing = true;
    this.streamCancelled = false;

    let text = rawText;
    const slashCmd = parseSlashCommand(rawText);
    if (slashCmd) {
      let args = slashCmd.args;
      if (!args) {
        const editor = vscode.window.activeTextEditor;
        if (editor && !editor.selection.isEmpty) {
          const sel = editor.document.getText(editor.selection);
          args = `\`\`\`${editor.document.languageId}\n${sel}\n\`\`\``;
        }
      }
      text = expandSlashCommand(slashCmd.command, args);
    }

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
    }
  }

  private async insertCodeAtCursor(code: string): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    await editor.edit(b => b.insert(editor.selection.active, code));
  }

  private sendChangesUpdate(): void {
    const changes = this.changeTracker.toWebviewData();
    const stats = this.changeTracker.getStats();
    this.postMessage({ type: 'changesUpdated', changes, stats });
  }

  private postMessage(message: ExtensionMessage): void {
    void this.panel.webview.postMessage(message);
  }

  private getHtml(): string {
    const webview = this.panel.webview;
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

  dispose(): void {
    ChatPanel.instance = undefined;
    this.panel.dispose();
    this.disposables.forEach(d => d.dispose());
    this.disposables.length = 0;
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
