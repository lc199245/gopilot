import { marked } from 'marked';
import type { WebviewMessage, ExtensionMessage, ChangeEntry, SessionSummary } from './protocol';

// ── VSCode API ──
declare function acquireVsCodeApi(): {
  postMessage(msg: WebviewMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
};
const vscode = acquireVsCodeApi();

// ── DOM refs ──
const messagesEl = document.getElementById('messages')!;
const inputEl = document.getElementById('user-input') as HTMLTextAreaElement;
const btnSend = document.getElementById('btn-send') as HTMLButtonElement;
const btnCancel = document.getElementById('btn-cancel') as HTMLButtonElement;
const btnNew = document.getElementById('btn-new-conversation') as HTMLButtonElement;
const modelSelect = document.getElementById('model-select') as HTMLSelectElement;
const autocompleteEl = document.getElementById('autocomplete')!;
const changesPanel = document.getElementById('changes-panel')!;
const changesList = document.getElementById('changes-list')!;
const statAdditions = document.getElementById('stat-additions')!;
const statDeletions = document.getElementById('stat-deletions')!;
const statFiles = document.getElementById('stat-files')!;
const btnKeepAll = document.getElementById('btn-keep-all')!;
const btnDiscardAll = document.getElementById('btn-discard-all')!;
const btnToggleChanges = document.getElementById('btn-toggle-changes')!;

// ── State ──
let isStreaming = false;
let currentStreamEl: HTMLElement | null = null;
let streamText = '';

// ── Marked config ──
marked.setOptions({
  breaks: true,
  gfm: true,
});

// Override renderer to wrap code blocks with action buttons
const renderer = new marked.Renderer();

renderer.code = function (this: unknown, ...args: unknown[]): string {
  // marked v14+ passes an object { text, lang, escaped } as first arg
  let code: string;
  let lang: string;
  const first = args[0];
  if (first && typeof first === 'object' && 'text' in (first as Record<string, unknown>)) {
    const obj = first as { text: string; lang?: string };
    code = obj.text;
    lang = obj.lang || '';
  } else {
    code = String(args[0] ?? '');
    lang = String(args[1] ?? '');
  }
  const escaped = escapeHtml(code);
  const langLabel = lang || 'code';
  const encodedCode = encodeURIComponent(code);
  return `<div class="code-block-wrapper">
    <div class="code-block-header">
      <span class="code-lang">${escapeHtml(langLabel)}</span>
      <div class="code-actions">
        <button class="code-action-btn" onclick="handleCopy('${encodedCode}')" title="Copy">
          <svg viewBox="0 0 16 16"><rect x="5" y="1" width="9" height="11" rx="1" fill="none" stroke="currentColor" stroke-width="1.3"/><rect x="2" y="4" width="9" height="11" rx="1" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>
          Copy
        </button>
        <button class="code-action-btn" onclick="handleInsert('${encodedCode}')" title="Insert at Cursor">
          <svg viewBox="0 0 16 16"><path d="M8 2v12M4 10l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
          Insert
        </button>
      </div>
    </div>
    <pre><code class="language-${escapeHtml(lang)}">${escaped}</code></pre>
  </div>`;
};

marked.use({ renderer });

// ── Global handlers for code block buttons (called from onclick) ──
(window as any).handleCopy = (encodedCode: string) => {
  const code = decodeURIComponent(encodedCode);
  vscode.postMessage({ type: 'copyCode', code });
};

(window as any).handleInsert = (encodedCode: string) => {
  const code = decodeURIComponent(encodedCode);
  vscode.postMessage({ type: 'insertCode', code });
};

// ── Slash commands ──
const SLASH_COMMANDS = [
  { command: '/explain', description: 'Explain the selected code' },
  { command: '/fix', description: 'Find and fix bugs in the code' },
  { command: '/tests', description: 'Generate unit tests' },
  { command: '/doc', description: 'Add documentation comments' },
  { command: '/refactor', description: 'Refactor for readability' },
  { command: '/optimize', description: 'Optimize for performance' },
];

// ── Event Listeners ──
btnSend.addEventListener('click', sendMessage);

inputEl.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

inputEl.addEventListener('input', () => {
  autoResizeTextarea();
  handleAutocomplete();
});

btnCancel.addEventListener('click', () => {
  vscode.postMessage({ type: 'cancelStream' });
  finishStream();
});

btnNew.addEventListener('click', () => {
  vscode.postMessage({ type: 'newConversation' });
});

modelSelect.addEventListener('change', () => {
  vscode.postMessage({ type: 'selectModel', modelId: modelSelect.value });
});

let changesExpanded = true;
btnKeepAll.addEventListener('click', () => {
  vscode.postMessage({ type: 'keepAll' });
});
btnDiscardAll.addEventListener('click', () => {
  vscode.postMessage({ type: 'discardAll' });
});
btnToggleChanges.addEventListener('click', () => {
  changesExpanded = !changesExpanded;
  changesList.style.display = changesExpanded ? '' : 'none';
  btnToggleChanges.textContent = changesExpanded ? '\u25BC' : '\u25B6';
});

window.addEventListener('message', (event: MessageEvent) => {
  handleExtensionMessage(event.data as ExtensionMessage);
});

// Signal ready
vscode.postMessage({ type: 'ready' });

// ── Message Handlers ──
function handleExtensionMessage(msg: ExtensionMessage): void {
  switch (msg.type) {
    case 'streamDelta':
      handleStreamDelta(msg.text);
      break;

    case 'streamEnd':
      finishStream();
      break;

    case 'streamError':
      handleStreamError(msg.error);
      break;

    case 'modelsLoaded':
      populateModelSelect(msg.models, msg.activeModel);
      break;

    case 'contextInfo':
      showContextChips(msg.files, msg.skills);
      break;

    case 'thinkingStart':
      showThinking();
      break;

    case 'thinkingEnd':
      hideThinking();
      break;

    case 'toolProgress':
      handleToolProgress(msg.toolCallId, msg.toolName, msg.status);
      break;

    case 'toolResult':
      handleToolResult(msg.toolCallId, msg.toolName, msg.output, msg.success);
      break;

    case 'clear':
      messagesEl.innerHTML = '';
      hideChangesPanel();
      break;

    case 'welcome':
      showWelcome();
      break;

    case 'changesUpdated':
      renderChangesPanel(msg.changes, msg.stats);
      break;
  }
}

function sendMessage(): void {
  const text = inputEl.value.trim();
  if (!text || isStreaming) return;

  hideWelcome();
  appendUserMessage(text);
  inputEl.value = '';
  autoResizeTextarea();
  hideAutocomplete();

  vscode.postMessage({ type: 'sendMessage', text });

  setStreaming(true);
  streamText = '';
  currentStreamEl = createAssistantMessage();
}

function handleStreamDelta(text: string): void {
  if (!currentStreamEl) {
    currentStreamEl = createAssistantMessage();
  }
  streamText += text;
  const bodyEl = currentStreamEl.querySelector('.message-body')!;
  bodyEl.innerHTML = renderMarkdown(streamText);
  scrollToBottom();
}

function handleStreamError(error: string): void {
  if (currentStreamEl) {
    currentStreamEl.classList.add('error');
    const bodyEl = currentStreamEl.querySelector('.message-body')!;
    bodyEl.textContent = `Error: ${error}`;
  } else {
    const el = createAssistantMessage();
    el.classList.add('error');
    el.querySelector('.message-body')!.textContent = `Error: ${error}`;
  }
  finishStream();
}

function handleToolProgress(toolCallId: string, toolName: string, status: string): void {
  let card = document.getElementById(`tool-${toolCallId}`);
  if (!card) {
    card = createToolCard(toolCallId, toolName);
    // Insert before the current streaming message or at the end
    if (currentStreamEl) {
      const body = currentStreamEl.querySelector('.message-body')!;
      body.appendChild(card);
    } else {
      messagesEl.appendChild(card);
    }
  }

  const statusEl = card.querySelector('.tool-status')!;
  statusEl.className = `tool-status ${status}`;
  statusEl.textContent = status === 'running' ? 'Running...' : status === 'complete' ? 'Done' : 'Error';
  scrollToBottom();
}

function handleToolResult(toolCallId: string, toolName: string, output: string, success: boolean): void {
  let card = document.getElementById(`tool-${toolCallId}`);
  if (!card) {
    card = createToolCard(toolCallId, toolName);
    if (currentStreamEl) {
      currentStreamEl.querySelector('.message-body')!.appendChild(card);
    } else {
      messagesEl.appendChild(card);
    }
  }

  const bodyEl = card.querySelector('.tool-card-body')!;
  bodyEl.textContent = truncateOutput(output, 2000);

  const statusEl = card.querySelector('.tool-status')!;
  statusEl.className = `tool-status ${success ? 'complete' : 'error'}`;
  statusEl.textContent = success ? 'Done' : 'Error';
  scrollToBottom();
}

// ── UI Helpers ──
function appendUserMessage(text: string): void {
  const el = document.createElement('div');
  el.className = 'message user';
  el.innerHTML = `
    <div class="message-header">
      <div class="avatar user-avatar">
        <svg viewBox="0 0 16 16"><circle cx="8" cy="5" r="3" fill="currentColor"/><path d="M2 14c0-3.3 2.7-6 6-6s6 2.7 6 6H2z" fill="currentColor"/></svg>
      </div>
      <span class="message-role">You</span>
    </div>
    <div class="message-body">${escapeHtml(text)}</div>
  `;
  messagesEl.appendChild(el);
  scrollToBottom();
}

function createAssistantMessage(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'message assistant streaming';
  el.innerHTML = `
    <div class="message-header">
      <div class="avatar assistant-avatar">
        <svg viewBox="0 0 16 16"><path d="M8 1l2 4.5L15 7l-4 3 1.5 5L8 12.5 3.5 15 5 10 1 7l5-1.5L8 1z" fill="currentColor"/></svg>
      </div>
      <span class="message-role">Assistant</span>
    </div>
    <div class="message-body"></div>
  `;
  messagesEl.appendChild(el);
  scrollToBottom();
  return el;
}

function createToolCard(toolCallId: string, toolName: string): HTMLElement {
  const icons: Record<string, string> = {
    view_file: '\uD83D\uDCC4',
    edit_file: '\u270F\uFE0F',
    create_file: '\uD83D\uDCC1',
    run_command: '\u25B6',
    search_files: '\uD83D\uDD0D',
    list_directory: '\uD83D\uDCC2',
  };

  const card = document.createElement('div');
  card.id = `tool-${toolCallId}`;
  card.className = 'tool-card';
  card.innerHTML = `
    <div class="tool-card-header">
      <span class="tool-chevron">\u25B6</span>
      <span class="tool-icon">${icons[toolName] ?? '\u2699\uFE0F'}</span>
      <span class="tool-name">${escapeHtml(toolName.replace(/_/g, ' '))}</span>
      <span class="tool-status running">Running...</span>
    </div>
    <div class="tool-card-body"></div>
  `;

  card.querySelector('.tool-card-header')!.addEventListener('click', () => {
    card.classList.toggle('expanded');
  });

  return card;
}

function showThinking(): void {
  if (document.getElementById('thinking-indicator')) return;
  const el = document.createElement('div');
  el.id = 'thinking-indicator';
  el.className = 'thinking';
  el.innerHTML = `
    <div class="avatar assistant-avatar">
      <svg viewBox="0 0 16 16"><path d="M8 1l2 4.5L15 7l-4 3 1.5 5L8 12.5 3.5 15 5 10 1 7l5-1.5L8 1z" fill="currentColor"/></svg>
    </div>
    <div class="thinking-dots">
      <div class="thinking-dot"></div>
      <div class="thinking-dot"></div>
      <div class="thinking-dot"></div>
    </div>
    <span class="thinking-label">Thinking...</span>
  `;
  messagesEl.appendChild(el);
  scrollToBottom();
}

function hideThinking(): void {
  document.getElementById('thinking-indicator')?.remove();
}

function showWelcome(): void {
  hideWelcome();
  const el = document.createElement('div');
  el.id = 'welcome';
  el.innerHTML = `
    <div class="welcome-icon">
      <svg width="24" height="24" viewBox="0 0 16 16"><path d="M8 1l2 4.5L15 7l-4 3 1.5 5L8 12.5 3.5 15 5 10 1 7l5-1.5L8 1z" fill="currentColor"/></svg>
    </div>
    <div class="welcome-title">GoPilot</div>
    <div class="welcome-subtitle">I can help you understand, write, and improve your code. Ask me anything or use a slash command to get started.</div>
    <div class="quick-actions">
      <button class="quick-action-btn" data-prompt="/explain">
        <span class="quick-action-label">/explain</span>
        Explain the active file or selection
      </button>
      <button class="quick-action-btn" data-prompt="/fix">
        <span class="quick-action-label">/fix</span>
        Find and fix bugs
      </button>
      <button class="quick-action-btn" data-prompt="/tests">
        <span class="quick-action-label">/tests</span>
        Generate unit tests
      </button>
      <button class="quick-action-btn" data-prompt="What does this project do?">
        <span class="quick-action-label">Question</span>
        What does this project do?
      </button>
    </div>
  `;

  el.querySelectorAll('.quick-action-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const prompt = (btn as HTMLElement).dataset.prompt ?? '';
      inputEl.value = prompt;
      inputEl.focus();
      autoResizeTextarea();
    });
  });

  messagesEl.appendChild(el);
}

function hideWelcome(): void {
  document.getElementById('welcome')?.remove();
}

function showContextChips(files: string[], skills: string[]): void {
  // Remove existing context bar
  document.querySelectorAll('.context-bar').forEach(e => e.remove());

  if (files.length === 0 && skills.length === 0) return;

  const bar = document.createElement('div');
  bar.className = 'context-bar';

  for (const f of files.slice(0, 5)) {
    const name = f.split(/[/\\]/).pop() ?? f;
    const chip = document.createElement('span');
    chip.className = 'context-chip';
    chip.textContent = name;
    chip.title = f;
    bar.appendChild(chip);
  }

  for (const s of skills) {
    const chip = document.createElement('span');
    chip.className = 'context-chip';
    chip.textContent = `skill: ${s}`;
    bar.appendChild(chip);
  }

  // Insert before the last message
  const lastMsg = messagesEl.lastElementChild;
  if (lastMsg) {
    messagesEl.insertBefore(bar, lastMsg);
  }
}

function setStreaming(value: boolean): void {
  isStreaming = value;
  btnSend.disabled = value;
  inputEl.disabled = value;
  btnCancel.classList.toggle('visible', value);
}

function finishStream(): void {
  if (currentStreamEl) {
    currentStreamEl.classList.remove('streaming');
    // Final render of complete markdown
    if (streamText) {
      const bodyEl = currentStreamEl.querySelector('.message-body')!;
      bodyEl.innerHTML = renderMarkdown(streamText);
    }
    currentStreamEl = null;
    streamText = '';
  }
  hideThinking();
  setStreaming(false);
}

function scrollToBottom(): void {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function renderMarkdown(text: string): string {
  try {
    return marked.parse(text) as string;
  } catch {
    return escapeHtml(text);
  }
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function truncateOutput(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '\n... (truncated)';
}

// ── Textarea auto-resize ──
function autoResizeTextarea(): void {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 150) + 'px';
}

// ── Autocomplete ──
function handleAutocomplete(): void {
  const text = inputEl.value;

  if (text.startsWith('/') && !text.includes(' ')) {
    const query = text.slice(1).toLowerCase();
    const matches = SLASH_COMMANDS.filter(c => c.command.slice(1).startsWith(query));
    if (matches.length > 0) {
      showAutocomplete(matches);
      return;
    }
  }

  hideAutocomplete();
}

function showAutocomplete(items: Array<{ command: string; description: string }>): void {
  autocompleteEl.innerHTML = '';
  for (const item of items) {
    const el = document.createElement('div');
    el.className = 'autocomplete-item';
    el.innerHTML = `<span class="autocomplete-cmd">${escapeHtml(item.command)}</span><span class="autocomplete-desc">${escapeHtml(item.description)}</span>`;
    el.addEventListener('click', () => {
      inputEl.value = item.command + ' ';
      inputEl.focus();
      hideAutocomplete();
    });
    autocompleteEl.appendChild(el);
  }
  autocompleteEl.classList.add('visible');
}

function hideAutocomplete(): void {
  autocompleteEl.classList.remove('visible');
}

// ── Model select ──
function populateModelSelect(
  models: Array<{ id: string; displayName: string }>,
  activeModel: string
): void {
  modelSelect.innerHTML = '';
  for (const model of models) {
    const opt = document.createElement('option');
    opt.value = model.id;
    opt.textContent = model.displayName;
    opt.selected = model.id === activeModel;
    modelSelect.appendChild(opt);
  }
}

// ── Changes Panel ──
function renderChangesPanel(
  changes: ChangeEntry[],
  stats: { totalAdditions: number; totalDeletions: number; filesChanged: number }
): void {
  // Only show entries that aren't fully discarded
  const visible = changes.filter(c => !c.discarded);

  if (visible.length === 0) {
    hideChangesPanel();
    return;
  }

  changesPanel.classList.add('visible');
  statAdditions.textContent = `+${stats.totalAdditions}`;
  statDeletions.textContent = `-${stats.totalDeletions}`;
  statFiles.textContent = `${stats.filesChanged} file${stats.filesChanged !== 1 ? 's' : ''}`;

  changesList.innerHTML = '';
  for (const change of visible) {
    const row = document.createElement('div');
    row.className = 'change-row';
    row.dataset.changeId = change.id;

    const iconClass = change.kind === 'create' ? 'create' : 'edit';
    const iconChar = change.kind === 'create' ? 'A' : 'M';  // Added / Modified

    // Show only the filename but keep the full relative path as title for hover
    const fileName = change.relativePath.split(/[/\\]/).pop() ?? change.relativePath;
    const dirPart = change.relativePath.includes('/') || change.relativePath.includes('\\')
      ? change.relativePath.substring(0, change.relativePath.lastIndexOf(change.relativePath.includes('/') ? '/' : '\\'))
      : '';

    row.innerHTML = `
      <span class="change-icon ${iconClass}">${iconChar}</span>
      <span class="change-file" title="${escapeHtml(change.relativePath)}">
        <span class="change-filename">${escapeHtml(fileName)}</span>
        ${dirPart ? `<span class="change-dir">${escapeHtml(dirPart)}</span>` : ''}
      </span>
      <span class="change-nums">
        <span class="stat-add">+${change.additions}</span>
        <span class="stat-del">-${change.deletions}</span>
      </span>
      <span class="change-row-actions">
        <button class="change-row-btn" data-action="diff" title="Show diff">
          <svg viewBox="0 0 16 16" width="12" height="12"><path d="M1 4h14M1 8h8M1 12h11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
          diff
        </button>
        <button class="change-row-btn btn-keep" data-action="keep" title="Keep changes">&#10003;</button>
        <button class="change-row-btn btn-discard" data-action="discard" title="Discard changes">&#10007;</button>
      </span>
    `;

    row.querySelectorAll('.change-row-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const action = (btn as HTMLElement).dataset.action;
        if (action === 'diff') {
          vscode.postMessage({ type: 'showDiff', changeId: change.id });
        } else if (action === 'keep') {
          vscode.postMessage({ type: 'keepChange', changeId: change.id });
          row.remove();
          // Hide panel if no rows remain
          if (changesList.children.length === 0) hideChangesPanel();
        } else if (action === 'discard') {
          vscode.postMessage({ type: 'discardChange', changeId: change.id });
        }
      });
    });

    changesList.appendChild(row);
  }
}

function hideChangesPanel(): void {
  changesPanel.classList.remove('visible');
  changesList.innerHTML = '';
}
