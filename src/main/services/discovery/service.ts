import { homedir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { fold, yearlyMax } from '@shared/discovery/filters';
import { rank } from '@shared/discovery/ranking';
import {
  DISCOVERY_SOURCES,
  type DiscoverySettings,
  type DiscoverySource,
  type InboxInput,
  type InboxItem,
  type Schedule,
  type ScanRun,
  type SearchProfile,
  type SearchProfileInput,
  type SourceStatus,
  type WatchEntry,
} from '@shared/discovery/schemas';
import { ensureApplication } from '../../db/repos/applications';
import {
  deleteSearchProfile,
  dismissJob,
  inboxRows,
  insertSearchProfile,
  lastScanStart,
  listScanRuns,
  listSearchProfiles,
  listWatched,
  sourcesByJob,
  updateSearchProfile,
} from '../../db/repos/discovery';
import { setJobState, upsertCompanyByName } from '../../db/repos/jobs';
import type { Db } from '../../db/database';
import { companies } from '../../db/schema';
import { UserError } from '../../ipc/dispatch';
import { guardedFetch, httpUrlOrNull, type Fetcher } from '../jobs/net';
import type { JobsService } from '../jobs/service';
import type { KeyStore } from './keystore';
import { createScanService, type ScanDeps, type ScanOptions } from './scan';
import { createScheduler } from './scheduler';
import { detectBoard, detectBoardInHtml, listUrl } from './sources/watchlist';
import type { DiscoveryState } from './state';
import { createTimerService, runSystemctl, type Systemctl } from './systemd';

const LABELS: Record<DiscoverySource, string> = {
  adzuna: 'Adzuna',
  arbeitnow: 'Arbeitnow',
  ba: 'Bundesagentur für Arbeit',
  remotive: 'Remotive',
  remoteok: 'RemoteOK',
  himalayas: 'Himalayas',
  watchlist: 'Company watchlist',
  websearch: 'Web search',
};

export interface DiscoveryDeps extends Omit<ScanDeps, 'watch' | 'intake'> {
  jobs: JobsService;
  state: DiscoveryState;
  keys: KeyStore;
  /** What the systemd timer runs (this app with `--scan`). */
  scanCommand: () => string[];
  /** Tests: where `systemd/user` lives and the `systemctl` to call. */
  configHome?: string;
  systemctl?: Systemctl;
  fetcher?: Fetcher;
  onError?: (e: unknown) => void;
}

const titleCase = (slug: string): string =>
  slug.replace(/[-_.]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

export function createDiscoveryService(deps: DiscoveryDeps) {
  const { db, state, keys } = deps;
  const fetcher = deps.fetcher ?? guardedFetch;
  const watch = (): WatchEntry[] => watchEntries(db);
  const scan = createScanService({ ...deps, intake: deps.jobs, watch });
  const timer = createTimerService({
    configHome: deps.configHome ?? process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'),
    exec: deps.scanCommand,
    systemctl: deps.systemctl ?? runSystemctl,
  });
  const scheduler = createScheduler({
    schedule: state.schedule,
    lastSuccess: () => lastScanStart(db, true),
    lastAttempt: () => lastScanStart(db, false),
    scan: (trigger) => scan.run({ trigger }),
    onError: (e) => deps.onError?.(e),
    now: deps.now,
  });

  const toRun = (r: ReturnType<typeof listScanRuns>[number]): ScanRun => ({
    id: r.id,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    trigger: r.trigger,
    status: r.status,
    newJobs: r.newJobs,
    perSource: r.perSourceJson ?? {},
    error: r.error,
  });

  return {
    scan,
    scheduler,
    timer,
    runScan: (o: ScanOptions) => scan.run(o),

    sources(): SourceStatus[] {
      return DISCOVERY_SOURCES.map((id) => {
        const s = state.source(id);
        return {
          id,
          label: LABELS[id],
          needsKey: id === 'adzuna',
          keySet: id === 'adzuna' && keys.isSet('adzuna'),
          enabled: state.enabled(id),
          lastRunAt: s.lastRunAt ?? null,
          lastSuccessAt: s.lastSuccessAt ?? null,
          lastError: s.lastError ?? null,
        };
      });
    },
    setSourceEnabled: (id: DiscoverySource, enabled: boolean): void => state.patchSource(id, { enabled }),
    setApiKey: (appId: string, appKey: string): void => keys.set('adzuna', { appId, appKey }),
    clearApiKey: (): void => keys.clear('adzuna'),

    profiles: (): SearchProfile[] => listSearchProfiles(db) as SearchProfile[],
    saveProfile(id: string | undefined, v: SearchProfileInput): SearchProfile {
      const row = id ? updateSearchProfile(db, id, v) : insertSearchProfile(db, v);
      if (!row) throw new UserError('That search profile no longer exists.');
      return row as SearchProfile;
    },
    deleteProfile: (id: string): boolean => deleteSearchProfile(db, id),

    watchlist: watch,
    /** Adds a company by careers URL: finds the ATS from the URL, else from links in the page, and checks the board exists. */
    async watchAdd(url: string, name: string | undefined, signal?: AbortSignal): Promise<WatchEntry> {
      const link = httpUrlOrNull(url);
      if (!link) throw new UserError('That is not a web link.');
      let board = detectBoard(link);
      if (!board) {
        try {
          const page = await fetcher(link, { signal });
          board = detectBoardInHtml(page.body);
        } catch (e) {
          throw new UserError(e instanceof Error ? e.message : 'The page could not be loaded.');
        }
      }
      if (!board)
        throw new UserError(
          'No supported job board found there. Supported: Greenhouse, Lever, Ashby, SmartRecruiters, Workable.',
        );
      const probe = await fetcher(listUrl(board.kind, board.slug), {
        signal,
        accept: 'application/json',
        allowedHosts: [new URL(listUrl(board.kind, board.slug)).hostname],
      }).catch(() => null);
      if (!probe || probe.status !== 200)
        throw new UserError(`The ${board.kind} board "${board.slug}" could not be read (it may not exist).`);
      const existing = db.orm
        .select()
        .from(companies)
        .where(eq(companies.atsSlug, board.slug))
        .all()
        .find((c) => c.atsType === board.kind);
      const company = existing ?? upsertCompanyByName(db, name?.trim() || titleCase(board.slug));
      db.orm
        .update(companies)
        .set({
          watch: true,
          atsType: board.kind,
          atsSlug: board.slug,
          careersUrl: link,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(companies.id, company.id))
        .run();
      return (
        watch().find((w) => w.id === company.id) ?? {
          id: company.id,
          company: company.name,
          careersUrl: link,
          atsType: board.kind,
          atsSlug: board.slug,
        }
      );
    },
    watchRemove(id: string): boolean {
      return (
        db.orm
          .update(companies)
          .set({ watch: false, updatedAt: new Date().toISOString() })
          .where(eq(companies.id, id))
          .run().changes > 0
      );
    },

    scanRuns: (limit: number): ScanRun[] => listScanRuns(db, limit).map(toRun),

    schedule: (): Schedule => state.schedule(),
    /** Saves the in-app schedule; an installed systemd timer follows the new time. */
    async setSchedule(v: Schedule): Promise<Schedule> {
      const before = await timer.status();
      const saved = state.setSchedule(v);
      if (before.installed && before.time !== saved.time) await timer.install(saved.time);
      return saved;
    },
    settings: (): DiscoverySettings => state.settings(),
    setSettings: (v: unknown): DiscoverySettings => state.setSettings(v),

    timerPreview: () => timer.preview(state.schedule().time),
    timerInstall: () => timer.install(state.schedule().time),
    timerRemove: () => timer.remove(),
    timerStatus: () => timer.status(),

    inbox(input: InboxInput, now = new Date()): InboxItem[] {
      const cfg = state.settings();
      const enabled = listSearchProfiles(db).filter((p) => p.enabled);
      const floor = enabled.find((p) => p.kind === 'career')?.salaryFloor ?? null;
      // Side jobs are ranked against the hourly floor, as a yearly figure like the salaries it is compared with.
      const hourly = enabled.find((p) => p.kind === 'side' && p.minHourlyPay !== null)?.minHourlyPay ?? null;
      const sideFloor =
        hourly === null ? null : yearlyMax({ salaryMin: hourly, salaryMax: null, salaryPeriod: 'hour' });
      const rows = inboxRows(db);
      const sources = sourcesByJob(
        db,
        rows.map((r) => r.id),
      );
      const { minScore, source, remote, text, sideJob } = input.filters;
      const needle = text ? fold(text) : null;
      // Filter and rank the cheap way over every open job; build the full items only for the page returned.
      const scored = rows.flatMap((r) => {
        const score = r.fit ?? r.triage;
        const srcs = sources.get(r.id) ?? [];
        if (
          (minScore !== undefined && (score ?? -1) < minScore) ||
          (source && !srcs.includes(source)) ||
          (remote && r.remote !== remote) ||
          (sideJob !== undefined && (r.sideJob === 1) !== sideJob) ||
          (needle && !fold(`${r.title} ${r.company}`).includes(needle))
        )
          return [];
        const total = rank(
          {
            score,
            postedAt: r.postedAt,
            firstSeenAt: r.firstSeenAt,
            sources: srcs,
            salaryMin: r.salaryMin,
            salaryMax: r.salaryMax,
            salaryPeriod: r.salaryPeriod,
            salaryFloor: r.sideJob ? sideFloor : floor,
          },
          now,
          cfg,
        );
        return [{ r, score, srcs, rank: total }];
      });
      type Scored = (typeof scored)[number];
      const by = {
        rank: (a: Scored, b: Scored) => b.rank - a.rank,
        recent: (a: Scored, b: Scored) => b.r.firstSeenAt.localeCompare(a.r.firstSeenAt),
        score: (a: Scored, b: Scored) => (b.score ?? -1) - (a.score ?? -1),
      }[input.sort];
      return scored
        .sort((a, b) => by(a, b) || a.r.id.localeCompare(b.r.id))
        .slice(0, input.limit)
        .map(({ r, score, srcs, rank: total }): InboxItem => ({
          jobId: r.id,
          company: r.company,
          title: r.title,
          locationText: r.locationText,
          remote: r.remote,
          salaryText:
            r.salaryMin === null && r.salaryMax === null
              ? null
              : `${[r.salaryMin, r.salaryMax].filter((x) => x !== null).join('-')} ${r.salaryCurrency ?? ''}${r.salaryPeriod ? `/${r.salaryPeriod}` : ''}`.trim(),
          url: r.url,
          postedAt: r.postedAt,
          firstSeenAt: r.firstSeenAt,
          score,
          scoreKind: r.fit !== null ? 'fit' : r.triage !== null ? 'triage' : null,
          reason: r.fit !== null ? r.fitReason : r.triageReason,
          rank: total,
          sources: srcs,
          sideJob: r.sideJob === 1,
        }));
    },

    dismiss(id: string, reason: string): void {
      if (!dismissJob(db, id, reason)) throw new UserError('That job no longer exists.');
    },
    /** Shortlisting makes it an application (docs/08 §1). */
    shortlist(id: string): { applicationId: string } {
      if (!setJobState(db, id, 'shortlisted')) throw new UserError('That job no longer exists.');
      return { applicationId: ensureApplication(db, id, 'shortlisted').app.id };
    },
  };
}
export type DiscoveryService = ReturnType<typeof createDiscoveryService>;

function watchEntries(db: Db): WatchEntry[] {
  return listWatched(db).map((c) => ({
    id: c.id,
    company: c.name,
    careersUrl: c.careersUrl,
    atsType: c.atsType,
    atsSlug: c.atsSlug,
  }));
}
