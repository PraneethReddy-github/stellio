// Pure helpers for the Workspace screen. No React, no IPC: unit-tested.
import type { JobSummary } from '../../lib/jobs';

type Verdict = NonNullable<JobSummary['verdict']>;
type Remote = JobSummary['remote'];
type State = JobSummary['state'];

export type Tone = 'ok' | 'warn' | 'bad';

export const FIT_THRESHOLDS = { ok: 75, warn: 50 } as const;

export const VERDICT_TONE: Record<Verdict, Tone> = { apply: 'ok', stretch: 'warn', skip: 'bad' };
export const VERDICT_LABEL: Record<Verdict, string> = { apply: 'Apply', stretch: 'Stretch', skip: 'Skip' };

export const REMOTE_LABEL: Record<Remote, string | null> = {
  remote: 'Remote',
  hybrid: 'Hybrid',
  onsite: 'On-site',
  unknown: null,
};

export const STATE_LABEL: Record<State, string> = {
  new: 'New',
  shortlisted: 'Shortlisted',
  dismissed: 'Not applying',
  archived: 'Archived',
};

const PERIOD_LABEL: Record<string, string> = {
  year: 'year',
  month: 'month',
  week: 'week',
  day: 'day',
  hour: 'hour',
};

const num = (n: number): string => n.toLocaleString('en-US', { maximumFractionDigits: 0 });

/** "EUR 65,000–80,000 / year"; one-sided ranges read "from" / "up to"; null when nothing is known. */
export function formatSalary(
  min: number | null,
  max: number | null,
  currency: string | null,
  period: string | null,
): string | null {
  if (min === null && max === null) return null;
  const range =
    min !== null && max !== null
      ? min === max
        ? num(min)
        : `${num(min)}–${num(max)}`
      : min !== null
        ? `from ${num(min)}`
        : `up to ${num(max ?? 0)}`;
  const per = period ? PERIOD_LABEL[period] : undefined;
  return [currency, range].filter(Boolean).join(' ') + (per ? ` / ${per}` : '');
}

export const formatLocation = (j: Pick<JobSummary, 'locationText' | 'country'>): string | null =>
  j.locationText?.trim() || j.country?.trim() || null;

/** `2026-11-19T10:00:00Z` or `2026-11-19` -> `2026-11-19`. */
export const isoDay = (iso: string): string => iso.slice(0, 10);

/** Only http(s) links are rendered as anchors; main opens them in the OS browser. */
export const isWebUrl = (url: string | null): url is string => url !== null && /^https?:\/\/\S+$/i.test(url);

/** "Senior" / "Full time": enum values to words. */
export const humanize = (v: string): string => {
  const t = v.replace(/_/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
};

/** The Fit footer: evidence ids the model cited that are not in the profile (raw detail stays in Activity). */
export function removedCitationsNote(warnings: readonly string[]): string | null {
  const n = warnings.filter((w) => w.includes('dropped unknown evidence id')).length;
  if (n === 0) return null;
  return n === 1
    ? '1 cited item was not in your profile and was removed.'
    : `${String(n)} cited items were not in your profile and were removed.`;
}

// The router's route table is untyped (plain string paths), so links are built as strings.
export const WORKSPACE: string = '/workspace';
export const jobPath = (id: string): string => `/workspace/${id}`;
