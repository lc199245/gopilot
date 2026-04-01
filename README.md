# GoPilot

A VS Code extension that replicates GitHub Copilot Chat, powered by configurable LLM backends. Ships with Anthropic Claude support and an OpenAI-compatible provider for corporate/self-hosted endpoints.

**No telemetry. Runs on your own API keys. Fully owned.**

## Features

- **Sidebar chat** matching Copilot Chat's look and feel
- **Markdown rendering** with syntax-styled code blocks, copy and insert-at-cursor buttons
- **Agentic tool use** — the LLM can read, edit, create files, run terminal commands, and search your workspace
- **Change tracker** — shows +/- stats for every file the LLM touched, with diff view and keep/discard per file
- **Provider-agnostic** — switch between Anthropic, OpenAI-compatible, or custom corporate endpoints via settings
- **SKILL system** — auto-discovers `SKILL.md` files in your workspace and injects them into the LLM context
- **Slash commands** — `/explain`, `/fix`, `/tests`, `/doc`, `/refactor`, `/optimize`
- **@-mentions** — `@path/to/file` to include a file in context, `#terminal` for recent terminal output
- **Right-click context menu** — select code, right-click, choose Explain / Fix / Tests / Doc / Refactor
- **Tool approval** — configurable modes: `always-ask`, `ask-writes` (default), `auto-approve`, plus per-conversation "Always Allow"
- **Session history** — conversations persist across restarts

## Prerequisites

- [Node.js](https://nodejs.org/) >= 18
- [VS Code](https://code.visualstudio.com/) >= 1.85.0
- An LLM API key (Anthropic, or any OpenAI-compatible endpoint)

## Development Setup

```bash
# 1. Clone the repo
git clone https://github.com/lc199245/gopilot.git
cd gopilot

# 2. Install dependencies
npm install

# 3. Compile (development mode)
npm run compile

# 4. Open in VS Code
code .
```

> **Important:** You must run `npm install` and `npm run compile` before launching. The `node_modules/` and `dist/` folders are not checked into git. Skipping this step will cause an activation error.

### Running in Development

1. Open the project in VS Code
2. Press **F5** (or Run > Start Debugging)
   - This launches an **Extension Development Host** window with GoPilot loaded
   - The `.vscode/launch.json` is pre-configured to compile and launch
3. In the new window, click the chat icon in the activity bar (left sidebar) to open GoPilot

### Troubleshooting: "Cannot find module extensionHostProcess.js"

This error means the extension failed to activate, usually because it wasn't compiled:

1. Make sure you ran `npm install` and `npm run compile` first
2. Try `Ctrl+Shift+P` > "Developer: Reload Window", then F5 again
3. Verify your VS Code version is **1.85.0 or newer** (`Help > About`) — older corporate installs may have this bug

### Watch Mode

For live recompilation as you edit:

```bash
npm run watch
```

Then press F5 — changes to source files will auto-recompile. Use `Ctrl+Shift+P` > "Developer: Reload Window" in the dev host to pick up changes.

### Available Scripts

| Script | Command | Description |
|--------|---------|-------------|
| `npm run compile` | `webpack --mode development` | One-time dev build |
| `npm run build` | `webpack --mode production` | Minified production build |
| `npm run watch` | `webpack --mode development --watch` | Auto-recompile on save |
| `npm run typecheck` | `tsc --noEmit` | Type-check without emitting |
| `npm run package` | `vsce package` | Package into `.vsix` for distribution |

## Configuration

Set these in VS Code settings (`Ctrl+,`) or `.vscode/settings.json`:

### Using Anthropic (default)

Set the `ANTHROPIC_API_KEY` environment variable, or configure it in settings:

```jsonc
{
  "goPilot.activeProvider": "anthropic",
  "goPilot.providers": {
    "anthropic": {
      "apiKey": "${env:ANTHROPIC_API_KEY}",
      "defaultModel": "claude-sonnet-4-6"
    }
  }
}
```

### Using a Corporate / OpenAI-Compatible Endpoint

```jsonc
{
  "goPilot.activeProvider": "corporate",
  "goPilot.providers": {
    "corporate": {
      "type": "openai-compat",
      "baseUrl": "https://llm.your-company.com/v1",
      "apiKey": "${env:CORP_LLM_KEY}",
      "displayName": "Corp LLM",
      "defaultModel": "your-model-id"
    }
  }
}
```

### All Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `goPilot.activeProvider` | `"anthropic"` | Which provider to use |
| `goPilot.approvalMode` | `"ask-writes"` | Tool approval: `always-ask`, `ask-writes`, `auto-approve` |
| `goPilot.skills.enabled` | `true` | Auto-discover SKILL.md files |
| `goPilot.skills.tokenBudget` | `4000` | Max tokens for skill content in system prompt |
| `goPilot.context.maxOpenFiles` | `5` | Max open files included in context |
| `goPilot.providers` | `{}` | Provider configs (see examples above) |

## Testing the Extension

### Quick Smoke Test

1. Press F5 to launch the dev host
2. Open any project folder in the dev host
3. Click the GoPilot icon in the activity bar
4. Type "Hello" and press Enter — you should see a streamed response
5. Try `/explain` with some code selected — the slash command should expand and explain

### Testing Tools

1. Ask: "List the files in this project" — should trigger `list_directory`
2. Ask: "Read the contents of package.json" — should trigger `view_file`
3. Ask: "Add a comment to the top of package.json" — should trigger `edit_file` and ask for approval
4. Check the **Changes panel** at the bottom — it should show the edit with +/- stats
5. Click **diff** to see before/after, **discard** to revert

### Testing the Change Tracker

1. Ask the LLM to make a few edits across different files
2. The changes panel appears showing per-file stats (additions/deletions)
3. Click **diff** on any file to open VS Code's diff editor
4. Click the checkmark to keep, or X to discard (reverts the file)
5. **Keep All** / **Discard All** for bulk operations

### Testing Context Menu

1. Select some code in the editor
2. Right-click > **GoPilot** submenu
3. Choose "Explain This", "Fix This", "Generate Tests", etc.

### Testing Slash Commands

Type these in the chat input:

- `/explain` — explains selected code or active file
- `/fix` — finds and fixes bugs
- `/tests` — generates unit tests
- `/doc` — adds documentation comments
- `/refactor` — refactors for readability
- `/optimize` — optimizes for performance

### Testing @-mentions

- `@src/extension.ts` — includes the file in context
- `#terminal` — includes recent terminal output

## Packaging for Distribution

```bash
# Build production bundle and package
npm run build
npx vsce package
```

This produces `gopilot-0.2.0.vsix`. Install it on any machine:

```bash
code --install-extension gopilot-0.2.0.vsix
```

Or in VS Code: `Ctrl+Shift+P` > "Extensions: Install from VSIX..."

## Project Structure

```
gopilot/
├── src/
│   ├── extension.ts             # Entry point (activate/deactivate)
│   ├── commands.ts              # Command registrations + context menu
│   ├── providers/
│   │   ├── types.ts             # LLMProvider interface + shared types
│   │   ├── registry.ts          # Provider registry
│   │   ├── anthropic.ts         # Anthropic Claude provider
│   │   └── openai-compat.ts     # OpenAI-compatible provider
│   ├── skills/
│   │   ├── types.ts             # Skill interfaces
│   │   ├── skill-loader.ts      # Discover & parse SKILL.md files
│   │   └── skill-matcher.ts     # Match skills to context
│   ├── tools/
│   │   ├── definitions.ts       # Tool schemas for LLM
│   │   ├── executor.ts          # Dispatch tool calls
│   │   ├── approval.ts          # Human-in-the-loop approval
│   │   ├── change-tracker.ts    # Tracks file changes with diff/discard
│   │   ├── file-tools.ts        # view_file, edit_file, create_file
│   │   ├── terminal-tools.ts    # run_command
│   │   └── search-tools.ts      # search_files, list_directory
│   ├── context/
│   │   └── workspace-context.ts # Gathers active file, open tabs, git diff
│   ├── prompt/
│   │   ├── system-prompt.ts     # Base system prompt template
│   │   └── prompt-builder.ts    # Assembles system prompt + context + skills
│   ├── chat/
│   │   ├── chat-view-provider.ts # Sidebar WebviewViewProvider (primary)
│   │   ├── chat-panel.ts        # Pop-out editor panel
│   │   ├── conversation.ts      # Message history + token management
│   │   ├── message-handler.ts   # Agentic loop (stream → tools → loop)
│   │   └── session-store.ts     # Conversation persistence
│   └── webview/
│       ├── index.html           # Chat UI shell + styles
│       ├── main.ts              # Webview logic (markdown, code blocks, tools)
│       └── protocol.ts          # Message types (webview <-> extension)
├── package.json                 # Extension manifest
├── tsconfig.json
├── webpack.config.js            # Bundles extension + webview separately
└── .vscodeignore
```

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Shift+I` | Focus GoPilot chat |
| `Ctrl+Shift+N` | New conversation (when chat is visible) |

## Adding a Custom Provider

To connect to a new LLM backend, you have two options:

### Option 1: OpenAI-Compatible API

If your endpoint speaks the OpenAI chat completions format, just add it to settings — no code changes needed.

### Option 2: Python SDK Sidecar

If your company provides a Python SDK, you can wrap it in a small FastAPI server that exposes an OpenAI-compatible endpoint on localhost, then point GoPilot at it:

```python
# sidecar.py (example)
from fastapi import FastAPI
from your_company_sdk import CompanyLLM

app = FastAPI()
client = CompanyLLM()

@app.post("/v1/chat/completions")
async def chat(request: dict):
    # Translate and proxy to your SDK
    ...
```

Then configure: `"baseUrl": "http://localhost:8000/v1"`

## License

Private / Internal Use
