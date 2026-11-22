// Pure helpers for the Activity screen.
import type { AiRun } from '../../lib/activity';
import type { Tone } from '../../ui';

type Status = AiRun['status'];

export const RUN_TONE: Record<Status, Tone> = {
  running: 'info',
  ok: 'ok',
  cancelled: 'neutral',
  usage_limit: 'warn',
  error: 'bad',
  timeout: 'bad',
  invalid_output: 'bad',
  auth: 'bad',
  bad_model: 'bad',
};

export const RUN_LABEL: Record<Status, string> = {
  running: 'running',
  ok: 'ok',
  cancelled: 'cancelled',
  usage_limit: 'usage limit',
  error: 'error',
  timeout: 'timeout',
  invalid_output: 'invalid output',
  auth: 'auth',
  bad_model: 'bad model',
};

/** Failures need attention; cancelled is the user's own doing and running is not finished. */
export const isFailure = (r: Pick<AiRun, 'status'>): boolean =>
  r.status !== 'ok' && r.status !== 'running' && r.status !== 'cancelled';

/** "850 ms", "4.2 s", "1 m 05 s"; a dash while unknown. */
export function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${String(Math.round(ms))} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const total = Math.round(ms / 1000);
  return `${String(Math.floor(total / 60))} m ${String(total % 60).padStart(2, '0')} s`;
}

/** `2026-11-19T21:57:03.123Z` -> `2026-11-19 21:57:03` in the viewer's local time. */
export function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${String(d.getFullYear())}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
