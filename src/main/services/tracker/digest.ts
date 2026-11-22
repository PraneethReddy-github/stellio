import { z } from 'zod';
import { localDateStr } from '@shared/tracker';
import type { NotificationSettings } from '@shared/settings/notifications';
import type { Db } from '../../db/database';
import { getSetting, setSetting } from '../../db/repos/settings';
import type { TrackerService } from './service';

export interface Notice {
  title: string;
  body: string;
}
const KEY = 'tracker.digest.lastSent';

/** Daily digest of due follow-ups: at most one notification per local day, from the configured time on, checked at start and then hourly. */
export function createDigest(deps: {
  db: Db;
  tracker: Pick<TrackerService, 'dueFollowUps'>;
  notify: (n: Notice) => void;
  /** Digest on/off and time; without it the digest is always on, with no earliest time. */
  settings?: () => Pick<NotificationSettings, 'digestEnabled' | 'digestTime'>;
  now?: () => Date;
  onError?: (e: unknown) => void;
}) {
  const now = deps.now ?? (() => new Date());
  let timer: NodeJS.Timeout | undefined;

  /** Posts the digest when something is due and none went out today. Returns whether it posted. */
  function check(): boolean {
    const at = now();
    const cfg = deps.settings?.();
    if (cfg) {
      if (!cfg.digestEnabled) return false;
      const minutes = at.getHours() * 60 + at.getMinutes();
      const [h = 0, m = 0] = cfg.digestTime.split(':').map(Number);
      if (minutes < h * 60 + m) return false;
    }
    const today = localDateStr(at);
    if (getSetting(deps.db, KEY, z.string()) === today) return false;
    const due = deps.tracker.dueFollowUps();
    if (due.length === 0) return false;
    const lines = due.slice(0, 5).map((d) => `${d.company} — ${d.role}: ${d.action}`);
    if (due.length > 5) lines.push(`and ${String(due.length - 5)} more`);
    deps.notify({
      title: due.length === 1 ? '1 follow-up due' : `${String(due.length)} follow-ups due`,
      body: lines.join('\n'),
    });
    setSetting(deps.db, KEY, today);
    return true;
  }

  return {
    check,
    start(intervalMs = 3_600_000): void {
      if (timer) return;
      const safe = (): void => {
        try {
          check();
        } catch (e) {
          // a notification problem must never take the app down; the next tick tries again
          deps.onError?.(e);
        }
      };
      safe();
      timer = setInterval(safe, intervalMs);
      timer.unref();
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
export type Digest = ReturnType<typeof createDigest>;
