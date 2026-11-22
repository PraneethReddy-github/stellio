import type { Schedule } from '@shared/discovery/schemas';
import { catchUpDue, scheduledDue } from '@shared/discovery/schedule';
import type { ScanRunRow } from '../../db/repos/discovery';

/**
 * In-app daily scan. At start it catches up when the last successful scan is older than 24 h; afterwards a
 * once-a-minute tick starts the scan when the daily time has passed. The DB lock stops it from overlapping with a
 * headless `--scan` (the systemd timer), which simply finds the lock taken.
 */
export function createScheduler(deps: {
  schedule: () => Schedule;
  lastSuccess: () => Date | null;
  lastAttempt: () => Date | null;
  scan: (trigger: ScanRunRow['trigger']) => Promise<unknown>;
  onError: (e: unknown) => void;
  now?: () => Date;
}) {
  const now = deps.now ?? (() => new Date());
  let timer: NodeJS.Timeout | undefined;
  let busy = false;

  const fire = (trigger: ScanRunRow['trigger']): void => {
    if (busy) return;
    busy = true;
    deps
      .scan(trigger)
      .catch(deps.onError)
      .finally(() => (busy = false));
  };
  const tick = (): void => {
    const s = deps.schedule();
    if (s.enabled && scheduledDue(now(), s.time, deps.lastAttempt())) fire('schedule');
  };

  return {
    start(tickMs = 60_000): void {
      if (timer) return;
      if (deps.schedule().enabled && catchUpDue(deps.lastSuccess(), now())) fire('startup_catchup');
      timer = setInterval(tick, tickMs);
      timer.unref();
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    /** Exposed for tests: one tick. */
    tick,
  };
}
