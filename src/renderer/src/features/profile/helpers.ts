// Pure helpers for the Profile screen. No React, no IPC: everything here is unit-tested.
import {
  parseProfile,
  removeSkill,
  serializeProfile,
  setFrontMatterField,
  upsertSkill,
  validateProfile,
  SKILL_CATEGORIES,
  SKILL_STATUSES,
  matchesSkill,
  skillKeys,
  type Diagnostic,
  type Entry,
  type Profile,
  type SkillRow,
} from '@shared/profile';

export const GENERIC_MESSAGE = 'profile: edit';

/** "a, b ,, c" -> ["a", "b", "c"] */
export const parseList = (text: string): string[] =>
  text
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x !== '');

export const formatList = (items: readonly string[]): string => items.join(', ');

/** Empty or non-numeric text means "not set". */
export function parseNumberOrNull(text: string): number | null {
  const t = text.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Sets one front matter value (dotted path) and returns the new markdown. */
export function setField(markdown: string, path: string, value: unknown): string {
  return serializeProfile(setFrontMatterField(parseProfile(markdown).doc, path, value));
}

export function saveSkill(markdown: string, row: SkillRow): string {
  return serializeProfile(upsertSkill(parseProfile(markdown).doc, row));
}

export function deleteSkill(markdown: string, name: string): string {
  return serializeProfile(removeSkill(parseProfile(markdown).doc, name));
}

/** Parse diagnostics plus model validation, recomputed on every keystroke. */
export function liveDiagnostics(markdown: string, today = new Date()): { model: Profile; all: Diagnostic[] } {
  const { model, diagnostics } = parseProfile(markdown);
  return { model, all: sortDiagnostics([...diagnostics, ...validateProfile(model, { today })]) };
}

/** Errors first, then warnings; within a severity by line (unlocated last). Stable otherwise. */
export function sortDiagnostics(list: readonly Diagnostic[]): Diagnostic[] {
  const rank = (d: Diagnostic): number => (d.severity === 'error' ? 0 : 1);
  return list
    .map((d, i) => ({ d, i }))
    .sort((a, b) => rank(a.d) - rank(b.d) || (a.d.line ?? Infinity) - (b.d.line ?? Infinity) || a.i - b.i)
    .map((x) => x.d);
}

export function countDiagnostics(list: readonly Diagnostic[]): { errors: number; warnings: number } {
  const errors = list.filter((d) => d.severity === 'error').length;
  return { errors, warnings: list.length - errors };
}

/** Plain-language copy for the validate codes; anything unmapped keeps its original message. */
const COPY: Record<string, (message: string) => string> = {
  profile_name_missing: () => 'Name is missing.',
  profile_email_missing: () => 'Email is missing.',
  profile_placeholder: (m) => m.replace(' in Profile first', ''),
  last_reviewed_malformed: () => 'Last reviewed should be a date like 2026-11-19.',
  profile_stale: (m) => {
    const date = /on (\d{4}-\d{2}-\d{2})/.exec(m)?.[1];
    return date ? `Last reviewed ${date}, over 30 days ago. Review the profile.` : m;
  },
  entry_id_missing: (m) => m.replace(/ has no \{#id\}$/, ' needs an {#id}.'),
  skill_level_range: (m) => m.replace(/: level must be an integer from 1 to 5$/, ': level must be 1 to 5.'),
};

export const friendlyMessage = (d: Pick<Diagnostic, 'code' | 'message'>): string =>
  COPY[d.code]?.(d.message) ?? d.message;

const plural = (n: number, word: string): string => `${String(n)} ${word}${n === 1 ? '' : 's'}`;

export function diagnosticsSummary(list: readonly Diagnostic[]): string {
  if (list.length === 0) return 'No problems found.';
  const { errors, warnings } = countDiagnostics(list);
  return `${plural(errors, 'error')} · ${plural(warnings, 'warning')}`;
}

/** Skill dialog state: every field is text, as typed. */
export interface SkillForm {
  skill: string;
  category: string;
  level: string;
  years: string;
  last_used: string;
  evidence: string;
  status: string;
  aliases: string;
}

/** Level and last used start empty: a claim about the user's experience is never prefilled. */
export const emptySkillForm = (): SkillForm => ({
  skill: '',
  category: SKILL_CATEGORIES[0],
  level: '',
  years: '',
  last_used: '',
  evidence: '',
  status: SKILL_STATUSES[0],
  aliases: '',
});

export const rowToForm = (r: SkillRow): SkillForm => ({
  skill: r.skill,
  category: r.category,
  level: r.level === null ? '' : String(r.level),
  years: r.years === null ? '' : String(r.years),
  last_used: r.last_used,
  evidence: formatList(r.evidence),
  status: r.status,
  aliases: formatList(r.aliases),
});

export interface SkillFormError {
  field: keyof SkillForm;
  message: string;
}

/** Form -> row, or the first problem in user words, tied to the field that has it. */
export function formToRow(f: SkillForm): { row: SkillRow } | { error: SkillFormError } {
  const fail = (field: keyof SkillForm, message: string): { error: SkillFormError } => ({
    error: { field, message },
  });
  const skill = f.skill.trim();
  if (skill === '') return fail('skill', 'Skill name is required.');
  if (/[|\n]/.test(skill)) return fail('skill', 'Skill name cannot contain "|" or line breaks.');
  const level = parseNumberOrNull(f.level);
  if (level === null || !Number.isInteger(level) || level < 1 || level > 5)
    return fail('level', 'Level must be a whole number from 1 to 5.');
  const years = parseNumberOrNull(f.years);
  if (f.years.trim() !== '' && (years === null || years < 0))
    return fail('years', 'Years must be a number, 0 or more.');
  const lastUsed = f.last_used.trim();
  if (lastUsed !== '' && !/^(\d{4}|now)$/.test(lastUsed))
    return fail('last_used', 'Last used is a year (2024) or "now".');
  return {
    row: {
      skill,
      category: f.category,
      level,
      years,
      last_used: lastUsed,
      evidence: parseList(f.evidence),
      status: f.status,
      aliases: parseList(f.aliases),
    },
  };
}

/**
 * The existing row that `row` would overwrite or shadow (same name or alias, case-insensitive),
 * ignoring the row being edited (`previous`). Null when the row is free to save.
 */
export function skillConflict(
  skills: readonly SkillRow[],
  row: SkillRow,
  previous: string | null,
): SkillRow | null {
  const mine = skillKeys(row);
  return (
    skills.find(
      (o) => (previous === null || !matchesSkill(o, previous)) && skillKeys(o).some((k) => mine.includes(k)),
    ) ?? null
  );
}

/** Category, then name, so the table reads in groups. Does not mutate. */
export const sortSkills = (skills: readonly SkillRow[]): SkillRow[] =>
  [...skills].sort(
    (a, b) =>
      a.category.localeCompare(b.category) ||
      a.skill.localeCompare(b.skill, undefined, { sensitivity: 'base' }),
  );

/** Entry ids that skills can cite as evidence. */
export function evidenceIds(model: Profile): string[] {
  return [...model.experience, ...model.projects].map((e) => e.id).filter((id) => id !== '');
}

/** 1-based line of the `### ... {#id}` heading, or null. */
export function entryLine(markdown: string, id: string): number | null {
  if (id === '') return null;
  const i = markdown.split('\n').findIndex((l) => /^###\s/.test(l) && l.includes(`{#${id}}`));
  return i < 0 ? null : i + 1;
}

/** "3 d ago", "2 h ago", "just now"; falls back to the date for old or invalid input. */
export function relativeTime(iso: string, now = new Date()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const s = Math.round((now.getTime() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${String(Math.floor(s / 60))} min ago`;
  if (s < 86400) return `${String(Math.floor(s / 3600))} h ago`;
  if (s < 86400 * 30) return `${String(Math.floor(s / 86400))} d ago`;
  return iso.slice(0, 10);
}

/** Combine commit messages of edits made since the last save: one kind keeps its label. */
export const mergeMessage = (current: string | null, next: string): string =>
  current === null || current === next ? next : GENERIC_MESSAGE;

/** Compact mono line for an entry: dates and location. */
export function entryMeta(e: Entry): string {
  const m = e.meta;
  const dates = m.start || m.end ? `${m.start ?? ''} – ${m.end ?? ''}` : (m.dates ?? m.date ?? '');
  return [dates, m.location].filter((x): x is string => !!x).join(' · ');
}
