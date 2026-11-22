import { describe, expect, it } from 'vitest';
import { parseProfile, validateProfile, type Diagnostic } from '../../../src/shared/profile';
import { fixture } from './helpers';

const today = new Date('2026-11-19T12:00:00Z');
const run = (name: string): Diagnostic[] => validateProfile(parseProfile(fixture(name)).model, { today });
const codes = (d: Diagnostic[]): string[] => d.map((x) => x.code);

describe('validateProfile', () => {
  it('passes the full fixture', () => {
    expect(run('full')).toEqual([]);
    expect(run('minimal')).toEqual([]);
    expect(run('unicode')).toEqual([]);
  });

  it('flags duplicate ids, unknown evidence, bad dates, missing ids and duplicate skills', () => {
    const d = run('duplicate-ids');
    expect(codes(d)).toEqual(
      expect.arrayContaining(['id_duplicate', 'evidence_unknown_id', 'entry_id_missing', 'skill_duplicate']),
    );
    expect(d.find((x) => x.code === 'skill_duplicate')?.message).toContain('postgres');
    expect(d.find((x) => x.code === 'evidence_unknown_id')?.message).toContain('exp-missing');
    expect(
      d.every(
        (x) => x.severity === 'error' || x.code === 'skill_have_no_evidence' || x.code === 'entry_no_bullets',
      ),
    ).toBe(true);
  });

  it('flags bad levels, enums, last_used, malformed dates and empty names in the malformed table', () => {
    const d = run('malformed-table');
    expect(codes(d).filter((c) => c === 'skill_level_range')).toHaveLength(3);
    expect(codes(d)).toEqual(
      expect.arrayContaining([
        'skill_status_unknown',
        'skill_last_used_invalid',
        'skill_category_unknown',
        'skill_name_missing',
        'date_malformed',
      ]),
    );
    expect(d.filter((x) => x.code === 'date_malformed')).toHaveLength(2);
  });

  it('requires name and email', () => {
    expect(codes(run('missing-front-matter'))).toEqual(
      expect.arrayContaining(['profile_name_missing', 'profile_email_missing']),
    );
    expect(
      run('empty')
        .filter((d) => d.severity === 'error')
        .map((d) => d.code),
    ).toEqual(['profile_name_missing', 'profile_email_missing']);
  });

  it('warns about a have skill without evidence and entries without bullets', () => {
    const d = run('duplicate-ids');
    expect(d.filter((x) => x.severity === 'warning').map((x) => x.code)).toEqual(
      expect.arrayContaining(['skill_have_no_evidence', 'entry_no_bullets']),
    );
  });

  it('judges staleness against the injected date', () => {
    const model = parseProfile(fixture('full')).model; // last_reviewed 2026-11-01
    expect(codes(validateProfile(model, { today: new Date('2026-12-01T00:00:00Z') }))).toEqual([]);
    expect(codes(validateProfile(model, { today: new Date('2026-12-02T00:00:00Z') }))).toEqual([
      'profile_stale',
    ]);
    const bad = { ...model, frontMatter: { ...model.frontMatter, last_reviewed: 'yesterday' } };
    expect(codes(validateProfile(bad, { today }))).toEqual(['last_reviewed_malformed']);
  });

  it('accepts YYYY-MM, YYYY, present and now as dates; rejects month 13', () => {
    const e = (start: string) => ({ id: 'x', title: 't', meta: { start }, bullets: ['b'] });
    const base = parseProfile(fixture('minimal')).model;
    const check = (start: string) =>
      codes(validateProfile({ ...base, skills: [], experience: [e(start)] }, { today }));
    for (const ok of ['2020-05', '2020', 'present', 'now']) expect(check(ok)).toEqual([]);
    for (const bad of ['2020-13', '05/2020', 'someday', '2020-5'])
      expect(check(bad)).toEqual(['date_malformed']);
  });

  it('treats alias collisions across rows as duplicates', () => {
    const base = parseProfile(fixture('minimal')).model;
    const row = (skill: string, aliases: string[]) => ({
      skill,
      category: 'tool',
      level: 3,
      years: 1,
      last_used: 'now',
      evidence: ['exp-acme'],
      status: 'have',
      aliases,
    });
    const d = validateProfile(
      { ...base, skills: [row('Postgres', []), row('PostgreSQL', ['postgres'])] },
      { today },
    );
    expect(codes(d)).toEqual(['skill_duplicate']);
    expect(validateProfile({ ...base, skills: [row('Postgres', []), row('MySQL', [])] }, { today })).toEqual(
      [],
    );
  });
});
