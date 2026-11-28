import { dedupeKey, normalizeCompany } from '@shared/jobs/dedupe';
import { FrontMatterSchema } from '@shared/profile';
import { fold, hardFilter, matchesQuery } from '@shared/discovery/filters';
import type {
  NormalizedJob,
  ScanOutcome,
  SearchProfile,
  SearchProfileInput,
} from '@shared/discovery/schemas';
import { isNearDuplicate, simhash } from '@shared/discovery/simhash';
import { seedSearchProfile } from '@shared/discovery/seed';
import { aiFailureMessage } from '../../ai/failure';
import type { ClaudeRunner } from '../../ai/runner';
import { parseJd } from '../../ai/tasks/jdParse';
import { searchTheWeb } from '../../ai/tasks/discoveryTasks';
import type { Db } from '../../db/database';
import { setAiRunRelated } from '../../db/repos/aiRuns';
import {
  acquireScanLock,
  STALE_LOCK_MS,
  addJobSource,
  allCompanies,
  analysisCandidates,
  finishScanRun,
  findJobBySource,
  insertSearchProfile,
  rescoreCandidates,
  scanIsRunning,
  type RescoreScope,
  jobsOfCompanies,
  listSearchProfiles,
  markClosed,
  staleOpenJobs,
  touchJob,
  untriagedInboxIds,
  updateJobFields,
  type ScanRunRow,
  type SearchProfileRow,
} from '../../db/repos/discovery';
import { createJob, findJobByDedupeKey, findJobByHash, getJob, type NewJobSource } from '../../db/repos/jobs';
import { recomputeSkillDemand } from '../../db/repos/skills';
import { UserError } from '../../ipc/dispatch';
import type { Logger } from '../../platform/logger';
import type { ProfileService } from '../profile/service';
import type { AiSettingsService } from '../settings/ai';
import { hashText, type Intake } from '../jobs/intake';
import { FetchError, guardedFetch, httpUrlOrNull, type Fetcher } from '../jobs/net';
import type { JobsService } from '../jobs/service';
import { adzuna } from './sources/adzuna';
import { ba } from './sources/ba';
import { triageByIds } from './triage';
import { himalayas, arbeitnow, remoteok, remotive } from './sources/boards';
import {
  createGetJson,
  createLimiter,
  SourceError,
  type SourceAdapter,
  type SourceCtx,
} from './sources/http';
import { createWatchlistAdapter } from './sources/watchlist';
import type { KeyStore } from './keystore';
import type { DiscoveryState } from './state';
import type { WatchEntry } from '@shared/discovery/schemas';

const PER_PROFILE_LIMIT = 100;
const DETAIL_BUDGET = 30;
const CLOSED_CHECKS = 25;
const MAX_ERRORS = 5;
const WEBSEARCH_LIMIT = 20;

type PerSource = NonNullable<ScanRunRow['perSourceJson']>;
type Rec = PerSource[string];

export interface ScanDeps {
  db: Db;
  runner: ClaudeRunner;
  settings: AiSettingsService;
  profile: ProfileService;
  jobs: JobsService;
  intake: Intake;
  keys: KeyStore;
  state: DiscoveryState;
  watch: () => WatchEntry[];
  logger: Logger;
  fetcher?: Fetcher;
  adapters?: SourceAdapter[];
  /** Tests: skip the per-source rate limit waits. */
  noRateLimit?: boolean;
  notify?: (n: { title: string; body: string }) => void;
  now?: () => Date;
}

export interface ScanOptions {
  trigger: ScanRunRow['trigger'];
  signal?: AbortSignal;
  onProgress?: (p: { source: string; fetched: number; new: number }) => void;
}

const day = (d: Date): string => d.toISOString().slice(0, 10);
const toProfile = (r: SearchProfileRow): SearchProfile => ({
  id: r.id,
  name: r.name,
  roles: r.roles,
  keywords: r.keywords,
  excludeKeywords: r.excludeKeywords,
  locations: r.locations,
  remoteOk: r.remoteOk,
  countries: r.countries,
  seniority: r.seniority as SearchProfile['seniority'],
  salaryFloor: r.salaryFloor,
  currency: r.currency,
  languages: r.languages,
  excludedCompanies: r.excludedCompanies,
  enabled: r.enabled,
  kind: r.kind,
  maxHoursPerWeek: r.maxHoursPerWeek,
  minHourlyPay: r.minHourlyPay,
});

/** A page that answered 404/410, or sent us to a different page that no longer names the posting. */
export function postingIsClosed(original: string, res: { status: number; finalUrl: string }): boolean {
  if (res.status === 404 || res.status === 410) return true;
  if (res.status < 200 || res.status >= 300) return false;
  const strip = (u: string): string => {
    const x = new URL(u);
    return `${x.hostname}${x.pathname.replace(/\/+$/, '')}`;
  };
  try {
    if (strip(original) === strip(res.finalUrl)) return false;
    const last = new URL(original).pathname.split('/').filter(Boolean).at(-1) ?? '';
    // A canonical redirect keeps the id or slug; a redirect to the listing does not.
    return last.length < 3 || !res.finalUrl.includes(last);
  } catch {
    return false;
  }
}

export function describeSearchProfile(p: SearchProfile): string {
  const line = (k: string, v: string[]): string | null => (v.length > 0 ? `${k}: ${v.join(', ')}` : null);
  return [
    line('roles', p.roles),
    line('keywords', p.keywords),
    line('locations', [...p.locations, ...p.countries]),
    `remote: ${p.remoteOk ? 'welcome' : 'not wanted'}`,
    line('seniority', p.seniority),
    line('excluded companies', p.excludedCompanies),
    line('excluded keywords', p.excludeKeywords),
  ]
    .filter(Boolean)
    .join('\n');
}

export function createScanService(deps: ScanDeps) {
  const { db, runner, settings, state, logger } = deps;
  const clock = deps.now ?? (() => new Date());
  const fetcher = deps.fetcher ?? guardedFetch;
  const adapters: SourceAdapter[] = deps.adapters ?? [
    adzuna,
    arbeitnow,
    ba,
    remotive,
    remoteok,
    himalayas,
    createWatchlistAdapter(deps.watch),
  ];

  /** Search profiles; on the first scan, one is made from the profile's preferences (docs/05, docs/13). */
  async function ensureProfiles(): Promise<SearchProfile[]> {
    let rows = listSearchProfiles(db);
    if (rows.length === 0) {
      let seed: SearchProfileInput;
      try {
        seed = seedSearchProfile((await deps.profile.get()).model.frontMatter);
      } catch {
        seed = seedSearchProfile(FrontMatterSchema.parse({}));
      }
      insertSearchProfile(db, seed);
      rows = listSearchProfiles(db);
    }
    return rows.map(toProfile).filter((p) => p.enabled);
  }

  let rescoring = false;

  /**
   * Re-score from the Inbox: triages the open jobs of `scope` again (or one job), without fetching anything.
   * Never beside a scan: a running scan refuses it, and a scan started meanwhile waits its turn (refused).
   */
  async function rescore(
    req: { scope: RescoreScope | 'job'; jobId?: string; sideJob?: boolean },
    signal?: AbortSignal,
    onProgress?: (done: number, total: number) => void,
  ): Promise<{ total: number; scored: number; error: string | null }> {
    if (rescoring) throw new UserError('Re-scoring is already running.');
    if (scanIsRunning(db, clock())) throw new UserError('A scan is running. Re-score when it has finished.');
    rescoring = true;
    try {
      await ensureProfiles(); // the first run seeds a search profile, as a scan would
      const hash = (await deps.profile.get()).hash;
      const ids =
        req.scope === 'job'
          ? req.jobId && getJob(db, req.jobId)
            ? [req.jobId]
            : []
          : rescoreCandidates(db, req.scope, hash, req.sideJob);
      if (req.scope === 'job' && ids.length === 0) throw new UserError('That job no longer exists.');
      const r = await triageByIds(deps, ids, signal, onProgress);
      return {
        total: ids.length,
        scored: r.scores.size,
        error: r.errors[0]?.replace(/^triage: /, '') ?? null,
      };
    } finally {
      rescoring = false;
    }
  }

  /** How many jobs each Re-score choice would score, for the menu. */
  async function rescoreCounts(sideJob?: boolean): Promise<Record<RescoreScope, number>> {
    const hash = (await deps.profile.get()).hash;
    const n = (s: RescoreScope): number => rescoreCandidates(db, s, hash, sideJob).length;
    return { unscored: n('unscored'), all: n('all'), stale: n('stale') };
  }

  async function run(opts: ScanOptions): Promise<ScanOutcome> {
    if (rescoring) throw new UserError('Re-scoring is running. Scan when it has finished.');
    const started = clock();
    const lock = acquireScanLock(db, opts.trigger, started, STALE_LOCK_MS);
    if (!lock) throw new UserError('A scan is already running.');
    const signal = opts.signal ?? new AbortController().signal;
    // a function: TypeScript would otherwise assume the flag never changes across awaits
    const aborted = (): boolean => signal.aborted;
    const cfg = state.settings();
    const perSource: PerSource = {};
    const newIds: string[] = [];
    const scores = new Map<string, number>();
    const pipelineErrors: string[] = [];
    let fatal: string | null = null;
    const ai = { blocked: false };
    const blocked = (): boolean => ai.blocked;

    const addError = (rec: Rec, msg: string): void => {
      if (rec.errors.length < MAX_ERRORS && !rec.errors.includes(msg)) rec.errors.push(msg);
    };
    const pipelineError = (msg: string): void => {
      if (pipelineErrors.length < MAX_ERRORS && !pipelineErrors.includes(msg)) pipelineErrors.push(msg);
    };

    // ---- dedupe helpers -------------------------------------------------------------------------------
    const hashes = new Map<string, string | null>();
    const simOf = (id: string, text: string): string | null => {
      if (!hashes.has(id)) hashes.set(id, simhash(text));
      return hashes.get(id) ?? null;
    };
    let byCompany: Map<string, string[]> | undefined;
    const companyIds = (name: string): string[] => {
      if (!byCompany) {
        byCompany = new Map();
        for (const c of allCompanies(db)) {
          const k = normalizeCompany(c.name);
          byCompany.set(k, [...(byCompany.get(k) ?? []), c.id]);
        }
      }
      return byCompany.get(normalizeCompany(name)) ?? [];
    };

    function findDuplicate(n: NormalizedJob, key: string, hash: string | null) {
      const byKey = findJobByDedupeKey(db, key);
      if (byKey) return byKey;
      if (hash) {
        const byHash = findJobByHash(db, hash);
        if (byHash) return byHash;
      }
      const sh = simhash(n.descriptionMd);
      if (!sh) return undefined;
      return jobsOfCompanies(db, companyIds(n.company)).find((j) =>
        isNearDuplicate(sh, simOf(j.id, j.descriptionMd)),
      );
    }

    function ingest(n: NormalizedJob, rec: Rec, against: SearchProfile[], queryless: boolean): void {
      const now = clock();
      const known = findJobBySource(db, n.source, n.externalId);
      if (known) {
        touchJob(db, known.id, now);
        return;
      }
      const fitting = against.filter(
        (p) =>
          (!queryless || matchesQuery(n, p)) &&
          hardFilter(n, p, { now, maxAgeDays: cfg.maxAgeDays }) === null,
      );
      // A job any career profile wants is a career job; only side-job profiles' finds are side jobs.
      const sideJob = fitting.every((p) => p.kind === 'side');
      if (fitting.length === 0) {
        rec.filtered = (rec.filtered ?? 0) + 1;
        return;
      }
      const hash = n.descriptionMd.length >= 200 ? hashText(n.descriptionMd) : null;
      const key =
        dedupeKey({ company: n.company, title: n.title, city: n.city, remote: n.remote }) +
        (n.company === 'Unknown company' ? `|${hash ?? n.externalId}` : '');
      const dup = findDuplicate(n, key, hash);
      const src = { source: n.source, externalId: n.externalId, url: httpUrlOrNull(n.url) };
      if (dup) {
        addJobSource(db, dup.id, src);
        touchJob(db, dup.id, now);
        if (dup.sideJob && !sideJob) updateJobFields(db, dup.id, { sideJob: false });
        rec.merged = (rec.merged ?? 0) + 1;
        return;
      }
      const job = createJob(
        db,
        n.company,
        {
          title: n.title,
          locationText: n.locationText,
          country: n.country,
          remote: n.remote,
          employmentType: n.employmentType,
          seniority: n.seniority,
          salaryMin: n.salaryMin,
          salaryMax: n.salaryMax,
          salaryCurrency: n.salaryCurrency,
          salaryPeriod: n.salaryPeriod,
          url: httpUrlOrNull(n.url),
          applyUrl: httpUrlOrNull(n.applyUrl) ?? httpUrlOrNull(n.url),
          postedAt: n.postedAt,
          descriptionMd: n.descriptionMd,
          descriptionHash: hash,
          dedupeKey: key,
          firstSeenAt: now.toISOString(),
          lastSeenAt: now.toISOString(),
          sideJob,
        },
        { ...src, source: n.source as NewJobSource['source'], rawJson: null },
      );
      byCompany?.set(normalizeCompany(n.company), [
        ...new Set([...(byCompany.get(normalizeCompany(n.company)) ?? []), job.companyId]),
      ]);
      newIds.push(job.id);
      rec.new++;
    }

    // ---- one source -----------------------------------------------------------------------------------
    async function runSource(adapter: SourceAdapter, profiles: SearchProfile[]): Promise<void> {
      const secret = adapter.needsKey ? (deps.keys.get('adzuna') ?? undefined) : undefined;
      if (adapter.needsKey && !secret) return; // no key: switched on but idle, shown in Settings
      const targets = profiles.filter((p) => adapter.applies(p)).slice(0, adapter.perProfile ? undefined : 1);
      if (targets.length === 0 || !targets[0]) return;
      const rec: Rec = { fetched: 0, new: 0, errors: [], filtered: 0, merged: 0 };
      perSource[adapter.id] = rec;
      const limiter = deps.noRateLimit ? () => Promise.resolve() : createLimiter(adapter.rateLimit);
      const sourceState = state.source(adapter.id);
      const floor = new Date(started.getTime() - cfg.maxAgeDays * 86_400_000);
      const since =
        sourceState.lastSuccessAt && new Date(sourceState.lastSuccessAt) > floor
          ? new Date(sourceState.lastSuccessAt)
          : floor;
      const detailBudget = { left: DETAIL_BUDGET };
      const secrets = secret ? [secret.appId, secret.appKey] : [];
      const redact = (m: string): string => secrets.reduce((s, x) => s.split(x).join('***'), m);
      let lastProgress = 0;
      const progress = (): void =>
        opts.onProgress?.({ source: adapter.id, fetched: rec.fetched, new: rec.new });

      for (const target of targets) {
        if (aborted()) break;
        const ctx: SourceCtx = {
          profile: target,
          since,
          signal,
          getJson: createGetJson({ fetcher, limiter, signal }),
          limit: PER_PROFILE_LIMIT * (adapter.perProfile ? 1 : 5),
          isKnown: (id) => findJobBySourceAny(adapter, id),
          detailBudget,
          secret,
        };
        try {
          for await (const raw of adapter.search(ctx)) {
            if (aborted()) break;
            let n: NormalizedJob;
            try {
              n = adapter.normalize(raw);
            } catch {
              addError(rec, 'Some postings had an unexpected shape and were skipped.');
              continue;
            }
            rec.fetched++;
            ingest(n, rec, adapter.perProfile ? [target] : profiles, adapter.queryless);
            if (rec.fetched - lastProgress >= 25) {
              lastProgress = rec.fetched;
              progress();
            }
          }
        } catch (e) {
          if (!aborted()) addError(rec, redact(e instanceof SourceError ? e.message : 'The source failed.'));
          if (!(e instanceof SourceError))
            logger.warn('discovery.source_failed', { source: adapter.id, error: String(e) });
        }
      }
      progress();
      const at = clock().toISOString();
      state.patchSource(adapter.id, {
        lastRunAt: at,
        ...(rec.errors.length === 0 ? { lastSuccessAt: at, lastError: null } : { lastError: rec.errors[0] }),
      });
    }
    const findJobBySourceAny = (adapter: SourceAdapter, externalId: string): boolean => {
      const sources =
        adapter.id === 'watchlist'
          ? (['greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workable'] as const)
          : [adapter.id];
      return sources.some((s) => findJobBySource(db, s, externalId) !== undefined);
    };

    // ---- web search agent -----------------------------------------------------------------------------
    async function runWebSearch(profiles: SearchProfile[]): Promise<void> {
      const today = day(started);
      const rec: Rec = { fetched: 0, new: 0, errors: [], filtered: 0, merged: 0 };
      for (const p of profiles) {
        if (aborted() || blocked()) break;
        if (state.webSearchDay(p.id) === today) continue; // once a day per search profile
        perSource.websearch = rec;
        const res = await searchTheWeb(runner, {
          profileText: describeSearchProfile(p),
          limit: WEBSEARCH_LIMIT,
          today,
          config: settings.forTask('discovery.websearch'),
          signal,
        });
        if (!res.ok) {
          if (res.status === 'usage_limit') ai.blocked = true;
          addError(rec, aiFailureMessage(res.status, res.error));
          continue;
        }
        state.setWebSearchDay(p.id, today);
        const seen = new Set<string>();
        for (const r of res.data.results) {
          const url = httpUrlOrNull(r.url);
          if (!url || !url.startsWith('https://') || seen.has(url) || seen.size >= WEBSEARCH_LIMIT) continue;
          seen.add(url);
          rec.fetched++;
          const text = fold(`${r.title} ${r.company} ${r.snippet}`);
          if (
            p.excludedCompanies.some((c) => c.trim() && fold(r.company).includes(fold(c))) ||
            p.excludeKeywords.some((k) => k.trim() && text.includes(fold(k)))
          ) {
            rec.filtered = (rec.filtered ?? 0) + 1;
            continue;
          }
          try {
            const out = await deps.intake.intakeUrl(url, signal, 'websearch');
            if (out.status === 'needs_text') rec.filtered = (rec.filtered ?? 0) + 1;
            else if (out.duplicate) rec.merged = (rec.merged ?? 0) + 1;
            else {
              if (p.kind === 'side') updateJobFields(db, out.jobId, { sideJob: true });
              newIds.push(out.jobId);
              rec.new++;
            }
          } catch (e) {
            if (aborted()) return;
            // a dead link or a page that would not parse is normal for web results
            rec.filtered = (rec.filtered ?? 0) + 1;
            logger.info('discovery.websearch_item_skipped', {
              reason: e instanceof Error ? e.message : String(e),
            });
          }
        }
      }
      if (perSource.websearch) {
        const at = clock().toISOString();
        state.patchSource('websearch', {
          lastRunAt: at,
          ...(rec.errors.length === 0
            ? { lastSuccessAt: at, lastError: null }
            : { lastError: rec.errors[0] }),
        });
        opts.onProgress?.({ source: 'websearch', fetched: rec.fetched, new: rec.new });
      }
    }

    // ---- jd.parse for new jobs without structure -------------------------------------------------------
    async function parseNew(): Promise<void> {
      const todo = newIds
        .map((id) => getJob(db, id))
        .filter((j) => j && j.structuredJson === null && j.descriptionMd.trim().length >= 50)
        .slice(0, cfg.maxParsePerScan);
      const width = settings.get().concurrency;
      for (let i = 0; i < todo.length && !aborted() && !blocked(); i += width)
        await Promise.all(
          todo.slice(i, i + width).map(async (job) => {
            if (!job) return;
            const res = await parseJd(runner, {
              text: job.descriptionMd,
              config: settings.forTask('jd.parse'),
              signal,
              priority: 'background',
            });
            if (!res.ok) {
              if (res.status === 'usage_limit') ai.blocked = true;
              pipelineError(`jd.parse: ${aiFailureMessage(res.status, res.error)}`);
              return;
            }
            setAiRunRelated(db, res.runId, 'job', job.id);
            const jd = res.data;
            updateJobFields(db, job.id, {
              structuredJson: jd,
              employmentType: job.employmentType ?? jd.employment_type,
              seniority: job.seniority ?? jd.seniority,
              language: job.language ?? jd.language,
              country: job.country ?? jd.location.country,
              deadlineAt: job.deadlineAt ?? jd.deadline,
              ...(job.salaryMin === null && job.salaryMax === null && jd.salary
                ? {
                    salaryMin: jd.salary.min,
                    salaryMax: jd.salary.max,
                    salaryCurrency: jd.salary.currency,
                    salaryPeriod: jd.salary.period,
                  }
                : {}),
              ...(job.remote === 'unknown' ? { remote: jd.location.remote } : {}),
            });
          }),
        );
    }

    // ---- triage: new jobs plus open jobs an earlier scan could not score ------------------------------
    async function triage(): Promise<void> {
      if (blocked()) return;
      const since = new Date(started.getTime() - cfg.maxAgeDays * 86_400_000);
      const ids = [...new Set([...newIds, ...untriagedInboxIds(db, since, 60)])];
      const r = await triageByIds(deps, ids, signal);
      for (const [id, score] of r.scores) if (!scores.has(id)) scores.set(id, score);
      for (const m of r.errors) pipelineError(m);
      if (r.blocked) ai.blocked = true;
    }

    // ---- full analysis for strong matches (daily cap) ------------------------------------------------
    async function analyzeStrong(): Promise<void> {
      const today = day(started);
      const left = Math.max(0, cfg.maxAnalyzePerDay - state.analyzedToday(today));
      if (left === 0 || blocked()) return;
      for (const c of analysisCandidates(db, cfg.analyzeThreshold, left)) {
        if (aborted() || blocked()) return;
        try {
          await deps.jobs.analyze(c.jobId, signal);
          state.bumpAnalyzed(today);
        } catch (e) {
          if (aborted()) return;
          pipelineError(`analysis: ${e instanceof UserError ? e.message : 'failed'}`);
          if (e instanceof UserError && /profile (has no skills|still has)/i.test(e.message)) return; // same for every job
        }
      }
    }

    // ---- closed detection -----------------------------------------------------------------------------
    async function detectClosed(): Promise<void> {
      const cutoff = new Date(started.getTime() - 7 * 86_400_000);
      for (const j of staleOpenJobs(db, cutoff, CLOSED_CHECKS)) {
        if (aborted() || !j.url) return;
        try {
          if (postingIsClosed(j.url, await fetcher(j.url, { signal }))) markClosed(db, j.id, clock());
        } catch (e) {
          if (!(e instanceof FetchError)) logger.warn('discovery.closed_check_failed', { error: String(e) });
          // unreachable is not closed: try again next scan
        }
      }
    }

    // ---- the scan -------------------------------------------------------------------------------------
    try {
      const profiles = await ensureProfiles();
      if (profiles.length === 0) throw new UserError('No search profile is enabled.');
      const enabled = adapters.filter((a) => state.enabled(a.id));
      await Promise.all(
        enabled.map((a) =>
          runSource(a, profiles).catch((e: unknown) => {
            perSource[a.id] ??= { fetched: 0, new: 0, errors: [] };
            addError(perSource[a.id] as Rec, 'The source failed.');
            logger.error('discovery.source_crashed', { source: a.id, error: String(e) });
          }),
        ),
      );
      if (state.enabled('websearch') && !aborted()) await runWebSearch(profiles);
      await parseNew();
      await triage();
      await analyzeStrong();
      try {
        recomputeSkillDemand(db, clock());
      } catch (e) {
        pipelineError('skill demand could not be recomputed.');
        logger.warn('discovery.demand_failed', { error: String(e) });
      }
      await detectClosed();
      if (aborted()) fatal = 'cancelled';
    } catch (e) {
      fatal = e instanceof UserError ? e.message : 'The scan failed. Details are in the log.';
      if (!(e instanceof UserError))
        logger.error('discovery.scan_failed', {
          error: e instanceof Error ? (e.stack ?? e.message) : String(e),
        });
    }

    if (pipelineErrors.length > 0) perSource.pipeline = { fetched: 0, new: 0, errors: pipelineErrors };
    const sourceRuns = Object.entries(perSource).filter(([k]) => k !== 'pipeline');
    const failed = sourceRuns.filter(([, r]) => r.errors.length > 0).length;
    const status: ScanRunRow['status'] = fatal
      ? 'error'
      : sourceRuns.length > 0 && failed === sourceRuns.length
        ? 'error'
        : failed > 0 || pipelineErrors.length > 0
          ? 'partial'
          : 'ok';
    const row = finishScanRun(
      db,
      lock.id,
      { status, perSource, newJobs: newIds.length, error: fatal },
      clock(),
    );
    const strong = newIds.filter((id) => (scores.get(id) ?? -1) >= cfg.analyzeThreshold).length;
    if (opts.trigger !== 'manual' && status !== 'error')
      deps.notify?.({
        title: 'Stellio',
        body: `${String(newIds.length)} new matches, ${String(strong)} strong`,
      });
    return {
      run: {
        id: row.id,
        startedAt: row.startedAt,
        finishedAt: row.finishedAt,
        trigger: row.trigger,
        status: row.status,
        newJobs: row.newJobs,
        perSource: row.perSourceJson ?? {},
        error: row.error,
      },
      strong,
    };
  }

  return { run, ensureProfiles, rescore, rescoreCounts };
}
export type ScanService = ReturnType<typeof createScanService>;
