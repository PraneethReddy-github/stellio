import { z } from 'zod';
import {
  DEFAULT_UPDATE_SETTINGS,
  isNewer,
  UpdateSettingsSchema,
  type UpdateProgress,
  type UpdateSettings,
  type UpdateStatus,
} from '@shared/settings/updates';
import type { Db } from '../../db/database';
import { getSetting, setSetting } from '../../db/repos/settings';
import { UserError } from '../../ipc/dispatch';
import type { Logger } from '../../platform/logger';
import { assetName, downloadAndInstall, type Download, type InstallKind, type RunProgram } from './install';

const KEY = 'updates.settings';
const DAY_MS = 24 * 60 * 60_000;
const TIMEOUT_MS = 8_000;
const MAX_SIZE = 500_000_000;
const REPO = 'PraneethReddy-github/stellio';
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases?per_page=30`;
const DOWNLOADS = `https://github.com/${REPO}/releases/download`;

const Release = z.object({
  tag_name: z.string(),
  draft: z.boolean(),
  prerelease: z.boolean(),
  body: z.string().nullish(),
  assets: z.array(
    z.object({ name: z.string(), size: z.number().int().nonnegative(), digest: z.string().nullish() }),
  ),
});
const TAG = /^v(\d+\.\d+\.\d+)$/;
const DIGEST = /^sha256:([0-9a-f]{64})$/;

export interface UpdatesDeps {
  db: Db;
  logger: Logger;
  current: string;
  /** False in dev and e2e runs: no unasked request. */
  autoAllowed: boolean;
  install: InstallKind;
  /** Private folder a .deb is downloaded to. */
  workDir: string;
  /** Where releases are listed and files are fetched; tests point them elsewhere. */
  apiUrl?: string;
  downloadsUrl?: string;
  fetchFn?: typeof fetch;
  runProgram?: RunProgram;
  now?: () => number;
}

/**
 * Compares this version with the GitHub releases and, when the user asks, downloads the matching file, checks its
 * published SHA-256 and installs it. Requests carry nothing about the user.
 */
export function createUpdatesService(deps: UpdatesDeps) {
  const { db, logger, current, autoAllowed, install, workDir, fetchFn = fetch, now = Date.now } = deps;
  const { apiUrl = RELEASES_API, downloadsUrl = DOWNLOADS } = deps;
  let status: UpdateStatus = { current, available: null, installed: null };
  let download: Download | null = null;
  let checkedAt: number | null = null;
  let inFlight: Promise<UpdateStatus> | null = null;
  let installing: AbortController | null = null;
  let installPhase: UpdateProgress['phase'] | null = null;

  async function request(): Promise<UpdateStatus> {
    checkedAt = now(); // a failed check also waits a day before the next automatic one
    const res = await fetchFn(apiUrl, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Stellio' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`GitHub answered ${String(res.status)}`);
    const newer = z
      .array(Release)
      .parse(await res.json())
      .filter((r) => !r.draft && !r.prerelease)
      .map((r) => ({ ...r, version: TAG.exec(r.tag_name)?.[1] ?? '' }))
      .filter((r) => isNewer(r.version, current))
      .sort((a, b) => (isNewer(a.version, b.version) ? -1 : 1));
    const top = newer[0];
    if (!top) {
      download = null;
      status = { ...status, available: null };
      return status;
    }
    const name = assetName(install.kind, top.version);
    const asset = top.assets.find((a) => a.name === name);
    const sha256 = DIGEST.exec(asset?.digest ?? '')?.[1];
    // Links are built here, never taken from the answer.
    download =
      name && asset && sha256 && asset.size > 0 && asset.size <= MAX_SIZE
        ? { url: `${downloadsUrl}/v${top.version}/${name}`, sha256, size: asset.size }
        : null;
    status = {
      ...status,
      available: {
        version: top.version,
        url: `https://github.com/${REPO}/releases/tag/v${top.version}`,
        notes: newer.map((r) => ({ version: r.version, body: (r.body ?? '').slice(0, 20_000) })),
        installable: download !== null,
        size: download?.size ?? null,
      },
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
    /** Downloads, verifies and installs the version the user was shown. The running app is unchanged until a restart. */
    async install(version: string, onProgress: (p: UpdateProgress) => void): Promise<UpdateStatus> {
      if (installing) throw new UserError('An update is already being installed.');
      if (status.installed === version) return status;
      const target = download;
      if (!target || status.available?.version !== version)
        throw new UserError('That update is no longer offered. Check for updates again.');
      installing = new AbortController();
      logger.info('updates.install_start', { version, kind: install.kind });
      try {
        await downloadAndInstall(
          { install, download: target, version, workDir, runProgram: deps.runProgram },
          {
            fetchFn,
            signal: installing.signal,
            onProgress: (p) => {
              installPhase = p.phase;
              onProgress(p);
            },
          },
        );
        logger.info('updates.installed', { version });
        status = { ...status, installed: version };
        return status;
      } catch (e) {
        logger.warn('updates.install_failed', { error: e instanceof Error ? e.message : String(e) });
        throw e;
      } finally {
        installing = null;
        installPhase = null;
      }
    },
    /** Stops a download. Once the package manager runs it is left alone. */
    cancel(): boolean {
      if (!installing || installPhase === 'install') return false;
      installing.abort();
      return true;
    },
    /** True while the package manager or file swap runs: quitting now is a bad idea. */
    restartAllowed: (): boolean => installing === null && status.installed !== null,
  };
}
export type UpdatesService = ReturnType<typeof createUpdatesService>;
