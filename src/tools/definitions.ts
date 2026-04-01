import type { ToolDefinition } from '../providers/types';

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'view_file',
    description: 'Read the contents of a file. Use this to understand existing code before making changes. You can optionally specify a line range.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or workspace-relative file path' },
        start_line: { type: 'number', description: 'Starting line number (1-based, optional)' },
        end_line: { type: 'number', description: 'Ending line number (1-based, inclusive, optional)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'edit_file',
    description: 'Make a targeted edit to a file by specifying the old text to replace and the new text. Always view_file first before editing.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or workspace-relative file path' },
        old_text: { type: 'string', description: 'The exact text to find and replace' },
        new_text: { type: 'string', description: 'The replacement text' },
      },
      required: ['path', 'old_text', 'new_text'],
    },
  },
  {
    name: 'create_file',
    description: 'Create a new file with the specified content. Fails if the file already exists.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or workspace-relative file path' },
        content: { type: 'string', description: 'The full content of the new file' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'run_command',
    description: 'Execute a shell command in the workspace terminal. Use for builds, tests, git, or any CLI operation.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to execute' },
        cwd: { type: 'string', description: 'Working directory (optional, defaults to workspace root)' },
      },
      required: ['command'],
    },
  },
  {
    name: 'search_files',
    description: 'Search for text or regex patterns across files in the workspace.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Search pattern (regex supported)' },
        path: { type: 'string', description: 'Directory or file to search in (optional, defaults to workspace root)' },
        include: { type: 'string', description: 'Glob pattern to include files (e.g. "*.ts")' },
        max_results: { type: 'number', description: 'Maximum number of results (default 20)' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'list_directory',
    description: 'List files and directories at the specified path. Useful for understanding project structure.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path (optional, defaults to workspace root)' },
        depth: { type: 'number', description: 'Maximum depth to recurse (default 2)' },
      },
      required: [],
    },
  },
];

/** Tools that require user approval before execution */
export const TOOLS_REQUIRING_APPROVAL = new Set(['edit_file', 'create_file', 'run_command']);

/** Tools that are read-only and safe to auto-approve */
export const READ_ONLY_TOOLS = new Set(['view_file', 'search_files', 'list_directory']);
