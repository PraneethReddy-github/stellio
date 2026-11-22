import {
  DEFAULT_NOTIFICATION_SETTINGS,
  NotificationSettingsSchema,
  type NotificationSettings,
} from '@shared/settings/notifications';
import type { Db } from '../../db/database';
import { getSetting, setSetting } from '../../db/repos/settings';

const KEY = 'notifications.settings';

/** Notification switches in `settings_kv`; a missing or broken stored value falls back to the defaults. */
export function createNotificationSettings(db: Db) {
  return {
    get(): NotificationSettings {
      try {
        return getSetting(db, KEY, NotificationSettingsSchema) ?? DEFAULT_NOTIFICATION_SETTINGS;
      } catch {
        return DEFAULT_NOTIFICATION_SETTINGS;
      }
    },
    set(value: unknown): NotificationSettings {
      const parsed = NotificationSettingsSchema.parse(value);
      setSetting(db, KEY, parsed);
      return parsed;
    },
  };
}
export type NotificationSettingsService = ReturnType<typeof createNotificationSettings>;
