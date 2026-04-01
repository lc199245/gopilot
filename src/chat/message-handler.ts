import * as vscode from 'vscode';
import type { LLMProvider, LLMStreamEvent, ContentBlock } from '../providers/types';
import type { ExtensionMessage } from '../webview/protocol';
import { Conversation } from './conversation';
import { gatherWorkspaceContext } from '../context/workspace-context';
import { buildSystemPrompt } from '../prompt/prompt-builder';
import { loadSkills } from '../skills/skill-loader';
import { matchSkills } from '../skills/skill-matcher';
import { TOOL_DEFINITIONS } from '../tools/definitions';
import { executeTool, toolPreview } from '../tools/executor';
import { needsApproval, requestApproval, type ApprovalResult } from '../tools/approval';
import { setChangeTracker } from '../tools/file-tools';
import type { ChangeTracker } from '../tools/change-tracker';

const MAX_TOOL_LOOPS = 15;

export interface MessageHandlerDeps {
  provider: LLMProvider;
  model: string;
  conversation: Conversation;
  postMessage: (msg: ExtensionMessage) => void;
  isCancelled: () => boolean;
  /** When set to true, skip approval prompts for the rest of this conversation */
  alwaysAllow?: boolean;
  /** Callback to persist the always-allow flag back to the caller */
  setAlwaysAllow?: (value: boolean) => void;
  /** Tracks file changes for the session */
  changeTracker?: ChangeTracker;
}

/**
 * Handles a user message through the full agentic loop:
 * send to LLM -> stream response -> handle tool calls -> loop
 */
export async function handleUserMessage(
  userText: string,
  deps: MessageHandlerDeps
): Promise<void> {
  const { provider, model, conversation, postMessage, isCancelled } = deps;

  // Wire up the change tracker so file tools can record changes
  setChangeTracker(deps.changeTracker);

  conversation.addUserMessage(userText);

  // Gather workspace context
  const ctx = await gatherWorkspaceContext();

  // Load and match skills
  const skillsEnabled = vscode.workspace.getConfiguration('goPilot').get<boolean>('skills.enabled', true);
  const tokenBudget = vscode.workspace.getConfiguration('goPilot').get<number>('skills.tokenBudget', 4000);
  let skills = skillsEnabled ? loadSkills() : [];
  const activeFileName = ctx.activeFile?.path;
  skills = matchSkills(skills, activeFileName, userText, tokenBudget);

  // Send context info to webview
  const contextFiles = [
    ...(ctx.activeFile ? [ctx.activeFile.path] : []),
    ...ctx.openFiles.map(f => f.path),
  ];
  postMessage({ type: 'contextInfo', files: contextFiles, skills: skills.map(s => s.meta.name) });

  // Build system prompt
  const systemPrompt = buildSystemPrompt(ctx, skills);

  // Agentic loop
  let loopCount = 0;
  let continueLoop = true;

  while (continueLoop && loopCount < MAX_TOOL_LOOPS) {
    loopCount++;
    continueLoop = false;

    if (isCancelled()) break;

    postMessage({ type: 'thinkingStart' });

    const request = {
      model,
      systemPrompt,
      messages: conversation.toMessages(),
      tools: TOOL_DEFINITIONS,
      maxTokens: 8096,
    };

    let assistantText = '';
    const pendingToolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];

    try {
      for await (const event of provider.stream(request)) {
        if (isCancelled()) break;

        if (event.type === 'text_delta' && event.text) {
          if (assistantText === '') {
            postMessage({ type: 'thinkingEnd' });
          }
          assistantText += event.text;
          postMessage({ type: 'streamDelta', text: event.text });
        } else if (event.type === 'tool_use' && event.toolUse) {
          postMessage({ type: 'thinkingEnd' });
          pendingToolCalls.push(event.toolUse);
        } else if (event.type === 'error') {
          postMessage({ type: 'thinkingEnd' });
          postMessage({ type: 'streamError', error: event.error ?? 'Unknown error' });
          return;
        } else if (event.type === 'stop') {
          // Check if we stopped for tool use
          if (event.stopReason === 'tool_use' || pendingToolCalls.length > 0) {
            continueLoop = true;
          }
        }
      }
    } catch (err: unknown) {
      postMessage({ type: 'thinkingEnd' });
      const msg = err instanceof Error ? err.message : String(err);
      postMessage({ type: 'streamError', error: msg });
      return;
    }

    if (isCancelled()) break;

    // Process tool calls if any
    if (pendingToolCalls.length > 0) {
      // Build assistant message with text + tool calls
      const assistantContent: ContentBlock[] = [];
      if (assistantText) {
        assistantContent.push({ type: 'text', text: assistantText });
      }
      for (const tc of pendingToolCalls) {
        assistantContent.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
      }
      conversation.addAssistantMessage(assistantContent);

      // Execute each tool call
      const toolResults: Array<{ toolCallId: string; output: string; isError: boolean }> = [];

      for (const tc of pendingToolCalls) {
        if (isCancelled()) break;

        const preview = toolPreview(tc.name, tc.input);
        postMessage({
          type: 'toolProgress',
          toolCallId: tc.id,
          toolName: tc.name,
          status: 'running',
        });

        // Check approval (skip if user chose "Always Allow" earlier in this conversation)
        if (!deps.alwaysAllow && needsApproval(tc.name)) {
          const decision: ApprovalResult = await requestApproval(tc.name, preview);
          if (decision === 'deny') {
            toolResults.push({
              toolCallId: tc.id,
              output: 'User denied this action.',
              isError: true,
            });
            postMessage({
              type: 'toolResult',
              toolCallId: tc.id,
              toolName: tc.name,
              output: 'Denied by user',
              success: false,
            });
            continue;
          }
          if (decision === 'allow-all') {
            deps.alwaysAllow = true;
            deps.setAlwaysAllow?.(true);
          }
        }

        // Execute
        const result = await executeTool(tc.name, tc.input);
        toolResults.push({
          toolCallId: tc.id,
          output: result.output,
          isError: result.isError,
        });

        postMessage({
          type: 'toolResult',
          toolCallId: tc.id,
          toolName: tc.name,
          output: result.output,
          success: !result.isError,
        });

        postMessage({
          type: 'toolProgress',
          toolCallId: tc.id,
          toolName: tc.name,
          status: result.isError ? 'error' : 'complete',
        });
      }

      // Add tool results to conversation and loop
      conversation.addToolResults(toolResults);
      continueLoop = true;
      assistantText = '';
    } else {
      // No tool calls — final response
      if (assistantText) {
        conversation.addAssistantMessage(assistantText);
      }
    }
  }

  postMessage({ type: 'thinkingEnd' });
  postMessage({ type: 'streamEnd' });
}

/**
 * Parse slash commands from user input.
 * Returns the command name and remaining text, or null if not a command.
 */
export function parseSlashCommand(text: string): { command: string; args: string } | null {
  const match = text.match(/^\/(\w+)\s*(.*)/s);
  if (!match) return null;
  return { command: match[1], args: match[2].trim() };
}

/**
 * Expand slash commands into LLM-friendly prompts.
 */
export function expandSlashCommand(command: string, args: string): string {
  switch (command) {
    case 'explain':
      return `Please explain the following code in detail. Focus on what it does, how it works, and any important design decisions:\n\n${args}`;
    case 'fix':
      return `Please identify and fix any bugs or issues in the following code. Explain what was wrong and what you changed:\n\n${args}`;
    case 'tests':
      return `Please generate comprehensive unit tests for the following code. Use the testing framework already used in this project if possible:\n\n${args}`;
    case 'doc':
      return `Please add documentation comments (JSDoc/docstrings) to the following code:\n\n${args}`;
    case 'refactor':
      return `Please refactor the following code to improve readability, maintainability, and/or performance. Explain your changes:\n\n${args}`;
    case 'optimize':
      return `Please optimize the following code for better performance. Explain the optimizations:\n\n${args}`;
    default:
      return `/${command} ${args}`;
  }
}
