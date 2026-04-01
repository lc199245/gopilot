import type { Skill } from './types';

const CHARS_PER_TOKEN = 4;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Score and select skills that match the current context.
 * Returns skills sorted by relevance, fitted within the token budget.
 */
export function matchSkills(
  skills: Skill[],
  activeFileName: string | undefined,
  userQuery: string,
  tokenBudget: number
): Skill[] {
  if (skills.length === 0) return [];

  const scored = skills.map(skill => ({
    skill,
    score: scoreSkill(skill, activeFileName, userQuery),
  }));

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  // Filter out zero-score skills
  const relevant = scored.filter(s => s.score > 0);

  // Fit within token budget
  const selected: Skill[] = [];
  let usedTokens = 0;

  for (const { skill } of relevant) {
    const tokens = estimateTokens(skill.body);
    if (usedTokens + tokens > tokenBudget) continue;
    selected.push(skill);
    usedTokens += tokens;
  }

  return selected;
}

function scoreSkill(
  skill: Skill,
  activeFileName: string | undefined,
  userQuery: string
): number {
  let score = 0;
  const query = userQuery.toLowerCase();
  const fileName = activeFileName?.toLowerCase() ?? '';

  // Check file extension triggers
  for (const trigger of skill.meta.triggers) {
    if (trigger.startsWith('*.')) {
      // Glob trigger: *.py, *.ts, etc.
      const ext = trigger.slice(1); // .py, .ts
      if (fileName.endsWith(ext)) {
        score += 10;
      }
    } else {
      // Keyword trigger
      if (query.includes(trigger.toLowerCase())) {
        score += 5;
      }
      if (fileName.includes(trigger.toLowerCase())) {
        score += 3;
      }
    }
  }

  // Check tags
  for (const tag of skill.meta.tags) {
    if (query.includes(tag.toLowerCase())) {
      score += 3;
    }
  }

  // Check name/description match
  if (query.includes(skill.meta.name.toLowerCase())) {
    score += 5;
  }

  return score;
}
