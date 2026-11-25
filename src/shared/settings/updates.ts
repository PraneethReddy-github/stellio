import { z } from 'zod';

export const UpdateSettingsSchema = z.object({
  /** Ask GitHub for the newest release at start and once a day. Off = Stellio asks only on "Check now". */
  autoCheck: z.boolean(),
});
export type UpdateSettings = z.infer<typeof UpdateSettingsSchema>;
export const DEFAULT_UPDATE_SETTINGS: UpdateSettings = { autoCheck: true };

export const UpdateStatusSchema = z.object({
  current: z.string(),
  /** The newest version; null when this is it or no check ran. */
  available: z
    .object({
      version: z.string(),
      /** Its release page. */
      url: z.string(),
      /** What changed in every release after this version, newest first (Markdown, shown as text). */
      notes: z.array(z.object({ version: z.string(), body: z.string() })),
      /** Stellio can download and install it itself (a .deb or AppImage install with a verifiable file). */
      installable: z.boolean(),
      size: z.number().int().nullable(),
    })
    .nullable(),
  /** Installed in this session; a restart runs it. */
  installed: z.string().nullable(),
});
export type UpdateStatus = z.infer<typeof UpdateStatusSchema>;

export interface UpdateProgress {
  phase: 'download' | 'verify' | 'install';
  received: number;
  total: number;
}

/** The release notes as plain lines: Markdown marks dropped, list depth kept. */
export function noteLines(body: string): { depth: number; text: string; item: boolean }[] {
  return body
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => {
      const m = /^(\s*)[-*]\s+(.*)$/.exec(l);
      const text = (m?.[2] ?? l.replace(/^\s*#+\s*/, '')).replace(/\*\*|`/g, '').trim();
      return { depth: m ? Math.min(2, Math.floor((m[1] ?? '').length / 2)) : 0, text, item: m !== null };
    });
}

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
