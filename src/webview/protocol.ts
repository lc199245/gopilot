import type { ModelInfo } from '../providers/types';

export interface FileRef {
  path: string;
  label?: string;
}

/** Slim summary shown in the history list */
export interface SessionSummary {
  id: string;
  title: string;
  updatedAt: number;
  /** Number of user turns */
  turnCount: number;
}

/** A single display turn (user or assistant) sent when restoring a session */
export interface SessionTurn {
  role: 'user' | 'assistant';
  text: string;
}

export type WebviewMessage =
  | { type: 'sendMessage'; text: string; attachments?: FileRef[] }
  | { type: 'cancelStream' }
  | { type: 'selectModel'; modelId: string }
  | { type: 'approveToolUse'; toolCallId: string }
  | { type: 'rejectToolUse'; toolCallId: string }
  | { type: 'newConversation' }
  | { type: 'exportConversation' }
  | { type: 'insertCode'; code: string }
  | { type: 'copyCode'; code: string }
  | { type: 'applyDiff'; filePath: string; oldText: string; newText: string }
  | { type: 'openFile'; filePath: string; line?: number }
  | { type: 'showDiff'; changeId: string }
  | { type: 'keepChange'; changeId: string }
  | { type: 'discardChange'; changeId: string }
  | { type: 'keepAll' }
  | { type: 'discardAll' }
  | { type: 'loadSession'; sessionId: string }
  | { type: 'deleteSession'; sessionId: string }
  | { type: 'ready' };

export type ExtensionMessage =
  | { type: 'streamDelta'; text: string }
  | { type: 'streamEnd' }
  | { type: 'streamError'; error: string }
  | { type: 'toolUseRequest'; toolCallId: string; toolName: string; input: unknown; preview?: string }
  | { type: 'toolResult'; toolCallId: string; toolName: string; output: string; success: boolean }
  | { type: 'toolProgress'; toolCallId: string; toolName: string; status: 'running' | 'complete' | 'error' }
  | { type: 'modelsLoaded'; models: ModelInfo[]; activeModel: string }
  | { type: 'contextInfo'; files: string[]; skills: string[] }
  | { type: 'thinkingStart' }
  | { type: 'thinkingEnd' }
  | { type: 'clear' }
  | { type: 'welcome' }
  | { type: 'sessionsLoaded'; sessions: SessionSummary[] }
  | { type: 'sessionRestored'; sessionId: string; title: string; turns: SessionTurn[] }
  | { type: 'changesUpdated'; changes: ChangeEntry[]; stats: { totalAdditions: number; totalDeletions: number; filesChanged: number } };

/**
 * One entry per changed file (multiple edits to the same file are merged).
 * `id` is the earliest change-id for the file and is used as a stable key
 * for showDiff / discardChange operations.
 */
export interface ChangeEntry {
  id: string;
  relativePath: string;
  /** Cumulative additions across all edits to this file */
  additions: number;
  /** Cumulative deletions across all edits to this file */
  deletions: number;
  kind: 'edit' | 'create';
  /** True only when every change to this file has been discarded */
  discarded: boolean;
}
