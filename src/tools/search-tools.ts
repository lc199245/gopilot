import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

const MAX_RESULTS = 20;
const MAX_DIR_DEPTH = 4;
const IGNORED = new Set([
  'node_modules', '.git', 'dist', 'out', '.vscode', '__pycache__',
  '.next', 'build', '.cache', 'coverage', '.nyc_output',
]);

export async function searchFiles(input: Record<string, unknown>): Promise<string> {
  const pattern = input.pattern as string;
  const searchPath = input.path as string | undefined;
  const include = input.include as string | undefined;
  const maxResults = (input.max_results as number) || MAX_RESULTS;

  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) throw new Error('No workspace folder open');

  const searchRoot = searchPath
    ? (path.isAbsolute(searchPath) ? searchPath : path.join(root, searchPath))
    : root;

  let regex: RegExp;
  try {
    regex = new RegExp(pattern, 'gi');
  } catch {
    regex = new RegExp(escapeRegex(pattern), 'gi');
  }

  const results: string[] = [];

  function searchDir(dir: string): void {
    if (results.length >= maxResults) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (results.length >= maxResults) return;

      if (entry.isDirectory()) {
        if (!IGNORED.has(entry.name)) {
          searchDir(path.join(dir, entry.name));
        }
        continue;
      }

      if (!entry.isFile()) continue;

      // Apply include filter
      if (include && !matchGlob(entry.name, include)) continue;

      const filePath = path.join(dir, entry.name);

      // Skip binary/large files
      try {
        const stat = fs.statSync(filePath);
        if (stat.size > 500_000) continue;
      } catch { continue; }

      let content: string;
      try {
        content = fs.readFileSync(filePath, 'utf8');
      } catch { continue; }

      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (results.length >= maxResults) break;
        regex.lastIndex = 0;
        if (regex.test(lines[i])) {
          const relativePath = path.relative(root!, filePath);
          results.push(`${relativePath}:${i + 1}: ${lines[i].trim()}`);
        }
      }
    }
  }

  searchDir(searchRoot);

  if (results.length === 0) {
    return `No matches found for "${pattern}"${include ? ` in ${include} files` : ''}.`;
  }

  return `Found ${results.length} match(es):\n\n${results.join('\n')}`;
}

export async function listDirectory(input: Record<string, unknown>): Promise<string> {
  const dirPath = input.path as string | undefined;
  const depth = (input.depth as number) ?? 2;

  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) throw new Error('No workspace folder open');

  const targetDir = dirPath
    ? (path.isAbsolute(dirPath) ? dirPath : path.join(root, dirPath))
    : root;

  if (!fs.existsSync(targetDir)) {
    throw new Error(`Directory not found: ${targetDir}`);
  }

  const tree = buildTree(targetDir, Math.min(depth, MAX_DIR_DEPTH), 0);
  return `Directory: ${targetDir}\n\n${tree}`;
}

function buildTree(dir: string, maxDepth: number, currentDepth: number): string {
  if (currentDepth > maxDepth) return '';
  const indent = '  '.repeat(currentDepth);
  let result = '';

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return '';
  }

  const dirs = entries.filter(e => e.isDirectory() && !IGNORED.has(e.name)).sort((a, b) => a.name.localeCompare(b.name));
  const files = entries.filter(e => e.isFile()).sort((a, b) => a.name.localeCompare(b.name));

  for (const d of dirs) {
    result += `${indent}${d.name}/\n`;
    result += buildTree(path.join(dir, d.name), maxDepth, currentDepth + 1);
  }
  for (const f of files) {
    result += `${indent}${f.name}\n`;
  }
  return result;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchGlob(filename: string, glob: string): boolean {
  // Simple glob matching: *.ext
  if (glob.startsWith('*.')) {
    return filename.endsWith(glob.slice(1));
  }
  return filename === glob || filename.includes(glob);
}
