import { describe, expect, it } from 'vitest';
import type { Jd } from '../../../src/shared/jobs/schemas';
import type { Profile, SkillRow } from '../../../src/shared/profile';
import { buildSkillAudit, recommendSkill, resolveSkill } from '../../../src/shared/skills/audit';
import type { DemandShare } from '../../../src/shared/skills/schemas';
import { sampleJd } from '../../fixtures/jobs';
import { fullProfile, goodContent, seedPolicy } from '../../fixtures/resume';

const row = (over: Partial<SkillRow> = {}): SkillRow => ({
  skill: 'Python',
  category: 'language',
  level: 3,
  years: 3,
  last_used: 'now',
  evidence: ['exp-globex'],
  status: 'have',
  aliases: [],
  ...over,
});
const input = (over: Partial<Parameters<typeof recommendSkill>[0]> = {}) => ({
  row: row(),
  onResume: true,
  importance: 'required' as const,
  approved: false,
  pinned: false,
  allowed: true,
  adjacent: null,
  ...over,
});

describe('recommendSkill: every row of the docs/07 §2 table', () => {
  it('on resume, have, JD required/preferred → keep (emphasize when strong)', () => {
    expect(recommendSkill(input())).toBe('keep');
    expect(recommendSkill(input({ importance: 'preferred' }))).toBe('keep');
    expect(recommendSkill(input({ row: row({ level: 4 }) }))).toBe('emphasize');
    expect(recommendSkill(input({ row: row({ level: 5 }), importance: 'preferred' }))).toBe('emphasize');
  });

  it('on resume, have, JD only mentions it → keep', () => {
    expect(recommendSkill(input({ importance: 'mentioned' }))).toBe('keep');
  });

  it('on resume, have, JD absent → remove, unless pinned or approved', () => {
    expect(recommendSkill(input({ importance: 'absent' }))).toBe('remove');
    expect(recommendSkill(input({ importance: 'absent', pinned: true }))).toBe('keep');
    expect(recommendSkill(input({ importance: 'absent', approved: true }))).toBe('keep');
  });

  it('on resume, learning → keep only when allowed and level ≥ 2 (or pinned/approved)', () => {
    const learning = (level: number | null) => row({ status: 'learning', level });
    expect(recommendSkill(input({ row: learning(2) }))).toBe('keep');
    expect(recommendSkill(input({ row: learning(1) }))).toBe('remove');
    expect(recommendSkill(input({ row: learning(null) }))).toBe('remove');
    expect(recommendSkill(input({ row: learning(1), pinned: true }))).toBe('keep');
    expect(recommendSkill(input({ row: learning(1), approved: true, allowed: false }))).toBe('keep');
    expect(recommendSkill(input({ row: learning(3), allowed: false }))).toBe('remove'); // policy forbids learning skills
  });

  it('on resume but blocked by the policy (level, recency, never_show, want) → remove', () => {
    expect(recommendSkill(input({ allowed: false }))).toBe('remove');
    expect(recommendSkill(input({ row: row({ status: 'want' }), allowed: false }))).toBe('remove');
  });

  it('on resume but not in the profile → remove (flagged violation); approved → add to profile', () => {
    expect(recommendSkill(input({ row: null, allowed: false }))).toBe('remove');
    expect(recommendSkill(input({ row: null, allowed: false, approved: true }))).toBe('add_to_profile');
  });

  it('approval overrides a policy block on a profile skill', () => {
    expect(recommendSkill(input({ allowed: false, approved: true, importance: 'absent' }))).toBe('keep');
  });

  it('jd_only, required or preferred → learn', () => {
    expect(recommendSkill(input({ row: null, onResume: false, allowed: false }))).toBe('learn');
    expect(
      recommendSkill(input({ row: null, onResume: false, allowed: false, importance: 'preferred' })),
    ).toBe('learn');
  });

  it('jd_only with an adjacent profile skill → ask_have; approved → add to profile', () => {
    const jdOnly = { row: null, onResume: false, allowed: false };
    expect(recommendSkill(input({ ...jdOnly, adjacent: 'MySQL' }))).toBe('ask_have');
    expect(recommendSkill(input({ ...jdOnly, adjacent: 'MySQL', approved: true }))).toBe('add_to_profile');
  });

  it('not on resume: a usable skill you have is emphasized; one you only learn or cannot list is learn', () => {
    const off = { onResume: false };
    expect(recommendSkill(input(off))).toBe('emphasize');
    expect(recommendSkill(input({ ...off, row: row({ status: 'learning' }) }))).toBe('learn');
    expect(recommendSkill(input({ ...off, row: row({ status: 'want' }), allowed: false }))).toBe('learn');
    expect(recommendSkill(input({ ...off, allowed: false }))).toBe('learn');
  });
});

describe('resolveSkill', () => {
  it('matches profile names, aliases and dictionary spellings to one identity', () => {
    const p = fullProfile;
    expect(resolveSkill('py', p)).toMatchObject({ display: 'Python', key: 'python' });
    expect(resolveSkill('postgres', p).row?.skill).toBe('PostgreSQL');
    expect(resolveSkill('PostgreSQL', p).key).toBe(resolveSkill('Postgres', p).key);
    expect(resolveSkill('Kubernetes', p).row?.status).toBe('want');
    expect(resolveSkill('dbt', p)).toMatchObject({ display: 'dbt', row: null });
    expect(resolveSkill('  Nimbus  ', p)).toMatchObject({ display: 'Nimbus', row: null });
  });
});

describe('buildSkillAudit', () => {
  const jd: Jd = {
    ...sampleJd,
    requirements: [
      { text: 'Strong Python and SQL', kind: 'required', skills: ['Python', 'SQL'] },
      { text: 'Know Kubernetes and dbt', kind: 'preferred', skills: ['Kubernetes', 'dbt'] },
      { text: 'Redshift or BigQuery', kind: 'required', skills: ['Amazon Redshift'] },
    ],
    responsibilities: ['Run Airflow pipelines'],
  };
  const demand = new Map<string, DemandShare>([['python', { jobCount: 4, share: 0.8, requiredShare: 0.6 }]]);
  const find = (rows: ReturnType<typeof buildSkillAudit>, skill: string) =>
    rows.find((r) => r.skill === skill);
  const audit = (over: Partial<Profile> = {}, approvals: string[] = []) =>
    buildSkillAudit(goodContent, { ...fullProfile, ...over }, jd, seedPolicy, approvals, demand);

  it('emits one row per resume or JD skill, ordered by JD importance', () => {
    const rows = audit();
    expect(rows.map((r) => r.skill)).toEqual([
      'Python',
      'SQL',
      'Amazon Redshift',
      'dbt',
      'Kubernetes',
      'Airflow',
      'PostgreSQL',
    ]);
    expect(new Set(rows.map((r) => r.skill)).size).toBe(rows.length);
  });

  it('fills origin, importance, evidence, strength, demand and leaves the AI fields empty', () => {
    expect(find(audit(), 'Python')).toEqual({
      skill: 'Python',
      origin: 'profile_have',
      onResume: true,
      jdImportance: 'required',
      evidenceIds: ['exp-globex', 'proj-ledger'],
      strength: 'high',
      recommendation: 'emphasize',
      decision: 'pending',
      demand: { jobCount: 4, share: 0.8, requiredShare: 0.6 },
      adjacentTo: null,
      rationale: null,
      learnEstimateHours: null,
    });
  });

  it('applies the table to the fixture', () => {
    const rows = audit();
    expect(find(rows, 'SQL')?.recommendation).toBe('emphasize');
    expect(find(rows, 'Airflow')).toMatchObject({ jdImportance: 'mentioned', recommendation: 'keep' });
    expect(find(rows, 'PostgreSQL')).toMatchObject({ jdImportance: 'absent', recommendation: 'remove' });
    expect(find(rows, 'Kubernetes')).toMatchObject({
      origin: 'profile_learning',
      onResume: false,
      recommendation: 'learn',
    });
    expect(find(rows, 'dbt')).toMatchObject({ origin: 'jd_only', recommendation: 'learn', strength: 'none' });
    expect(find(rows, 'Amazon Redshift')).toMatchObject({ origin: 'jd_only', recommendation: 'learn' });
  });

  it('asks "do you have it?" when a close substitute is in the profile (adjacency family)', () => {
    const rows = audit({
      skills: [
        ...fullProfile.skills,
        row({ skill: 'BigQuery', category: 'cloud', evidence: [], level: 3 }),
        row({ skill: 'MySQL', category: 'data' }),
      ],
    });
    expect(find(rows, 'Amazon Redshift')).toMatchObject({
      recommendation: 'ask_have',
      adjacentTo: 'BigQuery',
    });
    expect(find(rows, 'dbt')?.recommendation).toBe('learn');
  });

  it('does not ask when the policy turns the prompt off, or the substitute is only being learned', () => {
    const skills = [...fullProfile.skills, row({ skill: 'BigQuery', category: 'cloud' })];
    const off = buildSkillAudit(
      goodContent,
      { ...fullProfile, skills },
      jd,
      { ...seedPolicy, adjacent_skill_prompt: false },
      [],
      demand,
    );
    expect(find(off, 'Amazon Redshift')?.recommendation).toBe('learn');
    const learning = audit({
      skills: [...fullProfile.skills, row({ skill: 'BigQuery', status: 'learning' })],
    });
    expect(find(learning, 'Amazon Redshift')?.recommendation).toBe('learn');
  });

  it('flags a skill on the resume that the profile does not have', () => {
    const content = { ...goodContent, skills: [{ category_label: 'Tools', skills: ['Rust', 'py'] }] };
    const rows = buildSkillAudit(content, fullProfile, jd, seedPolicy, [], demand);
    expect(find(rows, 'Rust')).toMatchObject({
      origin: 'jd_only',
      onResume: true,
      jdImportance: 'absent',
      recommendation: 'remove',
    });
    expect(find(rows, 'Python')?.onResume).toBe(true); // "py" is the alias
  });

  it('remembers approvals: an approved skill outside the JD is kept, an unlisted one goes to the profile', () => {
    const content = { ...goodContent, skills: [{ category_label: 'Tools', skills: ['Rust'] }] };
    const rows = buildSkillAudit(content, fullProfile, jd, seedPolicy, ['rust'], demand);
    expect(find(rows, 'Rust')).toMatchObject({
      origin: 'unlisted_confirmed',
      recommendation: 'add_to_profile',
    });
    const kept = audit({}, ['PostgreSQL']);
    expect(find(kept, 'PostgreSQL')?.recommendation).toBe('keep');
  });

  it('honours always_pin and never_show', () => {
    const pin = buildSkillAudit(
      goodContent,
      fullProfile,
      jd,
      { ...seedPolicy, always_pin: ['PostgreSQL'] },
      [],
      demand,
    );
    expect(find(pin, 'PostgreSQL')?.recommendation).toBe('keep');
    const never = buildSkillAudit(
      goodContent,
      fullProfile,
      jd,
      { ...seedPolicy, never_show: ['Airflow'] },
      [],
      demand,
    );
    expect(find(never, 'Airflow')?.recommendation).toBe('remove');
  });

  it('survives a missing JD and missing content', () => {
    const noJd = buildSkillAudit(goodContent, fullProfile, null, seedPolicy, [], new Map());
    expect(noJd.every((r) => r.jdImportance === 'absent')).toBe(true);
    expect(buildSkillAudit(null, fullProfile, jd, seedPolicy, [], new Map()).every((r) => !r.onResume)).toBe(
      true,
    );
  });
});
