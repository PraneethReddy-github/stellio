import type { Jd } from '../jobs/schemas';
import { canonicalSkillKey } from '../profile/skills';
import { lookupSkill } from './index';
import type { DEMAND_WINDOWS, DemandShare } from './schemas';

export type DemandWindow = (typeof DEMAND_WINDOWS)[number];
export interface DemandEntry extends DemandShare {
  /** Canonical display name: the dictionary name, else the text as the JD wrote it. */
  skill: string;
}
export interface DemandJob {
  /** ISO timestamp the job counts from (posted, else first seen). */
  at: string;
  /** Null when the posting was never parsed: such a job is not counted at all. */
  jd: Jd | null;
}

const DAY = 86_400_000;
const WINDOW_DAYS: Record<DemandWindow, number | null> = { '30d': 30, '90d': 90, all: null };

/** Key shared by demand rows and audit rows: the dictionary name when the skill is known. */
export const demandKey = (name: string): string => canonicalSkillKey(lookupSkill(name)?.name ?? name);

/**
 * Demand per window (docs/07 §2). A job counts when its structured JD lists the skill under a required or
 * preferred requirement; `requiredShare` counts only required ones. Shares divide by the jobs with a parsed JD
 * inside the window. A job with an unreadable date counts only in `all`. Pure.
 */
export function computeDemand(jobs: readonly DemandJob[], now: Date): Record<DemandWindow, DemandEntry[]> {
  const out = {} as Record<DemandWindow, DemandEntry[]>;
  for (const [window, days] of Object.entries(WINDOW_DAYS) as [DemandWindow, number | null][]) {
    const inWindow = jobs.filter((j) => {
      if (j.jd === null) return false;
      if (days === null) return true;
      const t = Date.parse(j.at);
      return !Number.isNaN(t) && now.getTime() - t <= days * DAY && t <= now.getTime() + DAY;
    });
    const stats = new Map<string, { skill: string; jobs: number; required: number }>();
    for (const { jd } of inWindow) {
      const seen = new Map<string, { skill: string; required: boolean }>();
      for (const req of jd?.requirements ?? [])
        for (const raw of req.skills) {
          const name = lookupSkill(raw)?.name ?? raw.trim();
          if (name === '') continue;
          const key = canonicalSkillKey(name);
          const prev = seen.get(key);
          seen.set(key, { skill: name, required: (prev?.required ?? false) || req.kind === 'required' });
        }
      for (const [key, v] of seen) {
        const s = stats.get(key) ?? { skill: v.skill, jobs: 0, required: 0 };
        s.jobs++;
        if (v.required) s.required++;
        stats.set(key, s);
      }
    }
    out[window] = [...stats.values()]
      .map((s) => ({
        skill: s.skill,
        jobCount: s.jobs,
        share: s.jobs / inWindow.length,
        requiredShare: s.required / inWindow.length,
      }))
      .sort((a, b) => b.jobCount - a.jobCount || a.skill.localeCompare(b.skill));
  }
  return out;
}

/** Learning / gap priority 1-5 from demand: required counts double (docs/07 §5). */
export function demandPriority(d: Pick<DemandShare, 'share' | 'requiredShare'> | null): number {
  if (!d) return 1;
  const score = d.requiredShare * 2 + (d.share - d.requiredShare);
  return score >= 0.6 ? 5 : score >= 0.35 ? 4 : score >= 0.15 ? 3 : score >= 0.05 ? 2 : 1;
}
