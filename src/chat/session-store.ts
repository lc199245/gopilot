import * as vscode from 'vscode';
import type { LLMMessage, ContentBlock } from '../providers/types';

const STORE_KEY = 'gopilot.sessions';
const MAX_SESSIONS = 50;

/** A single turn (user or assistant) stored for history replay */
export interface StoredTurn {
  role: 'user' | 'assistant';
  /** Plain-text summary — tool blocks are summarised, not fully stored */
  text: string;
}

/** Metadata + full turn log for one conversation session */
export interface StoredSession {
  id: string;
  /** Auto-generated from the first user message */
  title: string;
  createdAt: number;
  updatedAt: number;
  /** Ordered turns for display */
  turns: StoredTurn[];
  /** Raw LLM messages — restored into Conversation on load */
  messages: LLMMessage[];
}

export class SessionStore {
  constructor(private readonly globalState: vscode.Memento) {}

  /** Load all sessions, newest first */
  list(): StoredSession[] {
    const raw = this.globalState.get<StoredSession[]>(STORE_KEY, []);
    return [...raw].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Persist (insert or replace) a session */
  async save(session: StoredSession): Promise<void> {
    const sessions = this.globalState.get<StoredSession[]>(STORE_KEY, []);
    const idx = sessions.findIndex(s => s.id === session.id);
    if (idx >= 0) {
      sessions[idx] = session;
    } else {
      sessions.unshift(session);
    }
    // Cap at MAX_SESSIONS, keeping the most recently updated ones
    const trimmed = [...sessions]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_SESSIONS);
    await this.globalState.update(STORE_KEY, trimmed);
  }

  /** Remove a session by id */
  async delete(id: string): Promise<void> {
    const sessions = this.globalState.get<StoredSession[]>(STORE_KEY, []);
    await this.globalState.update(STORE_KEY, sessions.filter(s => s.id !== id));
  }

  /** Clear all sessions */
  async clearAll(): Promise<void> {
    await this.globalState.update(STORE_KEY, []);
  }

  getById(id: string): StoredSession | undefined {
    return this.globalState.get<StoredSession[]>(STORE_KEY, []).find(s => s.id === id);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Derive a short title from the first user message (max 60 chars) */
export function deriveTitle(firstUserText: string): string {
  const single = firstUserText.replace(/\s+/g, ' ').trim();
  return single.length > 60 ? single.slice(0, 57) + '…' : single;
}

/** Convert a raw LLM message into a StoredTurn for display */
export function messageToTurn(msg: LLMMessage): StoredTurn | null {
  if (msg.role === 'user') {
    if (typeof msg.content === 'string') {
      return { role: 'user', text: msg.content };
    }
    // Skip pure tool-result user messages
    const textBlocks = (msg.content as ContentBlock[]).filter(b => b.type === 'text');
    if (textBlocks.length === 0) return null;
    return { role: 'user', text: textBlocks.map(b => (b as { text: string }).text).join('\n') };
  }

  if (msg.role === 'assistant') {
    if (typeof msg.content === 'string') {
      return { role: 'assistant', text: msg.content };
    }
    const parts: string[] = [];
    for (const block of msg.content as ContentBlock[]) {
      if (block.type === 'text') parts.push(block.text);
      else if (block.type === 'tool_use') parts.push(`_(used tool: ${block.name})_`);
    }
    const text = parts.join('\n').trim();
    return text ? { role: 'assistant', text } : null;
  }

  return null;
}
