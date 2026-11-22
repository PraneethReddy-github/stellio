import { DEFAULT_SETUP, SetupPatchSchema, SetupStateSchema, type SetupState } from '@shared/setup';
import type { Db } from '../../db/database';
import { getSetting, setSetting } from '../../db/repos/settings';

const KEY = 'setup.state';

/** First-run checklist memory in `settings_kv`; a missing or broken stored value falls back to "not done". */
export function createSetupSettings(db: Db) {
  const get = (): SetupState => {
    try {
      return getSetting(db, KEY, SetupStateSchema) ?? DEFAULT_SETUP;
    } catch {
      return DEFAULT_SETUP;
    }
  };
  return {
    get,
    /** Merges the given flags; the others stay as they were. */
    set(patch: unknown): SetupState {
      const next = { ...get(), ...SetupPatchSchema.parse(patch) };
      setSetting(db, KEY, next);
      return next;
    },
  };
}
export type SetupSettingsService = ReturnType<typeof createSetupSettings>;
