// Pure helpers for the Inbox screen. No React, no IPC: unit-tested.
import type { InboxItem, ScanRun, SearchProfile } from '@shared/discovery/schemas';
import type { Tone } from '../../ui/StatusDot';
import { FIT_THRESHOLDS } from '../workspace/helpers';

export const dash = '—';

/** Score band filter: the inbox query takes a minimum score. */
export const BANDS = [
  { value: 'any', label: 'Any score', min: undefined },
  { value: '50', label: '50 and up', min: FIT_THRESHOLDS.warn },
  { value: '75', label: '75 and up', min: FIT_THRESHOLDS.ok },
] as const;

export const REMOTE_FILTERS = [
  { value: 'any', label: 'Any location' },
  { value: 'remote', label: 'Remote' },
  { value: 'hybrid', label: 'Hybrid' },
  { value: 'onsite', label: 'On-site' },
] as const;

export const SOURCE_LABEL: Record<string, string> = {
  adzuna: 'Adzuna',
  arbeitnow: 'Arbeitnow',
  ba: 'Arbeitsagentur',
  remotive: 'Remotive',
  remoteok: 'RemoteOK',
  himalayas: 'Himalayas',
  watchlist: 'Watchlist',
  websearch: 'Web search',
  pipeline: 'Pipeline',
  manual: 'Pasted by you',
};
export const sourceLabel = (id: string): string => SOURCE_LABEL[id] ?? id;

export const scoreTone = (score: number | null): Tone =>
  score === null
    ? 'neutral'
    : score >= FIT_THRESHOLDS.ok
      ? 'ok'
      : score >= FIT_THRESHOLDS.warn
        ? 'warn'
        : 'bad';

export interface InboxFilters {
  profileId: string;
  band: string;
  remote: string;
  source: string;
  newOnly: boolean;
  text: string;
}
export const NO_FILTERS: InboxFilters = {
  profileId: 'any',
  band: 'any',
  remote: 'any',
  source: 'any',
  newOnly: false,
  text: '',
};

/** The filters `jobs:inbox` understands. The rest are applied in `applyLocalFilters`. */
export function inboxQuery(f: InboxFilters): {
  filters: { minScore?: number; source?: string; remote?: 'remote' | 'hybrid' | 'onsite'; text?: string };
  sort: 'rank';
  limit: number;
} {
  const min = BANDS.find((b) => b.value === f.band)?.min;
  return {
    filters: {
      ...(min !== undefined ? { minScore: min } : {}),
      ...(f.source !== 'any' ? { source: f.source } : {}),
      ...(f.remote === 'remote' || f.remote === 'hybrid' || f.remote === 'onsite'
        ? { remote: f.remote }
        : {}),
      ...(f.text.trim() ? { text: f.text.trim() } : {}),
    },
    sort: 'rank',
    limit: 500,
  };
}

const fold = (s: string): string => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();

/**
 * Jobs do not remember which search profile found them, so the profile filter is a title match on the profile's
 * roles and keywords (a profile without any shows everything).
 */
export function matchesProfile(
  item: Pick<InboxItem, 'title'>,
  p: Pick<SearchProfile, 'roles' | 'keywords'>,
): boolean {
  const terms = [...p.roles, ...p.keywords].map(fold).filter(Boolean);
  if (terms.length === 0) return true;
  const title = fold(item.title);
  return terms.some((t) => title.includes(t));
}

/** Filters the inbox query cannot express: the search profile and "new since the last scan". */
export function applyLocalFilters(
  rows: InboxItem[],
  f: Pick<InboxFilters, 'profileId' | 'newOnly'>,
  profiles: SearchProfile[],
  lastScan: Pick<ScanRun, 'startedAt'> | null,
): InboxItem[] {
  const profile = f.profileId === 'any' ? undefined : profiles.find((p) => p.id === f.profileId);
  return rows.filter(
    (r) =>
      (!profile || matchesProfile(r, profile)) &&
      (!f.newOnly || (lastScan !== null && r.firstSeenAt >= lastScan.startedAt)),
  );
}

export const isFiltered = (f: InboxFilters): boolean =>
  JSON.stringify({ ...f, text: f.text.trim() }) !== JSON.stringify(NO_FILTERS);

export const DISMISS_REASONS = [
  { value: 'not_a_fit', label: 'Not a fit' },
  { value: 'location', label: 'Location' },
  { value: 'salary', label: 'Salary' },
  { value: 'seniority', label: 'Seniority' },
  { value: 'company', label: 'Company' },
  { value: 'other', label: 'Other' },
] as const;

/** The stored dismissal text: the reason's label, then the note when there is one (200 characters at most). */
export function dismissReason(value: string, note: string): string {
  const label = DISMISS_REASONS.find((r) => r.value === value)?.label ?? 'Other';
  const n = note.trim();
  return (n ? `${label}: ${n}` : label).slice(0, 200);
}

/** The row to select after `id` leaves the list: the next one, else the previous one, else none. */
export function neighbour(rows: readonly { jobId: string }[], id: string): string | null {
  const i = rows.findIndex((r) => r.jobId === id);
  if (i < 0) return null;
  return (rows[i + 1] ?? rows[i - 1])?.jobId ?? null;
}

/** Sources of a scan that reported errors, with their first message. */
export function sourceErrors(
  run: Pick<ScanRun, 'perSource'> | null,
): { source: string; message: string; more: number }[] {
  if (!run) return [];
  return Object.entries(run.perSource)
    .filter(([, v]) => v.errors.length > 0)
    .map(([source, v]) => ({ source, message: v.errors[0] ?? '', more: v.errors.length - 1 }));
}

/** "2026-11-21 08:00 · ok · 9 new · 8 sources" */
export function lastScanLine(run: ScanRun | null, formatWhen: (iso: string) => string): string {
  if (!run) return 'No scan yet.';
  const n = Object.keys(run.perSource).filter((k) => k !== 'pipeline').length;
  return `Last scan ${formatWhen(run.startedAt)} · ${run.error === 'cancelled' ? 'cancelled' : run.status} · ${String(run.newJobs)} new · ${String(n)} ${n === 1 ? 'source' : 'sources'}`;
}
