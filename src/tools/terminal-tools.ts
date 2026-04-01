import * as vscode from 'vscode';
import * as cp from 'child_process';

const MAX_OUTPUT_LENGTH = 50_000;
const COMMAND_TIMEOUT = 30_000;

export async function runCommand(input: Record<string, unknown>): Promise<string> {
  const command = input.command as string;
  const cwd = (input.cwd as string) || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  if (!cwd) {
    throw new Error('No workspace folder open and no cwd specified');
  }

  return new Promise<string>((resolve, reject) => {
    const process = cp.exec(command, {
      cwd,
      timeout: COMMAND_TIMEOUT,
      maxBuffer: 5 * 1024 * 1024,
      env: { ...globalThis.process.env, FORCE_COLOR: '0' },
    }, (error, stdout, stderr) => {
      let output = '';

      if (stdout) {
        output += stdout;
      }
      if (stderr) {
        output += (output ? '\n' : '') + stderr;
      }

      // Truncate if too long
      if (output.length > MAX_OUTPUT_LENGTH) {
        output = output.slice(0, MAX_OUTPUT_LENGTH) + '\n\n... (output truncated)';
      }

      if (error) {
        if (error.killed) {
          reject(new Error(`Command timed out after ${COMMAND_TIMEOUT / 1000}s:\n${output}`));
        } else {
          // Command exited with non-zero code — still return output
          resolve(`Exit code ${error.code ?? 1}:\n${output || error.message}`);
        }
      } else {
        resolve(output || '(no output)');
      }
    });

    // Also show command in VSCode terminal for visibility
    showInTerminal(command, cwd);
  });
}

let sharedTerminal: vscode.Terminal | undefined;

function showInTerminal(command: string, cwd: string): void {
  if (!sharedTerminal || sharedTerminal.exitStatus !== undefined) {
    sharedTerminal = vscode.window.createTerminal({
      name: 'GoPilot',
      cwd,
    });
  }
  sharedTerminal.show(true); // preserve focus
  sharedTerminal.sendText(command);
}
