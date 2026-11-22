const DAY_MS = 86_400_000;

/** The latest local `HH:MM` that is not after `now`. */
export function latestScheduled(now: Date, time: string): Date {
  const [h = 0, m = 0] = time.split(':').map(Number);
  const t = new Date(now);
  t.setHours(h, m, 0, 0);
  if (t.getTime() > now.getTime()) t.setDate(t.getDate() - 1);
  return t;
}

export function nextScheduled(now: Date, time: string): Date {
  const t = latestScheduled(now, time);
  t.setDate(t.getDate() + 1);
  return t;
}

/** App start: run when there was no successful scan in the last 24 h. */
export const catchUpDue = (lastSuccess: Date | null, now: Date): boolean =>
  lastSuccess === null || now.getTime() - lastSuccess.getTime() > DAY_MS;

/** Timer tick: the daily time has passed and no scan was started since it (failed ones count: retry tomorrow). */
export const scheduledDue = (now: Date, time: string, lastAttempt: Date | null): boolean =>
  lastAttempt === null || lastAttempt.getTime() < latestScheduled(now, time).getTime();
