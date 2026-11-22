// Staleness nudges (docs/07 §4): rows for the Today "Needs you" list. Pure, code only.
import { z } from 'zod';
import { DAY_MS, toMs } from '../tracker/status';
import { demandPriority } from './demand';
import type { DemandShare } from './schemas';

export const NudgeSchema = z.object({
  kind: z.enum(['stale_skill', 'stuck_learning', 'profile_review']),
  /** Short text shown after the label. */
  text: z.string(),
  /** Skill name for the first two, null for the profile review. */
  skill: z.string().nullable(),
  /** Where to act: '/profile' or '/skills'. */
  to: z.string(),
});
export type Nudge = z.infer<typeof NudgeSchema>;

export const STALE_SKILL_YEARS = 3;
export const STUCK_LEARNING_DAYS = 183;
export const PROFILE_REVIEW_DAYS = 30;
/** Demand priority from which a skill counts as "high demand" (`demandPriority`, 1-5). */
export const HIGH_DEMAND_PRIORITY = 4;

export interface NudgeInput {
  now: Date;
  /** `last_reviewed` of the profile (YYYY-MM-DD), empty when never set. */
  lastReviewed: string;
  /** Profile skills: `last_used` is "YYYY" or "now". */
  skills: { skill: string; lastUsed: string; status: string }[];
  /** Skills listed in the skills section of the resumes still in play (display names). */
  resumeSkills: readonly string[];
  /** Learning items that are being worked on; `updatedAt` is when they last changed. */
  doing: { skill: string; updatedAt: string; demand: DemandShare | null }[];
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** `last_used` "2021" counts as used until the end of 2021; "now" and blank are never stale. */
function lastUsedMs(value: string): number | null {
  const m = /^(\d{4})$/.exec(value.trim());
  return m ? Date.UTC(Number(m[1]), 11, 31) : null;
}

/** The three nudges of docs/07 §4, in this order: stale skills, stuck learning, profile review. */
export function computeNudges(i: NudgeInput): Nudge[] {
  const out: Nudge[] = [];
  const cutoff = new Date(i.now);
  cutoff.setFullYear(cutoff.getFullYear() - STALE_SKILL_YEARS);
  for (const s of i.skills) {
    const at = lastUsedMs(s.lastUsed);
    if (s.status !== 'have' || at === null || at >= cutoff.getTime()) continue;
    if (!i.resumeSkills.some((r) => same(r, s.skill))) continue;
    out.push({
      kind: 'stale_skill',
      skill: s.skill,
      text: `${s.skill} was last used in ${s.lastUsed} and is still on your resumes`,
      to: '/profile',
    });
  }
  for (const l of i.doing) {
    const days = Math.floor((i.now.getTime() - toMs(l.updatedAt)) / DAY_MS);
    if (days <= STUCK_LEARNING_DAYS || demandPriority(l.demand) < HIGH_DEMAND_PRIORITY) continue;
    out.push({
      kind: 'stuck_learning',
      skill: l.skill,
      text: `${l.skill} is in high demand and has been "doing" for ${String(Math.round(days / 30.4))} months`,
      to: '/skills',
    });
  }
  const reviewed = /^\d{4}-\d{2}-\d{2}$/.test(i.lastReviewed) ? toMs(i.lastReviewed) : NaN;
  if (!Number.isNaN(reviewed)) {
    const days = Math.floor((i.now.getTime() - reviewed) / DAY_MS);
    if (days > PROFILE_REVIEW_DAYS)
      out.push({
        kind: 'profile_review',
        skill: null,
        text: `Profile last reviewed ${String(days)} days ago`,
        to: '/profile',
      });
  }
  return out;
}
