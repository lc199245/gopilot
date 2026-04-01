import Anthropic from '@anthropic-ai/sdk';
import type {
  LLMProvider, LLMRequest, LLMResponse, LLMStreamEvent,
  ModelInfo, ContentBlock, ToolDefinition
} from './types';

const ANTHROPIC_MODELS: ModelInfo[] = [
  {
    id: 'claude-sonnet-4-6',
    displayName: 'Claude Sonnet 4.6',
    contextWindow: 200000,
    maxOutputTokens: 8096,
    supportsTools: true,
    supportsStreaming: true,
  },
  {
    id: 'claude-sonnet-4-20250514',
    displayName: 'Claude Sonnet 4',
    contextWindow: 200000,
    maxOutputTokens: 8096,
    supportsTools: true,
    supportsStreaming: true,
  },
  {
    id: 'claude-haiku-4-5-20251001',
    displayName: 'Claude Haiku 4.5',
    contextWindow: 200000,
    maxOutputTokens: 8096,
    supportsTools: true,
    supportsStreaming: true,
  },
];

export class AnthropicProvider implements LLMProvider {
  readonly id = 'anthropic';
  readonly displayName = 'Anthropic Claude';

  private readonly client: Anthropic;
  private readonly defaultModel: string;

  constructor(apiKey: string, defaultModel = 'claude-sonnet-4-6') {
    this.client = new Anthropic({ apiKey });
    this.defaultModel = defaultModel;
  }

  async listModels(): Promise<ModelInfo[]> {
    return ANTHROPIC_MODELS;
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const params = this.buildParams(request);
    const response = await this.client.messages.create(params as unknown as Anthropic.MessageCreateParamsNonStreaming);

    const content: ContentBlock[] = response.content.map(block => {
      if (block.type === 'text') {
        return { type: 'text' as const, text: block.text };
      }
      if (block.type === 'tool_use') {
        return {
          type: 'tool_use' as const,
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>,
        };
      }
      return { type: 'text' as const, text: '' };
    });

    return {
      content,
      model: response.model,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      stopReason: response.stop_reason ?? 'end_turn',
    };
  }

  async *stream(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
    const params = this.buildParams(request);
    const stream = this.client.messages.stream(params as unknown as Anthropic.MessageCreateParamsStreaming);

    // Track tool use blocks being built up across events
    const toolBlocks = new Map<number, { id: string; name: string; jsonChunks: string[] }>();

    try {
      for await (const event of stream) {
        if (event.type === 'content_block_start') {
          const block = (event as any).content_block;
          if (block?.type === 'text') {
            // text block start — nothing to emit yet
          } else if (block?.type === 'tool_use') {
            toolBlocks.set((event as any).index, {
              id: block.id,
              name: block.name,
              jsonChunks: [],
            });
          }
        } else if (event.type === 'content_block_delta') {
          const delta = (event as any).delta;
          if (delta?.type === 'text_delta') {
            yield { type: 'text_delta', text: delta.text };
          } else if (delta?.type === 'input_json_delta') {
            const idx = (event as any).index;
            const tool = toolBlocks.get(idx);
            if (tool) {
              tool.jsonChunks.push(delta.partial_json ?? '');
            }
          }
        } else if (event.type === 'content_block_stop') {
          const idx = (event as any).index;
          const tool = toolBlocks.get(idx);
          if (tool) {
            let input: Record<string, unknown> = {};
            try {
              input = JSON.parse(tool.jsonChunks.join(''));
            } catch {
              // empty input
            }
            yield {
              type: 'tool_use',
              toolUse: { id: tool.id, name: tool.name, input },
            };
            toolBlocks.delete(idx);
          }
        } else if (event.type === 'message_delta') {
          const stopReason = (event as any).delta?.stop_reason;
          if (stopReason) {
            yield { type: 'stop', stopReason };
          }
        } else if (event.type === 'message_stop') {
          yield { type: 'stop' };
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      yield { type: 'error', error: message };
    }
  }

  async healthCheck(): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.client.messages.create({
        model: this.defaultModel,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
      });
      return { ok: true };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
  }

  private buildParams(request: LLMRequest): Record<string, unknown> {
    const messages = request.messages.map(m => {
      if (typeof m.content === 'string') {
        return { role: m.role, content: m.content };
      }
      // Map ContentBlock[] to Anthropic content format
      const content = m.content.map(block => {
        if (block.type === 'text') return { type: 'text', text: block.text };
        if (block.type === 'tool_use') {
          return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
        }
        if (block.type === 'tool_result') {
          return {
            type: 'tool_result',
            tool_use_id: block.tool_use_id,
            content: block.content,
            is_error: block.is_error,
          };
        }
        return block;
      });
      return { role: m.role, content };
    });

    const params: Record<string, unknown> = {
      model: request.model || this.defaultModel,
      system: request.systemPrompt,
      messages,
      max_tokens: request.maxTokens ?? 8096,
    };

    if (request.tools?.length) {
      params.tools = request.tools.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema,
      }));
    }

    if (request.temperature !== undefined) {
      params.temperature = request.temperature;
    }

    return params;
  }
}
