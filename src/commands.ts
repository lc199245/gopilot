import * as vscode from 'vscode';
import { ChatPanel } from './chat/chat-panel';
import { ChatViewProvider } from './chat/chat-view-provider';
import type { LLMProvider } from './providers/types';

export function registerCommands(
  context: vscode.ExtensionContext,
  getProvider: () => LLMProvider,
  getActiveModel: () => string,
  chatViewProvider: ChatViewProvider
): void {
  context.subscriptions.push(
    // Open chat in a separate editor panel (pop-out mode)
    vscode.commands.registerCommand('goPilot.openChat', () => {
      ChatPanel.createOrShow(context.extensionUri, getProvider(), getActiveModel());
    }),

    // New conversation in sidebar
    vscode.commands.registerCommand('goPilot.newConversation', () => {
      chatViewProvider.newConversation();
      // Also focus the sidebar
      void vscode.commands.executeCommand('goPilot.chatView.focus');
    }),

    // Context menu: Explain selected code
    vscode.commands.registerCommand('goPilot.explainSelection', () => {
      sendSelectionCommand(chatViewProvider, '/explain');
    }),

    // Context menu: Fix selected code
    vscode.commands.registerCommand('goPilot.fixSelection', () => {
      sendSelectionCommand(chatViewProvider, '/fix');
    }),

    // Context menu: Generate tests for selected code
    vscode.commands.registerCommand('goPilot.testSelection', () => {
      sendSelectionCommand(chatViewProvider, '/tests');
    }),

    // Context menu: Add documentation to selected code
    vscode.commands.registerCommand('goPilot.docSelection', () => {
      sendSelectionCommand(chatViewProvider, '/doc');
    }),

    // Context menu: Refactor selected code
    vscode.commands.registerCommand('goPilot.refactorSelection', () => {
      sendSelectionCommand(chatViewProvider, '/refactor');
    }),

    // Focus the chat input
    vscode.commands.registerCommand('goPilot.focusChat', () => {
      void vscode.commands.executeCommand('goPilot.chatView.focus');
    })
  );
}

function sendSelectionCommand(chatViewProvider: ChatViewProvider, command: string): void {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) {
    void vscode.window.showWarningMessage('GoPilot: Please select some code first.');
    return;
  }

  // Focus the sidebar
  void vscode.commands.executeCommand('goPilot.chatView.focus');

  // The slash command handler in chat-view-provider will pick up the selection
  // when args are empty — so we just need to trigger the chat with the command
  // We simulate sending the command by directly invoking the view provider
  // For now, show a notification directing the user to the chat
  const selectedText = editor.document.getText(editor.selection);
  const lang = editor.document.languageId;
  const message = `${command}\n\`\`\`${lang}\n${selectedText}\n\`\`\``;

  // Post the message to the webview
  // We need to trigger this through the extension API
  // The simplest approach: directly handle it via the view provider
  void (chatViewProvider as any).handleMessage({ type: 'sendMessage', text: message });
}
