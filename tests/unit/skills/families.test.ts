import { describe, expect, it } from 'vitest';
import { lookupSkill, SKILL_FAMILIES, skillFamilyMates } from '../../../src/shared/skills';

describe('skill families', () => {
  it('only name dictionary skills of one category, each in one family at most', () => {
    const seen = new Set<string>();
    for (const fam of SKILL_FAMILIES) {
      const skills = fam.map((n) => lookupSkill(n));
      skills.forEach((s, i) => expect(s, `${fam[i] ?? ''} is not in the dictionary`).toBeDefined());
      expect(new Set(skills.map((s) => s?.category)).size, fam.join('/')).toBe(1);
      for (const s of skills) {
        expect(seen.has(s?.name ?? ''), `${s?.name ?? ''} is in two families`).toBe(false);
        seen.add(s?.name ?? '');
      }
    }
  });

  it('finds family mates through aliases and ignores unrelated or unknown skills', () => {
    expect(skillFamilyMates('Postgres')).toContain('MySQL');
    expect(skillFamilyMates('postgres')).not.toContain('PostgreSQL');
    expect(skillFamilyMates('GCP')).toContain('AWS');
    expect(skillFamilyMates('Python')).toEqual([]);
    expect(skillFamilyMates('Nimbus')).toEqual([]);
  });
});
