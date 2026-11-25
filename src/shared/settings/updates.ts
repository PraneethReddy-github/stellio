import { z } from 'zod';

export const UpdateSettingsSchema = z.object({
  /** Ask GitHub for the newest release at start and once a day. Off = Stellio asks only on "Check now". */
  autoCheck: z.boolean(),
});
export type UpdateSettings = z.infer<typeof UpdateSettingsSchema>;
export const DEFAULT_UPDATE_SETTINGS: UpdateSettings = { autoCheck: true };

export const UpdateStatusSchema = z.object({
  current: z.string(),
  /** The newer version and its release page; null when there is none or no check ran. */
  available: z.object({ version: z.string(), url: z.string() }).nullable(),
});
export type UpdateStatus = z.infer<typeof UpdateStatusSchema>;

const VERSION = /^(\d{1,5})\.(\d{1,5})\.(\d{1,5})$/;

/** True when `a` is a newer `x.y.z` than `b`. Anything else (pre-releases, junk) is never newer. */
export function isNewer(a: string, b: string): boolean {
  const x = VERSION.exec(a);
  const y = VERSION.exec(b);
  if (!x || !y) return false;
  for (let i = 1; i <= 3; i++) {
    const d = Number(x[i]) - Number(y[i]);
    if (d !== 0) return d > 0;
  }
  return false;
}
