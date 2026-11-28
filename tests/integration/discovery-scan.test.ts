import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SearchProfileInput } from '../../src/shared/discovery/schemas';
import { createClaudeRunner } from '../../src/main/ai/runner';
import { createDbRecorder } from '../../src/main/services/ai/recorder';
import { acquireScanLock } from '../../src/main/db/repos/discovery';
import { createJob } from '../../src/main/db/repos/jobs';
import { computeToday } from '../../src/main/services/tracker/today';
import { createDiscoveryService } from '../../src/main/services/discovery/service';
import { createKeyStore } from '../../src/main/services/discovery/keystore';
import { createDiscoveryState } from '../../src/main/services/discovery/state';
import { createJobsService } from '../../src/main/services/jobs/service';
import type { Fetcher } from '../../src/main/services/jobs/net';
import { createProfileService } from '../../src/main/services/profile/service';
import { createAiSettings } from '../../src/main/services/settings/ai';
import { sampleAnalysis, sampleJd } from '../fixtures/jobs';
import {
  allSourceRoutes,
  remoteok,
  sourceUrlsEnv,
  startFixtureServer,
  type FixtureServer,
  type Routes,
} from '../fixtures/discovery';
import { freshDb, tempDir } from '../unit/db/helpers';

const FAKE = resolve('tests/fixtures/fake-claude/claude.mjs');
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const read = (rel: string): string => readFileSync(resolve('tests', rel), 'utf8');

let server: FixtureServer;
let routes: Routes;
const saved = { ...process.env };
beforeAll(async () => {
  routes = allSourceRoutes();
  server = await startFixtureServer(routes);
  Object.assign(process.env, sourceUrlsEnv(server.base));
});
afterAll(async () => {
  process.env = saved;
  await server.close();
});

const PROFILE: SearchProfileInput = {
  name: 'Germany + remote',
  roles: ['Data Engineer', 'Analytics Engineer'],
  keywords: [],
  excludeKeywords: [],
  locations: ['Germany'],
  remoteOk: true,
  countries: ['Germany'],
  seniority: [],
  salaryFloor: null,
  currency: null,
  languages: [],
  excludedCompanies: [],
  enabled: true,
  kind: 'career',
  maxHoursPerWeek: null,
  minHourlyPay: null,
};

interface Opts {
  env?: Record<string, string>;
  fetcher?: Fetcher;
  seed?: boolean;
}
function setup({ env = {}, fetcher, seed = false }: Opts = {}) {
  const db = freshDb();
  const dir = tempDir();
  mkdirSync(join(dir, 'profile'), { recursive: true });
  writeFileSync(join(dir, 'profile/praneethreddy.md'), read('fixtures/profiles/full.md'));
  const cap = join(dir, 'capture.ndjson');
  const settings = createAiSettings(db);
  // The runner reads this object at every spawn, so a test can change the fake CLI's behaviour mid-way.
  const runnerEnv: Record<string, string> = {
    FAKE_CLAUDE_MODE: 'ok',
    FAKE_CLAUDE_OUTPUT_JD_PARSE: JSON.stringify(sampleJd),
    FAKE_CLAUDE_OUTPUT_JOB_ANALYZE: JSON.stringify(sampleAnalysis),
    FAKE_CLAUDE_CAPTURE: cap,
    ...env,
  };
  const runner = createClaudeRunner({
    bin: FAKE,
    cwd: join(dir, 'cwd'),
    logger,
    recorder: createDbRecorder(db, vi.fn()),
    retryDelayMs: 1,
    env: runnerEnv,
  });
  const profile = createProfileService({
    dataDir: dir,
    gitAvailable: false,
    runner,
    importConfig: () => settings.forTask('profile.import'),
  });
  const jobs = createJobsService({ db, runner, settings, profile, fetcher });
  const state = createDiscoveryState(db);
  const keys = createKeyStore(join(dir, 'secrets'), {
    isEncryptionAvailable: () => true,
    encryptString: (p) => Buffer.from(p).reverse(),
    decryptString: (c) => Buffer.from(c).reverse().toString(),
  });
  keys.set('adzuna', { appId: 'app12345', appKey: 'key-1234567890' });
  const notify = vi.fn();
  const discovery = createDiscoveryService({
    db,
    runner,
    settings,
    profile,
    jobs,
    logger,
    state,
    keys,
    notify,
    noRateLimit: true,
    scanCommand: () => ['/x/stellio', '--scan'],
    configHome: join(dir, 'config'),
  });
  if (!seed) discovery.saveProfile(undefined, PROFILE);
  const calls = (): { argv: string[]; stdin: string }[] => {
    try {
      return readFileSync(cap, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { kind: string; argv: string[]; stdin: string })
        .filter((r) => r.kind === 'call');
    } catch {
      return [];
    }
  };
  const task = (name: string) =>
    calls().filter((c) => {
      const schema = JSON.parse(c.argv[c.argv.indexOf('--json-schema') + 1] ?? '{}') as {
        properties?: Record<string, unknown>;
      };
      const keysOf = Object.keys(schema.properties ?? {});
      return (
        (name === 'triage' && keysOf.includes('scores')) ||
        (name === 'parse' && keysOf.includes('responsibilities')) ||
        (name === 'analyze' && keysOf.includes('fit_score')) ||
        (name === 'websearch' && keysOf.includes('results'))
      );
    });
  return { db, dir, discovery, jobs, state, keys, notify, calls, task, settings, env: runnerEnv };
}

const scoreEnv = { FAKE_CLAUDE_TRIAGE_SCORES: JSON.stringify({ 'Spree Daten': 90, 'Havel Analytik': 50 }) };

describe('full scan over local fixture servers', () => {
  it('fetches every source, filters, merges duplicates, triages, analyzes within caps and recomputes demand', async () => {
    const t = setup({ env: scoreEnv });
    t.discovery.setSettings({ ...t.discovery.settings(), maxParsePerScan: 3, maxAnalyzePerDay: 2 });
    for (const [url, name] of [
      ['https://boards.greenhouse.io/acme', 'Acme Corp'],
      ['https://jobs.lever.co/acme', 'Acme Labs'],
    ] as const)
      await t.discovery.watchAdd(url, name);
    expect(t.discovery.watchlist()).toHaveLength(2);

    const { run, strong } = await t.discovery.runScan({ trigger: 'schedule' });

    expect(run.status).toBe('ok');
    expect(run.error).toBeNull();
    const ps = run.perSource;
    expect(ps.arbeitnow).toMatchObject({ new: 1, errors: [] });
    expect(ps.arbeitnow?.filtered).toBe(2); // marketing + python developer fail the role check; the 90-day-old one is never read
    expect(ps.remotive).toMatchObject({ new: 1 });
    expect(ps.remotive?.merged).toBe(1); // the Nimbus posting, found by SimHash despite a different text/title/remote flag
    expect(ps.remotive?.filtered).toBeGreaterThanOrEqual(1); // US-only remote
    expect(ps.remoteok).toMatchObject({ new: 1 });
    expect(ps.himalayas).toMatchObject({ new: 1 });
    expect(ps.ba).toMatchObject({ new: 2, errors: [] });
    expect(ps.adzuna).toMatchObject({ new: 2, errors: [] });
    expect(ps.watchlist?.errors).toEqual([]);
    expect(run.newJobs).toBe(Object.values(ps).reduce((n, s) => n + s.new, 0));
    expect(run.newJobs).toBe(9);

    // one job, several sources
    const nimbus = t.db.sqlite
      .prepare(
        `select j.id, group_concat(s.source) as sources from jobs j join job_sources s on s.job_id = j.id
         where j.title like 'Data Engineer (m/w/d)' group by j.id`,
      )
      .get() as { sources: string };
    expect(nimbus.sources.split(',').sort()).toEqual(['arbeitnow', 'remotive']);

    // AI steps: caps, batches, background priority
    expect(t.task('parse')).toHaveLength(3);
    const triage = t.task('triage');
    expect(triage.length).toBe(Math.ceil(run.newJobs / 10));
    for (const c of triage) expect(c.stdin.match(/<job id=/g)?.length ?? 0).toBeLessThanOrEqual(10);
    expect(t.task('analyze')).toHaveLength(2); // maxAnalyzePerDay
    expect(strong).toBe(run.newJobs - 1); // Havel scored 50, the rest 75+
    expect(t.notify).toHaveBeenCalledWith({
      title: 'Stellio',
      body: `${String(run.newJobs)} new matches, ${String(run.newJobs - 1)} strong`,
    });

    // inbox: ranked, triage score and reason, sources; analyzed jobs lead
    const inbox = t.discovery.inbox({ filters: {}, sort: 'rank', limit: 100 });
    expect(inbox).toHaveLength(run.newJobs);
    expect(inbox[0]).toMatchObject({ scoreKind: 'fit', score: 88 });
    expect(inbox.every((i, n) => n === 0 || (inbox[n - 1]?.rank ?? 0) >= i.rank)).toBe(true);
    const spree = inbox.find((i) => i.company === 'Spree Daten GmbH');
    expect(spree).toMatchObject({ sources: ['ba'] });
    expect(spree?.reason).toBeTruthy();
    expect(inbox.find((i) => i.company === 'Havel Analytik AG')).toMatchObject({
      scoreKind: 'triage',
      score: 50,
    });
    expect(t.discovery.inbox({ filters: { minScore: 60 }, sort: 'score', limit: 100 })).toHaveLength(
      run.newJobs - 1,
    );
    expect(t.discovery.inbox({ filters: { source: 'ba' }, sort: 'recent', limit: 100 })).toHaveLength(2);

    // skill demand follows the parsed jobs
    const demand = t.db.sqlite
      .prepare("select job_count from skill_demand where skill = 'Python' and window = 'all'")
      .get() as {
      job_count: number;
    };
    expect(demand.job_count).toBe(3);

    // Today: new matches fall back to the triage score and reason; the last scan is the run above
    const today = computeToday(t.db, new Date(), []);
    expect(today.newMatches).toHaveLength(5);
    expect(today.newMatches.every((m) => m.fit !== null && m.reason !== null)).toBe(true);
    expect(today.newMatches[0]?.fit).toBe(88);
    expect(today.lastScan).toMatchObject({ id: run.id, status: 'ok', newJobs: run.newJobs });

    // source status and the stored run
    const sources = t.discovery.sources();
    expect(sources.find((s) => s.id === 'arbeitnow')).toMatchObject({ enabled: true, lastError: null });
    expect(sources.find((s) => s.id === 'adzuna')).toMatchObject({ keySet: true });
    expect(sources.find((s) => s.id === 'websearch')?.enabled).toBe(false);
    expect(t.discovery.scanRuns(5)[0]?.id).toBe(run.id);
  });

  it('a second scan finds nothing new, and a failing source never fails the scan', async () => {
    const t = setup();
    const first = await t.discovery.runScan({ trigger: 'manual' });
    const parses = t.task('parse').length;
    routes['/api'] = { status: 500 }; // RemoteOK is down
    const second = await t.discovery.runScan({ trigger: 'manual' });
    routes['/api'] = { body: remoteok() };
    expect(second.run.newJobs).toBe(0);
    expect(second.run.status).toBe('partial');
    expect(second.run.perSource.remoteok?.errors).toEqual(['HTTP 500']);
    expect(second.run.perSource.arbeitnow).toMatchObject({ new: 0, errors: [] });
    expect(t.task('parse')).toHaveLength(parses); // nothing new, no extra AI calls
    expect(t.discovery.sources().find((s) => s.id === 'remoteok')).toMatchObject({ lastError: 'HTTP 500' });
    expect(t.discovery.sources().find((s) => s.id === 'arbeitnow')?.lastError).toBeNull();
    expect(first.run.newJobs).toBeGreaterThan(0);
    expect(t.notify).not.toHaveBeenCalled(); // manual scans do not notify
  });

  it('every source failing is an error run; the key never shows up in stored errors', async () => {
    const t = setup();
    const saved404 = { ...routes };
    for (const k of Object.keys(routes)) routes[k] = { status: 403 };
    try {
      const { run } = await t.discovery.runScan({ trigger: 'manual' });
      expect(run.status).toBe('error');
      expect(JSON.stringify(run)).not.toContain('key-1234567890');
      expect(run.perSource.adzuna?.errors).toEqual(['access refused (HTTP 403)']);
    } finally {
      Object.assign(routes, saved404);
    }
  });

  it('seeds the first search profile from the profile preferences when none exists', async () => {
    const t = setup({ seed: true });
    expect(t.discovery.profiles()).toHaveLength(0);
    await t.discovery.runScan({ trigger: 'manual' });
    const [p] = t.discovery.profiles();
    expect(p).toMatchObject({
      roles: ['Data Engineer', 'Analytics Engineer'],
      locations: ['Berlin', 'Remote'],
      seniority: ['mid', 'senior'],
      salaryFloor: 60000,
      currency: 'EUR',
      excludedCompanies: ['Initech'],
      remoteOk: true,
    });
    await t.discovery.runScan({ trigger: 'manual' });
    expect(t.discovery.profiles()).toHaveLength(1);
  });

  it('refuses to run beside another scan (the DB lock), and cancelling ends the run as an error', async () => {
    const t = setup();
    const held = acquireScanLock(t.db, 'schedule', new Date(), 60_000);
    await expect(t.discovery.runScan({ trigger: 'manual' })).rejects.toThrow('A scan is already running.');
    t.db.sqlite.prepare("update scan_runs set status = 'ok' where id = ?").run(held?.id);
    const ctl = new AbortController();
    ctl.abort();
    const { run } = await t.discovery.runScan({ trigger: 'manual', signal: ctl.signal });
    expect(run).toMatchObject({ status: 'error', error: 'cancelled' });
    expect(t.discovery.scanRuns(1)[0]?.finishedAt).not.toBeNull();
  });

  it('detects closed postings: unseen for 7 days and the page is gone', async () => {
    const t = setup();
    routes['/gone'] = { status: 404 };
    routes['/alive'] = { text: '<html><body>still here</body></html>' };
    const old = new Date(Date.now() - 9 * 86_400_000).toISOString();
    const mk = (title: string, path: string) =>
      createJob(t.db, 'Old Co', {
        title,
        url: `${server.base}${path}`,
        dedupeKey: `old co|${title}|`,
        descriptionMd: 'x',
        lastSeenAt: old,
        firstSeenAt: old,
      });
    const gone = mk('Gone', '/gone');
    const alive = mk('Alive', '/alive');
    await t.discovery.runScan({ trigger: 'manual' });
    const closed = (id: string) =>
      (t.db.sqlite.prepare('select closed_at from jobs where id = ?').get(id) as { closed_at: string | null })
        .closed_at;
    expect(closed(gone.id)).not.toBeNull();
    expect(closed(alive.id)).toBeNull();
    // a closed job leaves the inbox
    expect(t.discovery.inbox({ filters: { text: 'Gone' }, sort: 'rank', limit: 10 })).toEqual([]);
  });

  it('dismissed jobs stay dismissed when found again; shortlisting creates the application', async () => {
    const t = setup();
    await t.discovery.runScan({ trigger: 'manual' });
    const [a, b] = t.discovery.inbox({ filters: {}, sort: 'rank', limit: 100 });
    t.discovery.dismiss(a?.jobId ?? '', 'not interested');
    const { applicationId } = t.discovery.shortlist(b?.jobId ?? '');
    expect(applicationId).toBeTruthy();
    const st = t.db.sqlite.prepare('select status from applications where id = ?').get(applicationId) as {
      status: string;
    };
    expect(st.status).toBe('saved');
    const again = await t.discovery.runScan({ trigger: 'manual' });
    expect(again.run.newJobs).toBe(0);
    const ids = t.discovery.inbox({ filters: {}, sort: 'rank', limit: 100 }).map((i) => i.jobId);
    expect(ids).not.toContain(a?.jobId);
    expect(ids).not.toContain(b?.jobId);
    const row = t.db.sqlite.prepare('select state, dismiss_reason from jobs where id = ?').get(a?.jobId) as {
      state: string;
      dismiss_reason: string;
    };
    expect(row).toEqual({ state: 'dismissed', dismiss_reason: 'not interested' });
  });

  it('a failed triage batch is retried by the next scan', async () => {
    const t = setup({ env: { FAKE_CLAUDE_MODE_JOB_TRIAGE: 'auth' } });
    const first = await t.discovery.runScan({ trigger: 'manual' });
    expect(first.run.status).toBe('partial');
    expect(first.run.perSource.pipeline?.errors[0]).toMatch(/^triage:/);
    expect(t.discovery.inbox({ filters: { minScore: 0 }, sort: 'rank', limit: 100 })).toEqual([]);
    // the CLI works again: nothing is new, but the unscored jobs get scored
    t.env.FAKE_CLAUDE_MODE_JOB_TRIAGE = 'ok';
    const second = await t.discovery.runScan({ trigger: 'manual' });
    expect(second.run).toMatchObject({ newJobs: 0, status: 'ok' });
    expect(t.discovery.inbox({ filters: { minScore: 0 }, sort: 'rank', limit: 100 })).toHaveLength(
      first.run.newJobs,
    );
  });
});

describe('re-score from the Inbox', () => {
  it('counts and triages unscored, all, stale and one job; never beside a scan', async () => {
    const t = setup({ env: { ...scoreEnv, FAKE_CLAUDE_MODE_JOB_TRIAGE: 'auth' } });
    const { run } = await t.discovery.runScan({ trigger: 'manual' });
    expect(await t.discovery.rescoreCounts()).toEqual({ unscored: run.newJobs, all: run.newJobs, stale: 0 });
    t.env.FAKE_CLAUDE_MODE_JOB_TRIAGE = 'ok';

    const progress: [number, number][] = [];
    const unscored = await t.discovery.rescore({ scope: 'unscored' }, undefined, (d, n) =>
      progress.push([d, n]),
    );
    expect(unscored).toEqual({ total: run.newJobs, scored: run.newJobs, error: null });
    expect(progress[0]).toEqual([0, Math.ceil(run.newJobs / 10)]);
    expect(progress.at(-1)).toEqual([Math.ceil(run.newJobs / 10), Math.ceil(run.newJobs / 10)]);
    expect(await t.discovery.rescoreCounts()).toMatchObject({ unscored: 0, all: run.newJobs, stale: 0 });
    expect(await t.discovery.rescoreCounts(true)).toEqual({ unscored: 0, all: 0, stale: 0 }); // no side jobs

    // a full analysis takes the job out of every choice: the Inbox shows its fit, not triage
    const [first] = t.discovery.inbox({ filters: {}, sort: 'rank', limit: 1 });
    await t.jobs.analyze(first?.jobId ?? '');
    expect((await t.discovery.rescoreCounts()).all).toBe(run.newJobs - 1);

    // editing the profile makes every triage score stale
    const file = join(t.dir, 'profile/praneethreddy.md');
    writeFileSync(file, `${readFileSync(file, 'utf8')}\n`);
    expect((await t.discovery.rescoreCounts()).stale).toBe(run.newJobs - 1);
    const before = t.task('triage').length;
    const stale = await t.discovery.rescore({ scope: 'stale' });
    expect(stale.scored).toBe(run.newJobs - 1);
    expect(t.task('triage').length - before).toBe(Math.ceil((run.newJobs - 1) / 10));
    expect((await t.discovery.rescoreCounts()).stale).toBe(0);

    // one job: one call with that job only
    const [, second] = t.discovery.inbox({ filters: {}, sort: 'rank', limit: 2 });
    const one = await t.discovery.rescore({ scope: 'job', jobId: second?.jobId });
    expect(one).toEqual({ total: 1, scored: 1, error: null });
    expect(
      t
        .task('triage')
        .at(-1)
        ?.stdin.match(/<job id=/g),
    ).toHaveLength(1);
    await expect(t.discovery.rescore({ scope: 'job', jobId: 'nope' })).rejects.toThrow('no longer exists');

    // a failing CLI: nothing scored, the reason comes back
    t.env.FAKE_CLAUDE_MODE_JOB_TRIAGE = 'auth';
    const failed = await t.discovery.rescore({ scope: 'all' });
    expect(failed.scored).toBe(0);
    expect(failed.error).toMatch(/\S/);

    // never beside a scan, either way round
    const lock = acquireScanLock(t.db, 'manual', new Date(), 60_000);
    await expect(t.discovery.rescore({ scope: 'all' })).rejects.toThrow('A scan is running');
    t.db.sqlite.prepare("update scan_runs set status = 'error' where id = ?").run(lock?.id);
    t.env.FAKE_CLAUDE_MODE_JOB_TRIAGE = 'ok';
    const pending = t.discovery.rescore({ scope: 'all' });
    await expect(t.discovery.runScan({ trigger: 'manual' })).rejects.toThrow('Re-scoring is running');
    await expect(t.discovery.rescore({ scope: 'all' })).rejects.toThrow('already running');
    await pending;
  });
});

describe('side-job search profiles', () => {
  it('asks the job boards for part-time work, tags the jobs, triages them as side jobs and never auto-analyzes', async () => {
    const t = setup({ env: scoreEnv, seed: true });
    t.discovery.saveProfile(undefined, {
      ...PROFILE,
      name: 'Side money',
      kind: 'side',
      maxHoursPerWeek: 20,
      minHourlyPay: 13.9,
    });
    const asked: string[] = [];
    const ba = routes['/pc/v6/jobs'];
    const az = routes['/v1/api/jobs/de/search/1'];
    if (!ba || !az || typeof ba === 'function' || typeof az === 'function') throw new Error('fixture routes');
    const keep = { ba, az };
    routes['/pc/v6/jobs'] = (u: URL) => (asked.push(u.search), ba);
    routes['/v1/api/jobs/de/search/1'] = (u: URL) => (asked.push(u.search), az);
    try {
      const { run } = await t.discovery.runScan({ trigger: 'manual' });
      expect(run.newJobs).toBeGreaterThan(0);
      const ba = asked.filter((q) => q.includes('angebotsart'));
      expect(ba.length).toBeGreaterThan(0);
      expect(ba.every((q) => new URLSearchParams(q).get('arbeitszeit') === 'tz;mj')).toBe(true);
      expect(asked.some((q) => new URLSearchParams(q).get('part_time') === '1')).toBe(true);

      const inbox = t.discovery.inbox({ filters: {}, sort: 'rank', limit: 100 });
      expect(inbox.length).toBe(run.newJobs);
      expect(inbox.every((i) => i.sideJob)).toBe(true);
      expect(t.discovery.inbox({ filters: { sideJob: false }, sort: 'rank', limit: 100 })).toEqual([]);
      expect(t.discovery.inbox({ filters: { sideJob: true }, sort: 'rank', limit: 100 })).toHaveLength(
        run.newJobs,
      );
      // every triage call carries the side-job limits; strong scores never start a full analysis
      const triage = t.task('triage');
      expect(triage.length).toBeGreaterThan(0);
      for (const c of triage) {
        expect(c.stdin).toContain('<side_job>');
        expect(c.stdin).toContain('max hours per week: 20');
        expect(c.stdin).toContain('min hourly pay: 13.9 EUR');
      }
      expect(inbox.some((i) => (i.score ?? 0) >= 70)).toBe(true);
      expect(t.task('analyze')).toHaveLength(0);
    } finally {
      routes['/pc/v6/jobs'] = keep.ba;
      routes['/v1/api/jobs/de/search/1'] = keep.az;
    }
  });

  it('a job a career profile also wants stays a career job, triaged without the side-job block', async () => {
    const t = setup({ env: scoreEnv });
    t.discovery.saveProfile(undefined, {
      ...PROFILE,
      name: 'Side money',
      kind: 'side',
      maxHoursPerWeek: 20,
      minHourlyPay: null,
    });
    const { run } = await t.discovery.runScan({ trigger: 'manual' });
    const inbox = t.discovery.inbox({ filters: {}, sort: 'rank', limit: 100 });
    expect(inbox.length).toBe(run.newJobs);
    // the query-less sources check every profile at once: what the career profile wants is a career job
    const shared = inbox.filter((i) =>
      i.sources.some((s) => ['arbeitnow', 'remotive', 'remoteok'].includes(s)),
    );
    expect(shared.length).toBeGreaterThan(0);
    expect(shared.every((i) => !i.sideJob)).toBe(true);
    const careerCalls = t.task('triage').filter((c) => !c.stdin.includes('<side_job>'));
    expect(careerCalls.length).toBeGreaterThan(0);
  });
});

describe('watchlist management', () => {
  it('detects the ATS from the URL or the page, checks the board exists, and removes', async () => {
    const t = setup();
    const gh = await t.discovery.watchAdd('https://boards.greenhouse.io/acme', undefined);
    expect(gh).toMatchObject({ atsType: 'greenhouse', atsSlug: 'acme', company: 'Acme' });
    routes['/careers'] = { text: '<a href="https://jobs.ashbyhq.com/acme">Open roles</a>' };
    const viaPage = await t.discovery.watchAdd(`${server.base}/careers`, 'Acme Inc');
    expect(viaPage).toMatchObject({ atsType: 'ashby', atsSlug: 'acme' });
    await expect(t.discovery.watchAdd('https://boards.greenhouse.io/missing', undefined)).rejects.toThrow(
      /could not be read/,
    );
    routes['/nothing'] = { text: '<p>no board here</p>' };
    await expect(t.discovery.watchAdd(`${server.base}/nothing`, undefined)).rejects.toThrow(
      /No supported job board/,
    );
    await expect(t.discovery.watchAdd('ftp://x', undefined)).rejects.toThrow(/not a web link/);
    expect(t.discovery.watchRemove(viaPage.id)).toBe(true);
    expect(t.discovery.watchlist().find((w) => w.id === viaPage.id)).toBeUndefined();
  });
});

describe('web search agent', () => {
  const html = read('evals/jds/20-senior-data-engineer-remote-us.html');
  const pages: Fetcher = (url) =>
    Promise.resolve({
      status: url.includes('dead') ? 404 : 200,
      finalUrl: url,
      contentType: 'text/html',
      body: html,
    });
  const out = JSON.stringify({
    results: [
      {
        url: 'https://careers.websearch.example/job-1',
        title: 'Data Engineer',
        company: 'Websearch Co',
        snippet: 's',
      },
      {
        url: 'https://careers.websearch.example/job-1',
        title: 'dup url',
        company: 'Websearch Co',
        snippet: 's',
      },
      {
        url: 'https://careers.websearch.example/job-2',
        title: 'Data Engineer',
        company: 'Websearch Co',
        snippet: 's',
      },
      { url: 'http://insecure.example/job', title: 'x', company: 'Y', snippet: 's' },
      { url: 'https://careers.websearch.example/dead', title: 'x', company: 'Z', snippet: 's' },
      { url: 'https://careers.websearch.example/job-3', title: 'x', company: 'Initech', snippet: 's' },
    ],
  });
  const only = (t: ReturnType<typeof setup>) => {
    for (const id of ['adzuna', 'arbeitnow', 'ba', 'remotive', 'remoteok', 'himalayas', 'watchlist'] as const)
      t.discovery.setSourceEnabled(id, false);
    t.discovery.setSourceEnabled('websearch', true);
    t.discovery.saveProfile(undefined, { ...PROFILE, name: 'second', excludedCompanies: ['Initech'] });
  };
  it('runs once a day per profile with WebSearch/WebFetch only, sends every result through URL intake, records source websearch', async () => {
    const t = setup({
      fetcher: pages,
      env: {
        FAKE_CLAUDE_OUTPUT_DISCOVERY_WEBSEARCH: out,
        FAKE_CLAUDE_OUTPUT_JD_PARSE: JSON.stringify({ ...sampleJd, company: 'Websearch Co' }),
      },
    });
    only(t);
    const { run } = await t.discovery.runScan({ trigger: 'manual' });
    expect(run.status).toBe('ok');
    // two profiles: the first call finds the jobs, the second sees the same pages again
    expect(t.task('websearch')).toHaveLength(2);
    for (const c of t.task('websearch')) {
      expect(c.argv[c.argv.indexOf('--tools') + 1]).toBe('WebSearch,WebFetch');
      expect(c.argv[c.argv.indexOf('--allowedTools') + 1]).toBe('WebSearch,WebFetch');
      expect(c.argv[c.argv.indexOf('--setting-sources') + 1]).toBe(''); // still the isolated CLI
      expect(c.stdin).toContain('<limit>20</limit>');
    }
    expect(run.perSource.websearch).toMatchObject({ new: 1 });
    const src = t.db.sqlite.prepare("select source from job_sources where source = 'websearch'").all();
    expect(src.length).toBe(1);
    // the other tasks never get tools
    for (const c of [...t.task('parse'), ...t.task('triage')]) {
      expect(c.argv[c.argv.indexOf('--tools') + 1]).toBe('');
      expect(c.argv).not.toContain('--allowedTools');
    }
    // once a day per profile
    await t.discovery.runScan({ trigger: 'manual' });
    expect(t.task('websearch')).toHaveLength(2);
  });
});
