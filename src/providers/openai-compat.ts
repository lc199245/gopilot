import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';
import type {
  LLMProvider, LLMRequest, LLMResponse, LLMStreamEvent,
  ModelInfo, ContentBlock
} from './types';

export interface OpenAICompatConfig {
  baseUrl: string;
  apiKey: string;
  displayName?: string;
  models?: ModelInfo[];
  defaultModel?: string;
}

export class OpenAICompatProvider implements LLMProvider {
  readonly id: string;
  readonly displayName: string;
  private readonly config: OpenAICompatConfig;

  constructor(id: string, config: OpenAICompatConfig) {
    this.id = id;
    this.displayName = config.displayName ?? id;
    this.config = config;
  }

  async listModels(): Promise<ModelInfo[]> {
    if (this.config.models?.length) return this.config.models;
    try {
      const raw = await this.httpRequest('GET', '/models');
      const data = JSON.parse(raw) as { data?: Array<{ id: string }> };
      return (data.data ?? []).map(m => ({
        id: m.id,
        displayName: m.id,
        contextWindow: 128000,
        maxOutputTokens: 4096,
        supportsTools: true,
        supportsStreaming: true,
      }));
    } catch {
      return [{
        id: this.config.defaultModel ?? 'default',
        displayName: this.config.defaultModel ?? 'Default Model',
        contextWindow: 128000,
        maxOutputTokens: 4096,
        supportsTools: true,
        supportsStreaming: true,
      }];
    }
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const body = this.buildRequestBody(request, false);
    const raw = await this.httpRequest('POST', '/chat/completions', body);
    const data = JSON.parse(raw);
    const choice = data.choices?.[0];
    const content: ContentBlock[] = [];

    if (choice?.message?.content) {
      content.push({ type: 'text', text: choice.message.content });
    }
    if (choice?.message?.tool_calls) {
      for (const tc of choice.message.tool_calls) {
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input: safeParse(tc.function.arguments),
        });
      }
    }

    return {
      content,
      model: data.model ?? request.model,
      inputTokens: data.usage?.prompt_tokens ?? 0,
      outputTokens: data.usage?.completion_tokens ?? 0,
      stopReason: choice?.finish_reason ?? 'stop',
    };
  }

  async *stream(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
    const body = this.buildRequestBody(request, true);
    const toolCalls = new Map<number, { id: string; name: string; args: string }>();

    try {
      for await (const chunk of this.streamSSE('/chat/completions', body)) {
        const choice = chunk.choices?.[0];
        if (!choice) continue;

        if (choice.delta?.content) {
          yield { type: 'text_delta', text: choice.delta.content };
        }

        if (choice.delta?.tool_calls) {
          for (const tc of choice.delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!toolCalls.has(idx)) {
              toolCalls.set(idx, { id: tc.id ?? '', name: '', args: '' });
            }
            const existing = toolCalls.get(idx)!;
            if (tc.id) existing.id = tc.id;
            if (tc.function?.name) existing.name = tc.function.name;
            if (tc.function?.arguments) existing.args += tc.function.arguments;
          }
        }

        if (choice.finish_reason) {
          for (const [, tc] of toolCalls) {
            yield {
              type: 'tool_use',
              toolUse: { id: tc.id, name: tc.name, input: safeParse(tc.args) },
            };
          }
          yield { type: 'stop', stopReason: choice.finish_reason };
        }
      }
    } catch (err: unknown) {
      yield { type: 'error', error: err instanceof Error ? err.message : String(err) };
    }
  }

  async healthCheck(): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.httpRequest('GET', '/models');
      return { ok: true };
    } catch (err: unknown) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private buildRequestBody(request: LLMRequest, stream: boolean): Record<string, unknown> {
    const messages: Array<Record<string, unknown>> = [];
    messages.push({ role: 'system', content: request.systemPrompt });

    for (const msg of request.messages) {
      if (typeof msg.content === 'string') {
        messages.push({ role: msg.role, content: msg.content });
      } else {
        const blocks = msg.content;
        const textParts = blocks.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('');
        const toolUses = blocks.filter(b => b.type === 'tool_use');
        const toolResults = blocks.filter(b => b.type === 'tool_result');

        if (toolUses.length > 0) {
          messages.push({
            role: 'assistant',
            content: textParts || null,
            tool_calls: toolUses.map(t => {
              const tu = t as { id: string; name: string; input: Record<string, unknown> };
              return {
                id: tu.id,
                type: 'function',
                function: { name: tu.name, arguments: JSON.stringify(tu.input) },
              };
            }),
          });
        } else if (toolResults.length > 0) {
          for (const tr of toolResults) {
            const r = tr as { tool_use_id: string; content: string };
            messages.push({ role: 'tool', tool_call_id: r.tool_use_id, content: r.content });
          }
        } else {
          messages.push({ role: msg.role, content: textParts });
        }
      }
    }

    const result: Record<string, unknown> = {
      model: request.model || this.config.defaultModel,
      messages,
      max_tokens: request.maxTokens ?? 4096,
      stream,
    };

    if (request.tools?.length) {
      result.tools = request.tools.map(t => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.input_schema },
      }));
    }

    if (request.temperature !== undefined) {
      result.temperature = request.temperature;
    }

    return result;
  }

  private httpRequest(method: string, path: string, body?: Record<string, unknown>): Promise<string> {
    return new Promise((resolve, reject) => {
      const url = new URL(this.config.baseUrl + path);
      const isSecure = url.protocol === 'https:';
      const options: http.RequestOptions = {
        hostname: url.hostname,
        port: url.port || (isSecure ? 443 : 80),
        path: url.pathname + url.search,
        method,
        headers: {
          'Authorization': `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
      };

      const req = (isSecure ? https : http).request(options, res => {
        let data = '';
        res.on('data', (chunk: Buffer) => (data += chunk.toString()));
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          } else {
            resolve(data);
          }
        });
      });
      req.on('error', reject);
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  private async *streamSSE(
    path: string,
    body: Record<string, unknown>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): AsyncIterable<any> {
    const url = new URL(this.config.baseUrl + path);
    const isSecure = url.protocol === 'https:';

    const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const options: http.RequestOptions = {
        hostname: url.hostname,
        port: url.port || (isSecure ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
      };
      const req = (isSecure ? https : http).request(options, resolve);
      req.on('error', reject);
      req.write(JSON.stringify(body));
      req.end();
    });

    if (response.statusCode && response.statusCode >= 400) {
      let data = '';
      for await (const chunk of response) data += chunk;
      throw new Error(`HTTP ${response.statusCode}: ${data}`);
    }

    let buffer = '';
    for await (const chunk of response) {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6);
        if (data === '[DONE]') return;
        try { yield JSON.parse(data); } catch { /* skip */ }
      }
    }
  }
}

function safeParse(json: string): Record<string, unknown> {
  try { return JSON.parse(json || '{}'); } catch { return {}; }
}
