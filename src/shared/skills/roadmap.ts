// Learning roadmap (docs/07 §5): priority, "unlocks N jobs" and the what-if approximation. Pure, code only.
import { z } from 'zod';
import { demandKey } from './demand';
import { DemandShareSchema, LEARNING_STATUSES, type DemandShare } from './schemas';

/** A job that is still open to you (inbox or shortlisted, not applied), as the roadmap sees it. */
export interface RoadmapJob {
  id: string;
  company: string;
  title: string;
  /** Latest full analysis; null when the job was never analysed. */
  fit: number | null;
  verdict: 'apply' | 'stretch' | 'skip' | null;
  /** `demandKey`s of required JD skills the profile does not list as `have`. */
  missingRequired: string[];
  /** Same for preferred JD skills. */
  missingPreferred: string[];
}

/** Hours assumed when a learning item has no estimate yet. */
export const DEFAULT_EST_HOURS = 40;

/** Demand weight: required counts double, preferred once (docs/07 §5). */
export const demandWeight = (d: Pick<DemandShare, 'share' | 'requiredShare'> | null): number =>
  d === null ? 0 : d.requiredShare * 2 + (d.share - d.requiredShare);

/** Open jobs whose missing required skills would drop to zero with this skill (it is the only one left). */
export function unlockedJobs(skill: string, jobs: readonly RoadmapJob[]): RoadmapJob[] {
  const key = demandKey(skill);
  return jobs.filter((j) => j.missingRequired.length > 0 && j.missingRequired.every((m) => m === key));
}

/**
 * Raw priority = demand weight x fit-uplift x (1 / est. hours).
 * fit-uplift = 1 + unlocked jobs / open jobs: a skill that makes whole jobs applicable counts more than one
 * that only appears in many postings. Items without hours use `DEFAULT_EST_HOURS`.
 */
export function rawPriority(
  demand: Pick<DemandShare, 'share' | 'requiredShare'> | null,
  unlocks: number,
  openJobs: number,
  estHours: number | null,
): number {
  const uplift = 1 + (openJobs === 0 ? 0 : unlocks / openJobs);
  return (demandWeight(demand) * uplift) / Math.max(1, estHours ?? DEFAULT_EST_HOURS);
}

/** Raw scores scaled so the best item is 5 and nothing is below 1; all-zero stays 1. */
export function normalizePriorities(raw: readonly number[]): number[] {
  const max = Math.max(0, ...raw);
  return raw.map((r) => (max === 0 ? 1 : Math.max(1, Math.round(1 + (4 * r) / max))));
}

export const RoadmapItemSchema = z.object({
  id: z.string(),
  skill: z.string(),
  status: z.enum(LEARNING_STATUSES),
  /** 1-5, from `rawPriority` normalised over the roadmap. */
  priority: z.number().int(),
  estHours: z.number().int().nullable(),
  /** 90-day demand; null when no stored job names the skill. */
  demand: DemandShareSchema.nullable(),
  unlocks: z.number().int(),
  unlockJobs: z.array(z.object({ jobId: z.string(), company: z.string(), title: z.string() })),
  /** "Tableau: required in 41% of your jobs, ~25 h (estimate) to working level, unlocks 9 jobs in your inbox." */
  summary: z.string(),
  resourcesMd: z.string().nullable(),
});
export type RoadmapItem = z.infer<typeof RoadmapItemSchema>;

export const WhatIfSchema = z.object({
  skills: z.array(z.string()),
  /** Open jobs whose verdict is stretch. */
  stretchJobs: z.number().int(),
  moved: z.array(
    z.object({
      jobId: z.string(),
      company: z.string(),
      title: z.string(),
      before: z.number().int(),
      after: z.number().int(),
    }),
  ),
});
export type WhatIf = z.infer<typeof WhatIfSchema>;

const pct = (x: number): string => `${String(Math.round(x * 100))}%`;
const plural = (n: number, one: string): string => `${String(n)} ${one}${n === 1 ? '' : 's'}`;

/** The one-line roadmap statement. Hours are always labelled as an estimate. */
export function roadmapSummary(
  skill: string,
  demand: DemandShare | null,
  estHours: number | null,
  unlocks: number,
): string {
  const asked =
    demand === null
      ? 'not named by your stored jobs'
      : demand.requiredShare > 0
        ? `required in ${pct(demand.requiredShare)} of your jobs`
        : `named in ${pct(demand.share)} of your jobs`;
  const hours =
    estHours === null ? 'no hours estimate yet' : `~${String(estHours)} h (estimate) to working level`;
  return `${skill}: ${asked}, ${hours}, unlocks ${plural(unlocks, 'job')} in your inbox.`;
}

// ---- what-if ---------------------------------------------------------------------------------------------

/** Score points a stretch job gains per newly covered skill. A rough weight, not a re-score (see `whatIf`). */
export const GAIN_REQUIRED = 6;
export const GAIN_PREFERRED = 3;
/** The analysis prompt's band: a score of 70 or more is "apply". */
export const APPLY_SCORE = 70;

/**
 * "What if I had these skills?" for 1-3 skills: how many open stretch jobs would become apply.
 *
 * Approximation (docs/07 §5), code only, no AI: a stretch job gets `GAIN_REQUIRED` score points for every
 * required skill and `GAIN_PREFERRED` for every preferred skill that is currently missing and would be covered
 * by the chosen skills; it moves to apply when the new score reaches `APPLY_SCORE`. It does not read the
 * posting again and does not know how the model weighted each gap, so treat the count as a direction, not a
 * promise. Jobs without a score or not at stretch are never counted.
 */
export function whatIf(skills: readonly string[], jobs: readonly RoadmapJob[]): WhatIf {
  const keys = new Set(skills.map(demandKey));
  const stretch = jobs.filter((j) => j.verdict === 'stretch' && j.fit !== null);
  const moved = stretch.flatMap((j) => {
    const before = j.fit as number;
    const gain =
      j.missingRequired.filter((m) => keys.has(m)).length * GAIN_REQUIRED +
      j.missingPreferred.filter((m) => keys.has(m)).length * GAIN_PREFERRED;
    const after = Math.min(100, before + gain);
    return before < APPLY_SCORE && after >= APPLY_SCORE
      ? [{ jobId: j.id, company: j.company, title: j.title, before, after }]
      : [];
  });
  return { skills: [...skills], stretchJobs: stretch.length, moved };
}
