import { viewFile, editFile, createFile } from './file-tools';
import { runCommand } from './terminal-tools';
import { searchFiles, listDirectory } from './search-tools';

export interface ToolCallResult {
  output: string;
  isError: boolean;
}

type ToolHandler = (input: Record<string, unknown>) => Promise<string>;

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  view_file: viewFile,
  edit_file: editFile,
  create_file: createFile,
  run_command: runCommand,
  search_files: searchFiles,
  list_directory: listDirectory,
};

export async function executeTool(
  name: string,
  input: Record<string, unknown>
): Promise<ToolCallResult> {
  const handler = TOOL_HANDLERS[name];
  if (!handler) {
    return { output: `Unknown tool: ${name}`, isError: true };
  }

  try {
    const output = await handler(input);
    return { output, isError: false };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { output: `Error: ${message}`, isError: true };
  }
}

/** Generate a human-readable preview of what a tool call will do */
export function toolPreview(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'view_file': {
      const range = input.start_line ? ` (lines ${input.start_line}-${input.end_line ?? 'end'})` : '';
      return `Read ${input.path}${range}`;
    }
    case 'edit_file':
      return `Edit ${input.path}`;
    case 'create_file':
      return `Create ${input.path}`;
    case 'run_command':
      return `Run: ${input.command}`;
    case 'search_files':
      return `Search for "${input.pattern}"${input.include ? ` in ${input.include}` : ''}`;
    case 'list_directory':
      return `List ${input.path ?? 'workspace root'}`;
    default:
      return `${name}(${JSON.stringify(input)})`;
  }
}
