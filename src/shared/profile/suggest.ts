// `profile.suggest` (docs/07 §4): the model proposes skill edits; code decides which are allowed and builds the
// new profile text. Nothing here writes; the renderer shows the diff and saves through `profile:save`.
import { z } from 'zod';
import { resolveSkill } from '../skills/audit';
import { lookupSkill } from '../skills';
import { ProfilePreviewSchema } from '../skills/schemas';
import { profileEntryIds } from './compact';
import { setFrontMatterField, upsertSkill } from './edit';
import { parseProfile } from './parse';
import { serializeProfile } from './serialize';
import { canonicalSkillKey } from './skills';
import type { SkillRow } from './types';

export const ProfileSuggestOutputSchema = z.object({
  /** One or two sentences: what the edits are based on. */
  summary: z.string(),
  skill_updates: z.array(
    z.object({
      skill: z.string(),
      level: z.number().int().nullable(),
      years: z.number().nullable(),
      last_used: z.string().nullable(),
      status: z.enum(['have', 'learning', 'want']).nullable(),
      /** Entry ids from the profile that show the skill in use. */
      evidence: z.array(z.string()),
      reason: z.string(),
    }),
  ),
});
export type ProfileSuggestOutput = z.infer<typeof ProfileSuggestOutputSchema>;

export const SuggestionItemSchema = z.object({ skill: z.string(), change: z.string(), reason: z.string() });
export const ProfileSuggestionSchema = ProfilePreviewSchema.extend({
  summary: z.string(),
  items: z.array(SuggestionItemSchema),
  /** Edits the model proposed that code refused (no source, unknown evidence id, ...). */
  dropped: z.array(z.object({ skill: z.string(), why: z.string() })),
});
export type ProfileSuggestion = z.infer<typeof ProfileSuggestionSchema>;

/** What the suggestions may rest on: facts the user created, never the model's own claims. */
export interface SuggestSources {
  /** Skills added to the profile through a skill decision, or learned items marked done. */
  confirmed: readonly string[];
  /** Skills the user decided on (keep, remove, learn) in the last months. */
  decided: readonly string[];
  /** Free text the user wrote: application notes. */
  notes: string;
}

const LAST_USED = /^(\d{4}|now)$/;

/**
 * Applies the model's skill edits under code rules and returns the profile text that would result.
 *
 * - An update needs a source: the skill is in `confirmed` or `decided`, or the notes name it.
 * - A skill the profile lacks can only be added when it is `confirmed` (decision "added" or learning done).
 * - `status: have` on an existing learning/want row needs `confirmed`.
 * - `level` moves by at most one step (1-5); `years` is 0-60; `last_used` is a year or "now";
 *   `evidence` keeps only entry ids that exist in the profile.
 * - `last_reviewed` is set to `today`, so confirming the diff also clears the review nudge.
 * Pure.
 */
export function applySuggestions(
  markdown: string,
  out: ProfileSuggestOutput,
  sources: SuggestSources,
  today: string,
): Pick<ProfileSuggestion, 'after' | 'items' | 'dropped'> {
  const parsed = parseProfile(markdown);
  let doc = parsed.doc;
  const ids = profileEntryIds(parsed.model);
  const confirmed = new Set(sources.confirmed.map((s) => resolveSkill(s, parsed.model).key));
  const decided = new Set(sources.decided.map((s) => resolveSkill(s, parsed.model).key));
  const notes = sources.notes.toLowerCase();
  const items: ProfileSuggestion['items'] = [];
  const dropped: ProfileSuggestion['dropped'] = [];
  const seen = new Set<string>();

  for (const u of out.skill_updates) {
    const { key, row, display } = resolveSkill(u.skill, parsed.model);
    const name = row?.skill ?? display;
    const drop = (why: string): void => void dropped.push({ skill: name, why });
    if (seen.has(key)) {
      drop('listed twice');
      continue;
    }
    seen.add(key);
    const sourced =
      confirmed.has(key) ||
      decided.has(key) ||
      notes.includes(canonicalSkillKey(name)) ||
      notes.includes(key);
    if (!sourced) {
      drop('no decision, finished learning item or note mentions it');
      continue;
    }
    if (!row && !confirmed.has(key)) {
      drop('not in the profile, and you have not added it or finished learning it');
      continue;
    }

    const evidence = u.evidence.filter((e) => ids.has(e));
    const current: SkillRow = row ?? {
      skill: name,
      category: lookupSkill(name)?.category ?? 'tool',
      level: null,
      years: null,
      last_used: '',
      evidence: [],
      status: 'have',
      aliases: [],
    };
    const next: SkillRow = { ...current };
    const changes: string[] = [];
    const set = <K extends 'level' | 'years' | 'last_used' | 'status'>(
      k: K,
      v: SkillRow[K],
      label: string,
    ): void => {
      if (next[k] === v) return;
      const was = current[k];
      changes.push(`${label} ${was === null || was === '' ? '—' : String(was)} to ${String(v)}`);
      next[k] = v;
    };
    if (u.level !== null && u.level >= 1 && u.level <= 5) {
      if (current.level === null || Math.abs(u.level - current.level) <= 1) set('level', u.level, 'level');
      else drop('level moves by more than one step');
    }
    if (u.years !== null && u.years >= 0 && u.years <= 60)
      set('years', Math.round(u.years * 10) / 10, 'years');
    if (u.last_used !== null && LAST_USED.test(u.last_used)) set('last_used', u.last_used, 'last used');
    if (u.status !== null) {
      if (u.status === 'have' && row && row.status !== 'have' && !confirmed.has(key))
        drop('status "have" needs a decision or a finished learning item');
      else set('status', u.status, 'status');
    }
    const merged = [...new Set([...current.evidence, ...evidence])];
    if (merged.length !== current.evidence.length) {
      next.evidence = merged;
      changes.push(`evidence ${merged.filter((e) => !current.evidence.includes(e)).join(', ')} added`);
    }
    if (changes.length === 0 && row) continue;
    doc = upsertSkill(doc, next);
    items.push({
      skill: name,
      change: row ? changes.join('; ') : `added as ${next.status}`,
      reason: u.reason.replace(/\s+/g, ' ').trim().slice(0, 300),
    });
  }
  doc = setFrontMatterField(doc, 'last_reviewed', today);
  return { after: serializeProfile(doc), items, dropped };
}
