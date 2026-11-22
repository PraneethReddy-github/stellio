import { z } from 'zod';

export const NotificationSettingsSchema = z.object({
  /** The daily follow-up digest. */
  digestEnabled: z.boolean(),
  /** Local time, `HH:MM`: the digest goes out at the first check at or after it. */
  digestTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  /** The "N new matches" notification after a scheduled scan. */
  scanEnabled: z.boolean(),
});
export type NotificationSettings = z.infer<typeof NotificationSettingsSchema>;

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  digestEnabled: true,
  digestTime: '09:00',
  scanEnabled: true,
};
