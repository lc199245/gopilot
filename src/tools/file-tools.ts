import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ChangeTracker } from './change-tracker';

/** Module-level reference set by the message handler before tool execution */
let activeChangeTracker: ChangeTracker | undefined;

export function setChangeTracker(tracker: ChangeTracker | undefined): void {
  activeChangeTracker = tracker;
}

function resolvePath(filePath: string): string {
  if (path.isAbsolute(filePath)) return filePath;
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) throw new Error('No workspace folder open');
  return path.join(root, filePath);
}

export async function viewFile(input: Record<string, unknown>): Promise<string> {
  const filePath = resolvePath(input.path as string);
  const startLine = input.start_line as number | undefined;
  const endLine = input.end_line as number | undefined;

  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const stat = fs.statSync(filePath);
  if (stat.size > 500_000) {
    throw new Error(`File too large (${(stat.size / 1024).toFixed(0)} KB). Use start_line/end_line to read a portion.`);
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');

  if (startLine || endLine) {
    const start = Math.max(1, startLine ?? 1);
    const end = Math.min(lines.length, endLine ?? lines.length);
    const slice = lines.slice(start - 1, end);
    const numbered = slice.map((line, i) => `${start + i}\u2502 ${line}`).join('\n');
    return `File: ${filePath} (lines ${start}-${end} of ${lines.length})\n\n${numbered}`;
  }

  const numbered = lines.map((line, i) => `${i + 1}\u2502 ${line}`).join('\n');
  return `File: ${filePath} (${lines.length} lines)\n\n${numbered}`;
}

export async function editFile(input: Record<string, unknown>): Promise<string> {
  const filePath = resolvePath(input.path as string);
  const oldText = input.old_text as string;
  const newText = input.new_text as string;

  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const contentBefore = fs.readFileSync(filePath, 'utf8');
  const idx = contentBefore.indexOf(oldText);
  if (idx === -1) {
    throw new Error(`Could not find the specified text in ${filePath}. Make sure old_text matches exactly (including whitespace).`);
  }

  const secondIdx = contentBefore.indexOf(oldText, idx + 1);
  if (secondIdx !== -1) {
    throw new Error(`Found multiple matches for old_text in ${filePath}. Please provide more context to make the match unique.`);
  }

  const contentAfter = contentBefore.slice(0, idx) + newText + contentBefore.slice(idx + oldText.length);
  fs.writeFileSync(filePath, contentAfter, 'utf8');

  // Track the change
  activeChangeTracker?.recordEdit(filePath, contentBefore, contentAfter);

  // Notify VS Code that the file changed on disk (so open editors refresh) without revealing it
  const uri = vscode.Uri.file(filePath);
  const openDoc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === filePath);
  if (openDoc) {
    // The document is already open; revert it silently so it reflects the new content
    await vscode.commands.executeCommand('workbench.action.files.revert', uri);
  }

  const oldLines = oldText.split('\n').length;
  const newLines = newText.split('\n').length;
  return `Edited ${filePath}: replaced ${oldLines} line(s) with ${newLines} line(s).`;
}

export async function createFile(input: Record<string, unknown>): Promise<string> {
  const filePath = resolvePath(input.path as string);
  const content = input.content as string;

  if (fs.existsSync(filePath)) {
    throw new Error(`File already exists: ${filePath}. Use edit_file to modify it.`);
  }

  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');

  // Track the change
  activeChangeTracker?.recordCreate(filePath, content);

  // Don't open the file in the editor — changes happen silently in the background
  const lineCount = content.split('\n').length;
  return `Created ${filePath} (${lineCount} lines).`;
}
