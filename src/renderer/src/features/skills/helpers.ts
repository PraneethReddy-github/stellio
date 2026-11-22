// Pure helpers for the skills panel and the Skills screen. No React, no IPC: unit-tested.
import { lookupSkill } from '@shared/skills';
import { parseProfile, SKILL_CATEGORIES, type Profile } from '@shared/profile';
import type { AuditRecommendation, GapRow, SkillAuditRow } from '@shared/skills/schemas';
import type { Tone } from '../../ui';
import { diffLines, type Hunk } from '../../ui';
import {
  emptySkillForm,
  formToRow,
  saveSkill,
  type SkillForm,
  type SkillFormError,
} from '../profile/helpers';

export const RECOMMENDATION_LABEL: Record<AuditRecommendation, string> = {
  keep: 'Keep',
  emphasize: 'Emphasize',
  remove: 'Remove',
  learn: 'Learn',
  add_to_profile: 'Add to profile',
  ask_have: 'Do you have it?',
};
export const RECOMMENDATION_TONE: Record<AuditRecommendation, Tone> = {
  keep: 'ok',
  emphasize: 'ok',
  remove: 'bad',
  learn: 'info',
  add_to_profile: 'warn',
  ask_have: 'warn',
};
export const ORIGIN_LABEL: Record<SkillAuditRow['origin'], string> = {
  profile_have: 'Profile',
  profile_learning: 'Learning',
  jd_only: 'Not in profile',
  unlisted_confirmed: 'You confirmed',
};
export const IMPORTANCE_LABEL: Record<SkillAuditRow['jdImportance'], string> = {
  required: 'Required',
  preferred: 'Preferred',
  mentioned: 'Mentioned',
  absent: 'Not in JD',
};

/** "~25 h (estimate)". The number is an AI guess and always says so. */
export const hoursText = (h: number | null): string => (h === null ? '—' : `~${String(h)} h (estimate)`);
/** 0.384 -> "38%"; null (no stored job names it) -> "—". */
export const percentText = (share: number | null | undefined): string =>
  share == null ? '—' : `${String(Math.round(share * 100))}%`;

export type AuditAction = 'keep' | 'remove' | 'learn' | 'add_to_profile';
export const ACTION_KEY: Record<string, AuditAction> = {
  k: 'keep',
  r: 'remove',
  l: 'learn',
  a: 'add_to_profile',
};

/** Why an action cannot run on this row, or null. Keep and remove edit the resume, so the skill must be on it. */
export function actionBlocker(row: SkillAuditRow, action: AuditAction): string | null {
  if ((action === 'keep' || action === 'remove') && !row.onResume) return 'Not on this resume';
  if (action === 'keep' && row.decision === 'kept') return 'Already kept';
  if (action === 'learn' && row.decision === 'learning') return 'Already in Learning';
  if (action === 'add_to_profile' && row.origin === 'profile_have') return 'Already in your profile';
  return null;
}

export const categoryFor = (skill: string): (typeof SKILL_CATEGORIES)[number] =>
  lookupSkill(skill)?.category ?? 'tool';

/** Add-to-profile form: level and last used start empty (a claim about the user is never prefilled). */
export const addSkillForm = (skill: string): SkillForm => ({
  ...emptySkillForm(),
  skill,
  category: categoryFor(skill),
  status: 'have',
});

export interface AddPreview {
  /** Null while the form is not valid yet. */
  after: string | null;
  error: SkillFormError | null;
  hunks: Hunk[];
}

/** The profile diff for the form as filled in now: the pure upsert applied client-side to the preview's file. */
export function addPreview(before: string, form: SkillForm): AddPreview {
  const res = formToRow(form);
  if ('error' in res) return { after: null, error: res.error, hunks: [] };
  const after = saveSkill(before, res.row);
  return { after, error: null, hunks: diffLines(before, after) };
}

/** Experience and project entries a skill can cite. */
export const evidenceOptions = (model: Profile): { id: string; title: string }[] =>
  [...model.experience, ...model.projects]
    .filter((e) => e.id !== '')
    .map((e) => ({ id: e.id, title: e.title || e.id }));

export const profileModel = (markdown: string): Profile => parseProfile(markdown).model;

// ---- Gaps: "Ignore" is a local, persisted choice ----
const IGNORE_KEY = 'stellio.skills.ignored';

export function parseIgnored(raw: string | null): string[] {
  try {
    const v: unknown = JSON.parse(raw ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
export function loadIgnored(): string[] {
  try {
    return parseIgnored(localStorage.getItem(IGNORE_KEY));
  } catch {
    return [];
  }
}
export function saveIgnored(list: readonly string[]): void {
  try {
    localStorage.setItem(IGNORE_KEY, JSON.stringify(list));
  } catch {
    /* storage unavailable: the choice lasts until the screen closes */
  }
}

/** Gaps minus the ignored skills (case-insensitive), order kept. */
export const visibleGaps = (gaps: readonly GapRow[], ignored: readonly string[]): GapRow[] => {
  const hide = new Set(ignored.map((s) => s.toLowerCase()));
  return gaps.filter((g) => !hide.has(g.skill.toLowerCase()));
};

// ---- Learning roadmap ----
export const MAX_WHAT_IF = 3;

/** Toggles a skill in the what-if selection; at most three, so a fourth is ignored. */
export function toggleWhatIf(selected: readonly string[], skill: string): string[] {
  if (selected.includes(skill)) return selected.filter((x) => x !== skill);
  return selected.length >= MAX_WHAT_IF ? [...selected] : [...selected, skill];
}

const joinNames = (names: readonly string[]): string =>
  names.length <= 1
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1] ?? ''}`;

/** "Learning dbt and Tableau would move 2 of 7 stretch jobs to apply." */
export function whatIfLine(r: {
  skills: readonly string[];
  stretchJobs: number;
  moved: readonly unknown[];
}): string {
  const who = `Learning ${joinNames(r.skills)}`;
  if (r.stretchJobs === 0) return `${who} changes nothing yet: none of your open jobs is at stretch.`;
  if (r.moved.length === 0)
    return `${who} would move none of your ${String(r.stretchJobs)} stretch ${r.stretchJobs === 1 ? 'job' : 'jobs'} to apply.`;
  return `${who} would move ${String(r.moved.length)} of ${String(r.stretchJobs)} stretch ${r.stretchJobs === 1 ? 'job' : 'jobs'} to apply.`;
}
