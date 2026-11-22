import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { GapRow, SkillAuditRow } from '../../../src/shared/skills/schemas';
import {
  actionBlocker,
  addPreview,
  addSkillForm,
  evidenceOptions,
  hoursText,
  parseIgnored,
  percentText,
  profileModel,
  visibleGaps,
} from '../../../src/renderer/src/features/skills/helpers';

const profile = readFileSync('tests/fixtures/profiles/full.md', 'utf8');
const audit = (extra: Partial<SkillAuditRow> = {}): SkillAuditRow => ({
  skill: 'dbt',
  origin: 'jd_only',
  onResume: false,
  jdImportance: 'preferred',
  evidenceIds: [],
  strength: 'none',
  recommendation: 'learn',
  decision: 'pending',
  demand: null,
  adjacentTo: null,
  rationale: null,
  learnEstimateHours: null,
  ...extra,
});

describe('text', () => {
  it('labels the learn estimate as an estimate', () => {
    expect(hoursText(25)).toBe('~25 h (estimate)');
    expect(hoursText(null)).toBe('—');
  });
  it('formats shares', () => {
    expect(percentText(0.384)).toBe('38%');
    expect(percentText(null)).toBe('—');
  });
});

describe('actionBlocker', () => {
  it('keep and remove need the skill on the resume', () => {
    expect(actionBlocker(audit(), 'remove')).toBe('Not on this resume');
    expect(actionBlocker(audit({ onResume: true }), 'remove')).toBeNull();
    expect(actionBlocker(audit({ onResume: true, decision: 'kept' }), 'keep')).toBe('Already kept');
  });
  it('learn and add skip rows that are already done', () => {
    expect(actionBlocker(audit({ decision: 'learning' }), 'learn')).toBe('Already in Learning');
    expect(actionBlocker(audit({ origin: 'profile_have' }), 'add_to_profile')).toBe(
      'Already in your profile',
    );
    expect(actionBlocker(audit({ origin: 'unlisted_confirmed' }), 'add_to_profile')).toBeNull();
  });
});

describe('addPreview', () => {
  it('needs a level before it shows a change', () => {
    const p = addPreview(profile, addSkillForm('dbt'));
    expect(p.after).toBeNull();
    expect(p.error?.field).toBe('level');
  });
  it('recomputes the diff from the form values', () => {
    const form = { ...addSkillForm('dbt'), level: '2', years: '1', last_used: '2026' };
    const p = addPreview(profile, form);
    expect(p.after).toContain('| dbt |');
    expect(p.hunks.length).toBeGreaterThan(0);
    const other = addPreview(profile, { ...form, level: '4' });
    expect(other.after).not.toBe(p.after);
    expect(profile).not.toContain('| dbt |');
  });
  it('prefills the category from the dictionary and never the level', () => {
    expect(addSkillForm('dbt')).toMatchObject({ category: 'tool', status: 'have', level: '' });
  });
});

describe('evidenceOptions', () => {
  it('lists experience and project ids', () => {
    const ids = evidenceOptions(profileModel(profile)).map((o) => o.id);
    expect(ids).toEqual(expect.arrayContaining(['exp-globex', 'proj-ledger']));
  });
});

describe('ignored gaps', () => {
  const gap = (skill: string): GapRow => ({
    skill,
    category: null,
    demand: { jobCount: 1, share: 1, requiredShare: 1 },
    priority: 3,
    inProfile: null,
    learning: null,
  });
  it('hides ignored skills case-insensitively and keeps the order', () => {
    expect(visibleGaps([gap('dbt'), gap('Spark'), gap('Go')], ['SPARK']).map((g) => g.skill)).toEqual([
      'dbt',
      'Go',
    ]);
  });
  it('reads a stored list defensively', () => {
    expect(parseIgnored('["a","b"]')).toEqual(['a', 'b']);
    expect(parseIgnored('{"a":1}')).toEqual([]);
    expect(parseIgnored('nope')).toEqual([]);
    expect(parseIgnored(null)).toEqual([]);
  });
});
