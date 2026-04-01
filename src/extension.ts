import * as vscode from 'vscode';
import { AnthropicProvider } from './providers/anthropic';
import { OpenAICompatProvider, type OpenAICompatConfig } from './providers/openai-compat';
import { providerRegistry } from './providers/registry';
import { ChatViewProvider } from './chat/chat-view-provider';
import { registerCommands } from './commands';
import type { LLMProvider, ModelInfo } from './providers/types';

let activeProvider: LLMProvider | undefined;
let activeModel = 'claude-sonnet-4-6';
let chatViewProvider: ChatViewProvider | undefined;

export function activate(context: vscode.ExtensionContext): void {
  reloadConfiguration();

  // Register sidebar webview provider
  chatViewProvider = new ChatViewProvider(
    context.extensionUri,
    activeProvider ?? createDummyProvider(),
    activeModel,
    context.globalState
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ChatViewProvider.viewType,
      chatViewProvider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  // Watch for config changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('goPilot')) {
        reloadConfiguration();
        if (activeProvider && chatViewProvider) {
          chatViewProvider.updateProvider(activeProvider, activeModel);
        }
      }
    })
  );

  // Register commands
  registerCommands(context, () => {
    if (!activeProvider) {
      throw new Error(
        'No LLM provider configured. Set an API key in environment variables or configure goPilot.providers in settings.'
      );
    }
    return activeProvider;
  }, () => activeModel, chatViewProvider!);
}

function reloadConfiguration(): void {
  const config = vscode.workspace.getConfiguration('goPilot');
  const providerId = config.get<string>('activeProvider', 'anthropic');
  const providers = config.get<Record<string, unknown>>('providers', {});

  if (providerId === 'anthropic') {
    configureAnthropic(providers);
  } else {
    // Try to configure as OpenAI-compatible provider
    configureOpenAICompat(providerId, providers);
  }
}

function configureAnthropic(providers: Record<string, unknown>): void {
  const anthropicConfig = providers['anthropic'] as
    | { apiKey?: string; defaultModel?: string }
    | undefined;

  const apiKey = resolveEnvVar(anthropicConfig?.apiKey ?? '');
  const model = anthropicConfig?.defaultModel ?? 'claude-sonnet-4-6';
  activeModel = model;

  const resolvedKey = apiKey || process.env['ANTHROPIC_API_KEY'] || '';

  if (resolvedKey) {
    const provider = new AnthropicProvider(resolvedKey, model);
    providerRegistry.register(provider);
    activeProvider = provider;
  } else {
    activeProvider = undefined;
    void vscode.window.showWarningMessage(
      'GoPilot: No Anthropic API key found. Set ANTHROPIC_API_KEY or configure it in settings.'
    );
  }
}

function configureOpenAICompat(providerId: string, providers: Record<string, unknown>): void {
  const provConfig = providers[providerId] as
    | { type?: string; baseUrl?: string; apiKey?: string; displayName?: string; defaultModel?: string }
    | undefined;

  if (!provConfig?.baseUrl) {
    void vscode.window.showWarningMessage(
      `GoPilot: Provider "${providerId}" has no baseUrl configured.`
    );
    return;
  }

  const apiKey = resolveEnvVar(provConfig.apiKey ?? '');
  activeModel = provConfig.defaultModel ?? 'default';

  const config: OpenAICompatConfig = {
    baseUrl: provConfig.baseUrl,
    apiKey,
    displayName: provConfig.displayName ?? providerId,
    defaultModel: activeModel,
  };

  const provider = new OpenAICompatProvider(providerId, config);
  providerRegistry.register(provider);
  activeProvider = provider;
}

function resolveEnvVar(value: string): string {
  return value.replace(/\$\{env:([^}]+)\}/g, (_, varName: string) => {
    return process.env[varName] ?? '';
  });
}

/** Minimal provider that shows a helpful error when no real provider is configured */
function createDummyProvider(): LLMProvider {
  return {
    id: 'none',
    displayName: 'No Provider',
    listModels: async () => [{ id: 'none', displayName: 'Configure a provider in settings', contextWindow: 0, maxOutputTokens: 0, supportsTools: false, supportsStreaming: false }],
    complete: async () => { throw new Error('No LLM provider configured'); },
    stream: async function* () { yield { type: 'error' as const, error: 'No LLM provider configured. Go to Settings and configure goPilot.providers.' }; },
    healthCheck: async () => ({ ok: false, error: 'No provider configured' }),
  };
}

export function deactivate(): void {
  // Cleanup if needed
}
