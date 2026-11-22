import { z } from 'zod';
import type { Db } from '../../db/database';
import { getSetting, setSetting } from '../../db/repos/settings';
import {
  AiSettingsSchema,
  resolveAiSettings,
  taskConfig,
  type AiSettings,
  type AiTask,
  type TaskConfig,
} from '@shared/settings/ai';

const KEY = 'ai';

/** Typed AI settings in `settings_kv`. A broken stored value falls back to defaults instead of blocking the app. */
export function createAiSettings(db: Db) {
  const get = (): AiSettings => {
    let stored: unknown;
    try {
      stored = getSetting(db, KEY, z.unknown());
    } catch {
      stored = undefined;
    }
    return resolveAiSettings(stored);
  };
  return {
    get,
    /** Validates strictly; throws a ZodError on bad input. */
    set(value: unknown): AiSettings {
      const parsed = AiSettingsSchema.parse(value);
      setSetting(db, KEY, parsed);
      return parsed;
    },
    forTask: (task: AiTask): TaskConfig => taskConfig(get(), task),
  };
}
export type AiSettingsService = ReturnType<typeof createAiSettings>;
