import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export interface FileChange {
  /** Unique ID for this change */
  id: string;
  /** Absolute file path */
  filePath: string;
  /** Workspace-relative path for display */
  relativePath: string;
  /** File content before the change (empty string for new files) */
  before: string;
  /** File content after the change */
  after: string;
  /** Number of lines added */
  additions: number;
  /** Number of lines removed */
  deletions: number;
  /** 'edit' or 'create' */
  kind: 'edit' | 'create';
  /** Timestamp */
  timestamp: number;
  /** Whether the change has been discarded */
  discarded: boolean;
}

export interface ChangeStats {
  totalAdditions: number;
  totalDeletions: number;
  filesChanged: number;
}

/**
 * Tracks all file changes made by the LLM during a conversation session.
 * Supports viewing diffs and discarding (reverting) individual changes.
 */
export class ChangeTracker {
  private changes: FileChange[] = [];
  private idCounter = 0;

  /** Record a file edit (before/after content) */
  recordEdit(filePath: string, before: string, after: string): FileChange {
    const { additions, deletions } = diffStats(before, after);
    const change: FileChange = {
      id: `change-${++this.idCounter}`,
      filePath,
      relativePath: this.toRelative(filePath),
      before,
      after,
      additions,
      deletions,
      kind: 'edit',
      timestamp: Date.now(),
      discarded: false,
    };
    this.changes.push(change);
    return change;
  }

  /** Record a new file creation */
  recordCreate(filePath: string, content: string): FileChange {
    const lines = content.split('\n').length;
    const change: FileChange = {
      id: `change-${++this.idCounter}`,
      filePath,
      relativePath: this.toRelative(filePath),
      before: '',
      after: content,
      additions: lines,
      deletions: 0,
      kind: 'create',
      timestamp: Date.now(),
      discarded: false,
    };
    this.changes.push(change);
    return change;
  }

  /** Get aggregate stats for the session */
  getStats(): ChangeStats {
    let totalAdditions = 0;
    let totalDeletions = 0;
    const files = new Set<string>();

    for (const c of this.changes) {
      if (c.discarded) continue;
      totalAdditions += c.additions;
      totalDeletions += c.deletions;
      files.add(c.filePath);
    }

    return { totalAdditions, totalDeletions, filesChanged: files.size };
  }

  /** Get all active (non-discarded) changes */
  getChanges(): FileChange[] {
    return this.changes.filter(c => !c.discarded);
  }

  /** Get all changes including discarded */
  getAllChanges(): FileChange[] {
    return [...this.changes];
  }

  /** Find a change by ID */
  getChange(id: string): FileChange | undefined {
    return this.changes.find(c => c.id === id);
  }

  /**
   * Discard all active changes for a given file path (grouped discard).
   * Restores the file to the state it was in before the first recorded change.
   */
  async discardFile(filePath: string): Promise<boolean> {
    const fileChanges = this.changes.filter(c => !c.discarded && c.filePath === filePath);
    if (fileChanges.length === 0) return false;

    // The earliest change holds the original "before" content
    fileChanges.sort((a, b) => a.timestamp - b.timestamp);
    const earliest = fileChanges[0];

    try {
      if (earliest.kind === 'create') {
        // Delete the created file
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      } else {
        // Restore the file to the state before the first edit
        fs.writeFileSync(filePath, earliest.before, 'utf8');
        // If the file is open in an editor, revert it silently
        const uri = vscode.Uri.file(filePath);
        const openDoc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === filePath);
        if (openDoc) {
          await vscode.commands.executeCommand('workbench.action.files.revert', uri);
        }
      }
      // Mark all changes for this file as discarded
      for (const c of fileChanges) {
        c.discarded = true;
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Discard a single change by ID (used internally / for backward compat).
   * Prefer discardFile() for user-facing grouped operations.
   */
  async discardChange(id: string): Promise<boolean> {
    const change = this.changes.find(c => c.id === id);
    if (!change || change.discarded) return false;
    return this.discardFile(change.filePath);
  }

  /**
   * Open a VS Code diff editor showing the cumulative change for a file.
   * The id can be any change id belonging to the file, or the filePath itself.
   */
  async showDiff(idOrPath: string): Promise<void> {
    // Resolve by change id first, then treat as filePath
    let filePath: string | undefined;
    let relativePath: string | undefined;

    const byId = this.changes.find(c => c.id === idOrPath);
    if (byId) {
      filePath = byId.filePath;
      relativePath = byId.relativePath;
    } else {
      // treat as filePath (absolute or relative key)
      const match = this.changes.find(c => c.filePath === idOrPath || c.relativePath === idOrPath);
      if (match) {
        filePath = match.filePath;
        relativePath = match.relativePath;
      }
    }

    if (!filePath || !relativePath) return;

    // Find the earliest non-discarded change for this file to get original content
    const fileChanges = this.changes
      .filter(c => c.filePath === filePath && !c.discarded)
      .sort((a, b) => a.timestamp - b.timestamp);

    if (fileChanges.length === 0) return;
    const originalContent = fileChanges[0].kind === 'create' ? '' : fileChanges[0].before;

    const tmpDir = require('os').tmpdir();
    const tmpPath = path.join(tmpDir, `ggpilot-diff-${path.basename(filePath)}`);
    fs.writeFileSync(tmpPath, originalContent, 'utf8');
    const leftFileUri = vscode.Uri.file(tmpPath);
    const rightUri = vscode.Uri.file(filePath);

    await vscode.commands.executeCommand(
      'vscode.diff',
      leftFileUri,
      rightUri,
      `${relativePath} (before \u2194 after)`
    );
  }

  /** Clear all tracking (on new conversation) */
  clear(): void {
    this.changes = [];
    this.idCounter = 0;
  }

  /**
   * Serialize changes grouped by file for the webview.
   * Multiple edits to the same file are merged into a single entry
   * with aggregated addition/deletion counts.
   */
  toWebviewData(): Array<{
    /** Representative change id (earliest for this file) used for diff/discard actions */
    id: string;
    relativePath: string;
    additions: number;
    deletions: number;
    kind: 'edit' | 'create';
    /** True only if ALL changes for this file have been discarded */
    discarded: boolean;
  }> {
    // Group by filePath
    const groups = new Map<string, FileChange[]>();
    for (const c of this.changes) {
      const list = groups.get(c.filePath) ?? [];
      list.push(c);
      groups.set(c.filePath, list);
    }

    const result: ReturnType<ChangeTracker['toWebviewData']> = [];
    for (const [, list] of groups) {
      list.sort((a, b) => a.timestamp - b.timestamp);
      const allDiscarded = list.every(c => c.discarded);
      const activeChanges = list.filter(c => !c.discarded);

      // Represent the file with the earliest change's id/path/kind
      const first = list[0];
      const totalAdditions = activeChanges.reduce((s, c) => s + c.additions, 0);
      const totalDeletions = activeChanges.reduce((s, c) => s + c.deletions, 0);

      result.push({
        id: first.id,
        relativePath: first.relativePath,
        additions: totalAdditions,
        deletions: totalDeletions,
        kind: first.kind,
        discarded: allDiscarded,
      });
    }

    return result;
  }

  private toRelative(filePath: string): string {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (root && filePath.startsWith(root)) {
      return path.relative(root, filePath);
    }
    return path.basename(filePath);
  }
}

/** Compute line-level additions and deletions between two strings */
function diffStats(before: string, after: string): { additions: number; deletions: number } {
  const oldLines = before.split('\n');
  const newLines = after.split('\n');

  // Simple LCS-based diff count
  const oldSet = new Map<string, number>();
  for (const line of oldLines) {
    oldSet.set(line, (oldSet.get(line) ?? 0) + 1);
  }

  let matched = 0;
  const remaining = new Map(oldSet);
  for (const line of newLines) {
    const count = remaining.get(line);
    if (count && count > 0) {
      remaining.set(line, count - 1);
      matched++;
    }
  }

  const deletions = oldLines.length - matched;
  const additions = newLines.length - matched;

  return { additions, deletions };
}
