import { SYSTEM_PROMPT_BASE } from './system-prompt';
import { buildContextBlock, type WorkspaceContext } from '../context/workspace-context';
import type { Skill } from '../skills/types';

/**
 * Assembles the full system prompt from base template + workspace context + skills.
 */
export function buildSystemPrompt(
  context: WorkspaceContext,
  skills: Skill[]
): string {
  const parts: string[] = [SYSTEM_PROMPT_BASE];

  // Inject skills
  if (skills.length > 0) {
    const skillBlocks = skills.map(s =>
      `### ${s.meta.name}\n${s.meta.description ? `> ${s.meta.description}\n\n` : ''}${s.body.trim()}`
    ).join('\n\n---\n\n');

    parts.push(`## Workspace Skills\nThe following project-specific guidelines are relevant:\n\n${skillBlocks}`);
  }

  // Inject workspace context
  const contextBlock = buildContextBlock(context);
  if (contextBlock) {
    parts.push(`## Current Workspace Context\n${contextBlock}`);
  }

  return parts.join('\n\n');
}
