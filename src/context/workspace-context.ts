import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';

export interface FileContent {
  path: string;
  content: string;
  language?: string;
}

export interface WorkspaceContext {
  workspaceRoot?: string;
  activeFile?: FileContent;
  selectedText?: string;
  openFiles: FileContent[];
  projectStructure: string;
  gitDiff?: string;
  recentTerminalOutput?: string;
}

const MAX_FILE_BYTES = 100_000;
const MAX_OPEN_FILES = 5;
const MAX_DIR_DEPTH = 3;
const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'out', '.vscode', '__pycache__',
  '.next', 'build', '.cache', 'coverage',
]);

export async function gatherWorkspaceContext(): Promise<WorkspaceContext> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const editor = vscode.window.activeTextEditor;

  const config = vscode.workspace.getConfiguration('goPilot');
  const maxOpenFiles = config.get<number>('context.maxOpenFiles', MAX_OPEN_FILES);

  const activeFile = editor
    ? readFileContent(editor.document.uri.fsPath, editor.document.languageId)
    : undefined;

  const selectedText = editor?.selection && !editor.selection.isEmpty
    ? editor.document.getText(editor.selection)
    : undefined;

  // Collect open tabs
  const openFiles: FileContent[] = [];
  for (const tabGroup of vscode.window.tabGroups.all) {
    for (const tab of tabGroup.tabs) {
      if (openFiles.length >= maxOpenFiles) break;
      const input = tab.input as { uri?: vscode.Uri } | undefined;
      if (!input?.uri) continue;
      const filePath = input.uri.fsPath;
      if (filePath === activeFile?.path) continue;
      const content = readFileContent(filePath);
      if (content) openFiles.push(content);
    }
  }

  const projectStructure = workspaceRoot
    ? buildDirectoryTree(workspaceRoot, MAX_DIR_DEPTH)
    : '(no workspace open)';

  // Get git diff for staged/unstaged changes
  const gitDiff = workspaceRoot ? getGitDiff(workspaceRoot) : undefined;

  return { workspaceRoot, activeFile, selectedText, openFiles, projectStructure, gitDiff };
}

function readFileContent(filePath: string, language?: string): FileContent | undefined {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return undefined;
    const content = fs.readFileSync(filePath, 'utf8');
    return { path: filePath, content, language };
  } catch {
    return undefined;
  }
}

function buildDirectoryTree(dir: string, maxDepth: number, depth = 0): string {
  if (depth > maxDepth) return '';
  const indent = '  '.repeat(depth);
  let result = '';

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return '';
  }

  const dirs = entries.filter(e => e.isDirectory() && !IGNORED_DIRS.has(e.name)).sort((a, b) => a.name.localeCompare(b.name));
  const files = entries.filter(e => e.isFile()).sort((a, b) => a.name.localeCompare(b.name));

  for (const d of dirs) {
    result += `${indent}${d.name}/\n`;
    result += buildDirectoryTree(path.join(dir, d.name), maxDepth, depth + 1);
  }
  for (const f of files) {
    result += `${indent}${f.name}\n`;
  }
  return result;
}

function getGitDiff(cwd: string): string | undefined {
  try {
    const diff = cp.execSync('git diff --stat HEAD 2>/dev/null || git diff --stat 2>/dev/null', {
      cwd,
      timeout: 5000,
      encoding: 'utf8',
      maxBuffer: 50_000,
    }).trim();
    return diff || undefined;
  } catch {
    return undefined;
  }
}

export function buildContextBlock(ctx: WorkspaceContext): string {
  const parts: string[] = [];

  if (ctx.workspaceRoot) {
    parts.push(`### Workspace\n${ctx.workspaceRoot}`);
  }

  if (ctx.projectStructure) {
    parts.push(`### Project Structure\n\`\`\`\n${ctx.projectStructure.trimEnd()}\n\`\`\``);
  }

  if (ctx.activeFile) {
    const header = ctx.selectedText
      ? `### Active File (with selection): ${ctx.activeFile.path}`
      : `### Active File: ${ctx.activeFile.path}`;
    const lang = ctx.activeFile.language ?? '';
    parts.push(`${header}\n\`\`\`${lang}\n${ctx.activeFile.content}\n\`\`\``);
  }

  if (ctx.selectedText) {
    parts.push(`### Selected Text\n\`\`\`\n${ctx.selectedText}\n\`\`\``);
  }

  if (ctx.openFiles.length > 0) {
    const fileBlocks = ctx.openFiles.map(f =>
      `#### ${f.path}\n\`\`\`\n${f.content}\n\`\`\``
    ).join('\n\n');
    parts.push(`### Other Open Files\n${fileBlocks}`);
  }

  if (ctx.gitDiff) {
    parts.push(`### Git Changes\n\`\`\`\n${ctx.gitDiff}\n\`\`\``);
  }

  return parts.join('\n\n');
}
