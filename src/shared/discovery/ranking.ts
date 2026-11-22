import { yearlyMax } from './filters';
import type { DiscoverySettings } from './schemas';

/** Where a posting came from, best first: ATS direct > aggregator > web search (docs/05 §2). */
const ATS = new Set(['greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workable']);
export function sourceQuality(sources: readonly string[]): number {
  const q = (s: string): number => (ATS.has(s) || s === 'manual' ? 100 : s === 'websearch' ? 40 : 65);
  return sources.length === 0 ? 0 : Math.max(...sources.map(q));
}

export interface RankInput {
  /** Full-analysis fit, else the triage score; null = neither yet. */
  score: number | null;
  postedAt: string | null;
  firstSeenAt: string;
  sources: readonly string[];
  salaryMin: number | null;
  salaryMax: number | null;
  salaryPeriod: string | null;
  salaryFloor: number | null;
}

/** `0.6·fit + 0.15·recency + 0.15·source quality + 0.1·salary fit`, each part 0-100 (docs/05 §2). */
export function rank(
  j: RankInput,
  now: Date,
  { weights, maxAgeDays }: Pick<DiscoverySettings, 'weights' | 'maxAgeDays'>,
): number {
  const fit = j.score ?? 40; // no score yet: neutral-low, so scored jobs lead
  const ageDays = Math.max(0, (now.getTime() - Date.parse(j.postedAt ?? j.firstSeenAt)) / 86_400_000);
  const recency = Number.isNaN(ageDays) ? 0 : Math.max(0, 100 * (1 - ageDays / maxAgeDays));
  const top = yearlyMax({ salaryMin: j.salaryMin, salaryMax: j.salaryMax, salaryPeriod: j.salaryPeriod });
  const salary =
    top === null || j.salaryFloor === null || j.salaryFloor <= 0
      ? 50
      : Math.min(100, (100 * top) / j.salaryFloor);
  const total =
    weights.fit * fit +
    weights.recency * recency +
    weights.source * sourceQuality(j.sources) +
    weights.salary * salary;
  return Math.round(total * 10) / 10;
}
