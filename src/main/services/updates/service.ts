import { z } from 'zod';
import {
  DEFAULT_UPDATE_SETTINGS,
  isNewer,
  UpdateSettingsSchema,
  type UpdateSettings,
  type UpdateStatus,
} from '@shared/settings/updates';
import type { Db } from '../../db/database';
import { getSetting, setSetting } from '../../db/repos/settings';
import { UserError } from '../../ipc/dispatch';
import type { Logger } from '../../platform/logger';

const KEY = 'updates.settings';
const DAY_MS = 24 * 60 * 60_000;
const TIMEOUT_MS = 8_000;
const REPO = 'PraneethReddy-github/stellio';
export const RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const Release = z.object({ tag_name: z.string().regex(/^v\d+\.\d+\.\d+$/) });

export interface UpdatesDeps {
  db: Db;
  logger: Logger;
  current: string;
  /** False in dev and e2e runs: no unasked request. */
  autoAllowed: boolean;
  /** Where releases are listed; tests point it elsewhere. */
  apiUrl?: string;
  fetchFn?: typeof fetch;
  now?: () => number;
}

/**
 * Compares this version with the newest GitHub release. The request carries nothing about the user, and Stellio
 * never downloads or installs anything itself: the user opens the release page.
 */
export function createUpdatesService(deps: UpdatesDeps) {
  const { db, logger, current, autoAllowed, apiUrl = RELEASE_API, fetchFn = fetch, now = Date.now } = deps;
  let status: UpdateStatus = { current, available: null };
  let checkedAt: number | null = null;
  let inFlight: Promise<UpdateStatus> | null = null;

  async function request(): Promise<UpdateStatus> {
    checkedAt = now(); // a failed check also waits a day before the next automatic one
    const res = await fetchFn(apiUrl, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Stellio' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`GitHub answered ${String(res.status)}`);
    const version = Release.parse(await res.json()).tag_name.slice(1);
    status = {
      current,
      // The link is built here, never taken from the answer.
      available: isNewer(version, current)
        ? { version, url: `https://github.com/${REPO}/releases/tag/v${version}` }
        : null,
    };
    return status;
  }
  const check = (): Promise<UpdateStatus> =>
    (inFlight ??= request().finally(() => {
      inFlight = null;
    }));

  const get = (): UpdateSettings => {
    try {
      return getSetting(db, KEY, UpdateSettingsSchema) ?? DEFAULT_UPDATE_SETTINGS;
    } catch {
      return DEFAULT_UPDATE_SETTINGS;
    }
  };

  return {
    get,
    set(value: unknown): UpdateSettings {
      const parsed = UpdateSettingsSchema.parse(value);
      setSetting(db, KEY, parsed);
      return parsed;
    },
    /** For the banner: checks at most once a day, never when switched off, and never fails. */
    async status(): Promise<UpdateStatus> {
      if (!autoAllowed || !get().autoCheck || (checkedAt !== null && now() - checkedAt < DAY_MS))
        return status;
      try {
        return await check();
      } catch (e) {
        logger.info('updates.check_failed', { error: e instanceof Error ? e.message : String(e) });
        return status;
      }
    },
    /** "Check now": always asks, and says when it could not. */
    async checkNow(): Promise<UpdateStatus> {
      try {
        return await check();
      } catch (e) {
        logger.info('updates.check_failed', { error: e instanceof Error ? e.message : String(e) });
        throw new UserError('Could not reach GitHub to check for updates. Try again later.');
      }
    },
  };
}
export type UpdatesService = ReturnType<typeof createUpdatesService>;
