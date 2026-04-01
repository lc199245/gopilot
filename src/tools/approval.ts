import * as vscode from 'vscode';
import { TOOLS_REQUIRING_APPROVAL, READ_ONLY_TOOLS } from './definitions';

export type ApprovalMode = 'always-ask' | 'ask-writes' | 'auto-approve';
export type ApprovalResult = 'allow' | 'allow-all' | 'deny';

export function getApprovalMode(): ApprovalMode {
  const config = vscode.workspace.getConfiguration('goPilot');
  return config.get<ApprovalMode>('approvalMode', 'ask-writes');
}

/**
 * Determines whether a tool call needs user approval.
 */
export function needsApproval(toolName: string): boolean {
  const mode = getApprovalMode();

  switch (mode) {
    case 'auto-approve':
      return false;
    case 'always-ask':
      return true;
    case 'ask-writes':
      return TOOLS_REQUIRING_APPROVAL.has(toolName);
    default:
      return true;
  }
}

/**
 * Request approval from the user via a notification.
 * Returns 'allow' for one-time approval, 'allow-all' to skip future approvals
 * in this conversation, or 'deny' to reject.
 */
export async function requestApproval(
  toolName: string,
  preview: string
): Promise<ApprovalResult> {
  const result = await vscode.window.showInformationMessage(
    `GoPilot wants to: ${preview}`,
    { modal: false },
    'Allow',
    'Always Allow',
    'Deny'
  );

  if (result === 'Allow') return 'allow';
  if (result === 'Always Allow') return 'allow-all';
  return 'deny';
}
