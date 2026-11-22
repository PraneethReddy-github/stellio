import type { SkillRow } from './types';

/** Comparison key for skill names and aliases: Unicode-normalized, lower-cased, whitespace collapsed. */
export function canonicalSkillKey(name: string): string {
  return name.normalize('NFKC').toLowerCase().trim().replace(/\s+/g, ' ');
}

/** Keys of a row's name and all of its aliases (deduplicated, empties dropped). */
export function skillKeys(row: Pick<SkillRow, 'skill' | 'aliases'>): string[] {
  return [...new Set([row.skill, ...row.aliases].map(canonicalSkillKey).filter((k) => k !== ''))];
}

/** True when `name` is the row's skill name or one of its aliases. */
export function matchesSkill(row: Pick<SkillRow, 'skill' | 'aliases'>, name: string): boolean {
  return skillKeys(row).includes(canonicalSkillKey(name));
}
