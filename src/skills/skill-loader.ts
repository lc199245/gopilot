import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { Skill, SkillFrontmatter } from './types';

/**
 * Discovers and loads SKILL.md files from <workspaceRoot>/skills/<name>/SKILL.md
 */
export function loadSkills(): Skill[] {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) return [];

  const skillsDir = path.join(root, 'skills');
  if (!fs.existsSync(skillsDir)) return [];

  const skills: Skill[] = [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillFile = path.join(skillsDir, entry.name, 'SKILL.md');
    if (!fs.existsSync(skillFile)) continue;

    try {
      const raw = fs.readFileSync(skillFile, 'utf8');
      const skill = parseSkillFile(skillFile, raw);
      if (skill) skills.push(skill);
    } catch {
      // Skip malformed skill files
    }
  }

  return skills;
}

function parseSkillFile(filePath: string, raw: string): Skill | undefined {
  // Parse YAML-like frontmatter between --- markers
  const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!match) {
    // No frontmatter — treat entire content as body with defaults
    return {
      filePath,
      meta: {
        name: path.basename(path.dirname(filePath)),
        description: '',
        triggers: [],
        tags: [],
      },
      body: raw,
    };
  }

  const frontmatter = match[1];
  const body = match[2];

  const meta = parseFrontmatter(frontmatter);
  if (!meta.name) {
    meta.name = path.basename(path.dirname(filePath));
  }

  return { filePath, meta, body };
}

function parseFrontmatter(text: string): SkillFrontmatter {
  const result: SkillFrontmatter = { name: '', description: '', triggers: [], tags: [] };

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    const value = trimmed.slice(colonIdx + 1).trim();

    switch (key) {
      case 'name':
        result.name = stripQuotes(value);
        break;
      case 'description':
        result.description = stripQuotes(value);
        break;
      case 'triggers':
        result.triggers = parseYamlArray(value, text, 'triggers');
        break;
      case 'tags':
        result.tags = parseYamlArray(value, text, 'tags');
        break;
    }
  }

  return result;
}

function parseYamlArray(inlineValue: string, fullText: string, key: string): string[] {
  // Inline: [a, b, c] or ["a", "b"]
  if (inlineValue.startsWith('[')) {
    const inner = inlineValue.slice(1, inlineValue.lastIndexOf(']'));
    return inner.split(',').map(s => stripQuotes(s.trim())).filter(Boolean);
  }

  // Block style:
  //   - item1
  //   - item2
  const items: string[] = [];
  const lines = fullText.split('\n');
  let inBlock = false;
  for (const line of lines) {
    if (line.trim().startsWith(`${key}:`)) {
      inBlock = true;
      continue;
    }
    if (inBlock) {
      const match = line.match(/^\s+-\s+(.+)/);
      if (match) {
        items.push(stripQuotes(match[1].trim()));
      } else if (line.trim() && !line.match(/^\s+-/)) {
        break;
      }
    }
  }
  return items;
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}
