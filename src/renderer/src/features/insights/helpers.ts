// Pure helpers for the Insights screen. No React, no IPC: unit-tested.
import type { Dimension, InsightsSummary } from '@shared/insights';
import type { HBarRow } from '../../ui';
import { sourceLabel } from '../inbox/helpers';

export const pct = (x: number | null): string => (x === null ? '—' : `${String(Math.round(x * 100))}%`);

/** One row per segment; a segment under the minimum sample is greyed and states why instead of bars. */
export function dimensionRows(d: Dimension): HBarRow[] {
  return d.segments.map((s) => ({
    label: d.key === 'source' ? sourceLabel(s.label) : s.label,
    count: s.applications,
    cells: [
      { value: s.responseRate ?? 0, text: pct(s.responseRate) },
      { value: s.interviewRate ?? 0, text: pct(s.interviewRate) },
    ],
    ...(s.insufficient ? { muted: 'not enough data' } : {}),
  }));
}

/** Median days to the first reply; a dash while nobody has answered. */
export const medianText = (t: InsightsSummary['timeToResponse']): string =>
  t.medianDays === null ? '—' : String(t.medianDays);

/** Ghosting rate; a dash under the minimum sample (the note under the numbers says why). */
export const ghostingText = (g: InsightsSummary['ghosting']): string => (g.rate === null ? '—' : pct(g.rate));

/** The two questions docs/08 §5 names. */
export const SUGGESTED_QUESTIONS = ['Which roles should I prioritize?', 'What should I learn next?'] as const;

export const WINDOW_OPTIONS = [
  { value: '90d', label: 'Last 90 days' },
  { value: 'all', label: 'All time' },
] as const;
