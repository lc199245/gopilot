import type { LLMMessage, ContentBlock } from '../providers/types';

const MAX_HISTORY_TOKENS = 30_000;
const CHARS_PER_TOKEN = 4;

function estimateTokens(content: string | ContentBlock[]): number {
  if (typeof content === 'string') {
    return Math.ceil(content.length / CHARS_PER_TOKEN);
  }
  let chars = 0;
  for (const block of content) {
    if (block.type === 'text') chars += block.text.length;
    else if (block.type === 'tool_use') chars += JSON.stringify(block.input).length + block.name.length;
    else if (block.type === 'tool_result') chars += block.content.length;
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

export class Conversation {
  private messages: LLMMessage[] = [];
  private _id: string;

  constructor() {
    this._id = this.newId();
  }

  get id(): string { return this._id; }
  get length(): number { return this.messages.length; }

  addUserMessage(text: string): void {
    this.messages.push({ role: 'user', content: text });
    this.trimToTokenBudget();
  }

  addAssistantMessage(content: string | ContentBlock[]): void {
    this.messages.push({ role: 'assistant', content });
    this.trimToTokenBudget();
  }

  /** Add tool results as a user message with tool_result content blocks */
  addToolResults(results: Array<{ toolCallId: string; output: string; isError: boolean }>): void {
    const blocks: ContentBlock[] = results.map(r => ({
      type: 'tool_result' as const,
      tool_use_id: r.toolCallId,
      content: r.output,
      is_error: r.isError || undefined,
    }));
    this.messages.push({ role: 'user', content: blocks });
  }

  toMessages(): LLMMessage[] {
    return [...this.messages];
  }

  clear(): void {
    this.messages = [];
    this._id = this.newId();
  }

  /**
   * Restore a previously saved message list into this conversation,
   * preserving the original session id.
   */
  restoreMessages(messages: LLMMessage[], sessionId?: string): void {
    this.messages = [...messages];
    if (sessionId) {
      this._id = sessionId;
    }
  }

  private trimToTokenBudget(): void {
    let totalTokens = this.messages.reduce(
      (sum, m) => sum + estimateTokens(m.content),
      0
    );
    // Keep at least the last user message
    while (totalTokens > MAX_HISTORY_TOKENS && this.messages.length > 1) {
      const removed = this.messages.shift()!;
      totalTokens -= estimateTokens(removed.content);
    }
  }

  private newId(): string {
    return typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : Date.now().toString();
  }
}
