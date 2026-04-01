# CLAUDE.md — LLM Copilot VSCode Extension

> Auto-loaded project context for Claude Code.
> Source design doc: `vscode-llm-copilot-design.md` v1.0 (2026-03-31)

---

## Project Goal

Build a VSCode extension ("LLM Copilot") that replicates and extends GitHub Copilot Chat, powered by configurable LLM backends. Ships with Anthropic Claude support; designed for easy swap to a corporate API.

**Key differentiators:**
- **SKILL-aware** — auto-discovers `SKILL.md` files in the workspace and injects them into the LLM system prompt
- **Provider-agnostic** — switch between Anthropic, OpenAI-compatible, or custom corporate endpoints via `settings.json`
- **Fully owned** — no telemetry, runs on user's own API keys

**Stack:** TypeScript throughout (extension host + webview), Webpack bundler, VSIX packaging for sideloading (no Marketplace dependency).

---

## Folder Structure

```
llm-copilot/
├── src/
│   ├── extension.ts             # Entry point (activate/deactivate)
│   ├── commands.ts              # Command registrations
│   ├── providers/
│   │   ├── types.ts             # LLMProvider interface + shared types
│   │   ├── registry.ts          # ProviderRegistry (Map-based)
│   │   ├── anthropic.ts         # AnthropicProvider (default)
│   │   ├── openai-compat.ts     # OpenAICompatProvider
│   │   └── custom-template.ts   # Template for corporate providers
│   ├── skills/
│   │   ├── skill-loader.ts      # Discover & parse SKILL.md files
│   │   ├── skill-matcher.ts     # Match skills to context (trigger/tag matching)
│   │   └── types.ts
│   ├── tools/
│   │   ├── definitions.ts       # Tool schemas for LLM
│   │   ├── executor.ts          # Dispatch tool calls to implementations
│   │   ├── approval.ts          # Human-in-the-loop approval logic
│   │   ├── file-tools.ts        # view_file, edit_file, create_file
│   │   ├── terminal-tools.ts    # run_command
│   │   └── search-tools.ts      # search_files, list_directory
│   ├── context/
│   │   ├── workspace-context.ts # Gathers active file, open tabs, git diff, etc.
│   │   ├── token-counter.ts     # Heuristic token estimation (chars / 4)
│   │   └── file-reader.ts       # Safe file reading with size limits
│   ├── prompt/
│   │   ├── prompt-builder.ts    # Assembles system prompt from context + skills
│   │   ├── system-prompt.ts     # Core system prompt template string
│   │   └── output-parser.ts     # Parse structured LLM output if needed
│   ├── chat/
│   │   ├── chat-panel.ts        # WebviewPanel lifecycle management
│   │   ├── conversation.ts      # Conversation state + sliding history window
│   │   └── message-handler.ts   # Agentic loop (stream → tool use → continue)
│   └── webview/
│       ├── index.html           # Webview HTML shell
│       ├── main.ts              # Webview TS entry (vanilla TS, no framework)
│       ├── components/          # UI components: message, code-block, diff, tool-card
│       ├── styles/chat.css
│       └── protocol.ts          # Shared message type definitions (webview ↔ extension)
├── test/
│   ├── providers/
│   ├── skills/
│   ├── tools/
│   └── integration/
├── package.json                 # Extension manifest + contributes
├── tsconfig.json
├── webpack.config.js            # Bundles extension + webview separately
└── .vscodeignore
```

---

## Core Interfaces

### LLM Provider (`src/providers/types.ts`)

```typescript
export interface LLMProvider {
  readonly id: string;
  readonly displayName: string;
  listModels(): Promise<ModelInfo[]>;
  complete(request: LLMRequest): Promise<LLMResponse>;
  stream(request: LLMRequest): AsyncIterable<LLMStreamEvent>;
  healthCheck(): Promise<{ ok: boolean; error?: string }>;
}

export interface LLMStreamEvent {
  type: 'text_delta' | 'tool_use' | 'stop' | 'error';
  text?: string;
  toolUse?: { name: string; input: Record<string, unknown> };
  error?: string;
}

export interface ModelInfo {
  id: string;
  displayName: string;
  contextWindow: number;
  maxOutputTokens: number;
  supportsTools: boolean;
  supportsStreaming: boolean;
}
```

### Workspace Context (`src/context/workspace-context.ts`)

```typescript
export interface WorkspaceContext {
  activeFile?: FileContent;
  selectedText?: string;
  openFiles: FileContent[];
  projectStructure: string;
  gitDiff?: string;
  recentTerminalOutput?: string;
  relevantFiles?: FileContent[];
}
```

### Webview ↔ Extension Protocol (`src/webview/protocol.ts`)

```typescript
type WebviewMessage =
  | { type: 'sendMessage'; text: string; attachments?: FileRef[] }
  | { type: 'cancelStream' }
  | { type: 'selectModel'; modelId: string }
  | { type: 'approveToolUse'; toolCallId: string }
  | { type: 'rejectToolUse'; toolCallId: string }
  | { type: 'newConversation' }
  | { type: 'exportConversation' };

type ExtensionMessage =
  | { type: 'streamDelta'; text: string }
  | { type: 'streamEnd' }
  | { type: 'streamError'; error: string }
  | { type: 'toolUseRequest'; toolCallId: string; toolName: string; input: any; preview?: string }
  | { type: 'toolResult'; toolCallId: string; output: string; success: boolean }
  | { type: 'modelsLoaded'; models: ModelInfo[]; activeModel: string }
  | { type: 'contextInfo'; files: string[]; skills: string[] };
```

---

## Tool Definitions

Six built-in tools exposed to the LLM:

| Tool | Description | Approval required? |
|------|-------------|-------------------|
| `view_file` | Read file contents (with optional line range) | No (read-only) |
| `edit_file` | Search-and-replace edit (oldText → newText) | Yes — show diff first |
| `create_file` | Create a new file | Yes |
| `run_command` | Execute shell command in integrated terminal | Yes — show command first |
| `search_files` | Regex/text search across workspace | No |
| `list_directory` | Browse directory tree (configurable depth) | No |

**Approval modes** (configurable via settings):
- `always-ask` — every tool call requires user click
- `ask-writes` (default) — reads auto-approve, writes/commands ask
- `auto-approve` — trust the model

---

## SKILL System

### Discovery
The `SkillLoader` scans `<workspaceRoot>/skills/*/SKILL.md` on activation.

### SKILL.md Format
```markdown
---
name: python-fastapi
description: "Best practices for FastAPI backend development"
triggers:
  - "*.py"
  - "fastapi"
tags: [python, backend, api]
---

# FastAPI Development Guidelines
...
```

### Selection Logic
1. Match file extension of active file against skill `triggers`
2. Match keywords in user query against `triggers` and `tags`
3. Fit as many matching skills as possible within token budget (default 4,000 tokens)
4. Inject selected skills into system prompt under `## Workspace Skills`

### @-mention Syntax (in chat input)
- `@src/models/portfolio.py` — force-include a file in context
- `@skills/sql-oracle` — force-include a specific skill
- `#terminal` — include recent terminal output

---

## Agentic Loop (`src/chat/message-handler.ts`)

```typescript
async function handleUserMessage(userText, provider, context, skills, conversation, panel) {
  const request = promptBuilder.build(context, skills, userText, conversation.history);
  let continueLoop = true;

  while (continueLoop) {
    const stream = provider.stream(request);
    let pendingToolCalls: ToolCall[] = [];

    for await (const event of stream) {
      if (event.type === 'text_delta') panel.appendStreamText(event.text!);
      if (event.type === 'tool_use')   pendingToolCalls.push(event.toolUse!);
      if (event.type === 'stop')       continueLoop = false;
    }

    if (pendingToolCalls.length > 0) {
      const toolResults = await processToolCalls(pendingToolCalls, panel);
      conversation.addAssistantMessage(/* streamed text + tool calls */);
      conversation.addToolResults(toolResults);
      request.messages = conversation.toMessages();
      continueLoop = true; // loop back for LLM's next response
    }
  }
}
```

---

## Token Budget (200K context window)

| Slot | Budget |
|------|--------|
| System prompt (base) | ~2,000 tokens |
| SKILL content | ~4,000 tokens (configurable) |
| Workspace context | ~10,000 tokens |
| Conversation history | ~30,000 tokens (sliding window) |
| Output reservation | ~8,000 tokens |

Token estimation: `Math.ceil(text.length / 4)` — avoids tiktoken dependency, ~10% accuracy sufficient.

---

## VSCode Settings Schema

```jsonc
{
  "llmCopilot.activeProvider": "anthropic",
  "llmCopilot.approvalMode": "ask-writes",       // "always-ask" | "ask-writes" | "auto-approve"
  "llmCopilot.skills.enabled": true,
  "llmCopilot.skills.tokenBudget": 4000,
  "llmCopilot.context.maxOpenFiles": 5,
  "llmCopilot.providers": {
    "anthropic": {
      "apiKey": "${env:ANTHROPIC_API_KEY}",
      "defaultModel": "claude-sonnet-4-20250514"
    },
    "corporate": {
      "type": "openai-compat",
      "baseUrl": "https://llm.corp.internal/v1",
      "apiKey": "${env:CORP_LLM_KEY}",
      "displayName": "Corp GPT"
    }
  }
}
```

---

## System Prompt Template

```
You are an AI coding assistant integrated into VSCode.

## Capabilities
Tools available: view_file, edit_file, create_file, run_command, search_files, list_directory

## Rules
1. Always view a file before editing it.
2. Make minimal, targeted edits — don't rewrite entire files.
3. Explain what you're doing and why before making changes.
4. After edits, offer to run relevant commands (tests, build, lint).
5. If unsure, ask the user rather than guessing.

## Workspace Skills
{{SKILLS_CONTENT}}

## Current Context
{{WORKSPACE_CONTEXT}}
```

---

## Build Phases — Current Status

| Phase | Scope | Status |
|-------|-------|--------|
| **Phase 1** | Scaffold, AnthropicProvider + streaming, basic chat webview, model dropdown, Webpack | 🔲 Not started |
| **Phase 2** | WorkspaceContextEngine, SkillLoader, PromptBuilder, @-mention syntax | 🔲 Not started |
| **Phase 3** | Tool definitions, executor, approval flow, diff preview UI, terminal integration, agentic loop | 🔲 Not started |
| **Phase 4** | OpenAICompatProvider, settings-driven config, health check UI, right-click commands, history export | 🔲 Not started |
| **Phase 5** | CustomCorporateProvider, VSIX packaging, internal distribution | 🔲 Not started |

**Start with Phase 1.** Use `yo code` to scaffold (TypeScript extension), then implement `AnthropicProvider` with SSE streaming via `@anthropic-ai/sdk`.

---

## Key Design Decisions

| Decision | Choice |
|----------|--------|
| Webview framework | Vanilla TypeScript + CSS (no React/Svelte) |
| Streaming | SSE via `@anthropic-ai/sdk` |
| Tool approval default | `ask-writes` |
| SKILL injection point | System prompt (not conversation) |
| Token counting | Heuristic `chars / 4` |
| Provider abstraction | Interface + registry pattern |
| Packaging | VSIX sideload only (no Marketplace) |

---

## Reference Links

- VSCode Extension API: https://code.visualstudio.com/api
- Anthropic SDK: `@anthropic-ai/sdk` (npm)
- Reference implementations: Continue.dev (MIT), Cline (open source)
