export interface SkillFrontmatter {
  name: string;
  description: string;
  triggers: string[];
  tags: string[];
}

export interface Skill {
  /** Absolute path to the SKILL.md file */
  filePath: string;
  /** Parsed frontmatter */
  meta: SkillFrontmatter;
  /** Raw markdown body (after frontmatter) */
  body: string;
}
