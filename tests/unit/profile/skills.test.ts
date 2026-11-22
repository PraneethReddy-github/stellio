import { describe, expect, it } from 'vitest';
import { canonicalSkillKey, matchesSkill, skillKeys } from '../../../src/shared/profile';

describe('skills helpers', () => {
  it('canonicalSkillKey ignores case, outer and repeated whitespace and Unicode forms', () => {
    expect(canonicalSkillKey('  PostgreSQL ')).toBe('postgresql');
    expect(canonicalSkillKey('Machine   Learning')).toBe('machine learning');
    expect(canonicalSkillKey('Ａｐｉ')).toBe('api');
  });

  it('keeps punctuation that distinguishes skills', () => {
    expect(canonicalSkillKey('C++')).not.toBe(canonicalSkillKey('C'));
    expect(canonicalSkillKey('C#')).not.toBe(canonicalSkillKey('C'));
  });

  it('matches names and aliases', () => {
    const row = { skill: 'PostgreSQL', aliases: ['Postgres', 'psql', ''] };
    expect(matchesSkill(row, 'postgres')).toBe(true);
    expect(matchesSkill(row, ' PSQL ')).toBe(true);
    expect(matchesSkill(row, 'mysql')).toBe(false);
    expect(skillKeys(row)).toEqual(['postgresql', 'postgres', 'psql']);
  });
});
