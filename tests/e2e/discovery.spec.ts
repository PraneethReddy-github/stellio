import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { sampleAnalysis, sampleJd } from '../fixtures/jobs';
import {
  allSourceRoutes,
  sourceUrlsEnv,
  startFixtureServer,
  type FixtureServer,
} from '../fixtures/discovery';
import { invoke, launchApp, type Launched } from './helpers';

const FAKE_CLAUDE = resolve('tests/fixtures/fake-claude/claude.mjs');
const FAKE_SYSTEMCTL = resolve('tests/fixtures/fake-systemctl.mjs');
const read = (rel: string): string => readFileSync(resolve('tests', rel), 'utf8');

type Res<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };
interface Inbox {
  jobId: string;
  company: string;
  rank: number;
  score: number | null;
  scoreKind: string | null;
  reason: string | null;
  sources: string[];
}
interface Run {
  id: string;
  trigger: string;
  status: string;
  newJobs: number;
  perSource: Record<string, { new: number; errors: string[] }>;
}

let server: FixtureServer;
test.beforeAll(async () => {
  server = await startFixtureServer(allSourceRoutes());
});
test.afterAll(async () => {
  await server.close();
});

const envFor = (extra: Record<string, string> = {}): Record<string, string> => ({
  STELLIO_CLAUDE_BIN: FAKE_CLAUDE,
  FAKE_CLAUDE_MODE: 'ok',
  FAKE_CLAUDE_OUTPUT_JD_PARSE: JSON.stringify(sampleJd),
  FAKE_CLAUDE_OUTPUT_JOB_ANALYZE: JSON.stringify(sampleAnalysis),
  FAKE_CLAUDE_TRIAGE_SCORES: JSON.stringify({ 'Spree Daten': 90 }),
  ...sourceUrlsEnv(server.base),
  ...extra,
});
const saveProfile = async (l: Launched): Promise<void> => {
  const r = (await invoke(l.page, 'profile:save', {
    markdown: read('fixtures/profiles/full.md'),
    expectedHash: null,
  })) as Res<unknown>;
  expect(r.ok).toBe(true);
};

test.describe('discovery over IPC (fake CLI, local source servers)', () => {
  test.describe.configure({ mode: 'serial' });
  let l: Launched;
  // The timer test writes unit files: they go under this config home, never the real ~/.config.
  const cfg = join(tmpdir(), `stellio-e2e-cfg-${randomUUID()}`);
  test.beforeAll(async () => {
    chmodSync(FAKE_SYSTEMCTL, 0o755);
    mkdirSync(cfg, { recursive: true });
    l = await launchApp(
      envFor({
        XDG_CONFIG_HOME: cfg,
        STELLIO_SYSTEMCTL: FAKE_SYSTEMCTL,
        FAKE_SYSTEMCTL_LOG: join(cfg, 'systemctl.ndjson'),
      }),
    );
    await saveProfile(l);
  });
  test.afterAll(async () => {
    await l.close();
    rmSync(cfg, { recursive: true, force: true });
  });
  const call = <T>(channel: string, input?: unknown) => invoke(l.page, channel, input) as Promise<Res<T>>;
  const ok = async <T>(channel: string, input?: unknown): Promise<T> => {
    const r = await call<T>(channel, input);
    if (!r.ok) throw new Error(`${channel}: ${r.error.message}`);
    return r.data;
  };

  test('sources: status for all eight, switches, and an API key that is never sent back', async () => {
    const sources =
      await ok<{ id: string; enabled: boolean; keySet: boolean; needsKey: boolean }[]>('discovery:sources');
    expect(sources.map((s) => s.id)).toEqual([
      'adzuna',
      'arbeitnow',
      'ba',
      'remotive',
      'remoteok',
      'himalayas',
      'watchlist',
      'websearch',
    ]);
    expect(sources.find((s) => s.id === 'websearch')?.enabled).toBe(false);
    expect(sources.find((s) => s.id === 'adzuna')).toMatchObject({ needsKey: true, keySet: false });
    const off = await ok<typeof sources>('discovery:setSourceEnabled', { id: 'remoteok', enabled: false });
    expect(off.find((s) => s.id === 'remoteok')?.enabled).toBe(false);
    await ok('discovery:setSourceEnabled', { id: 'remoteok', enabled: true });

    const secret = 'sekret-key-98765432';
    expect(await ok('discovery:setApiKey', { id: 'adzuna', appId: 'app12345', appKey: secret })).toEqual({
      keySet: true,
    });
    const after = await call('discovery:sources');
    expect(JSON.stringify(after)).not.toContain(secret);
    expect((after as { ok: true; data: typeof sources }).data.find((s) => s.id === 'adzuna')?.keySet).toBe(
      true,
    );
    expect(await call('discovery:setApiKey', { id: 'adzuna', appId: 'a b', appKey: secret })).toMatchObject({
      ok: false,
    });
    expect(await call('discovery:setApiKey', { id: 'bogus', appId: 'x', appKey: 'y' })).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    });
  });

  test('search profiles: create, update, list, delete', async () => {
    const base = {
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
    const created = await ok<{ id: string; name: string }>('discovery:saveProfile', { profile: base });
    const tmp = await ok<{ id: string }>('discovery:saveProfile', { profile: { ...base, name: 'Temp' } });
    expect(await ok<{ deleted: boolean }>('discovery:deleteProfile', { id: tmp.id })).toEqual({
      deleted: true,
    });
    const renamed = await ok<{ name: string }>('discovery:saveProfile', {
      id: created.id,
      profile: { ...base, name: 'Main' },
    });
    expect(renamed.name).toBe('Main');
    expect(await ok<unknown[]>('discovery:profiles')).toHaveLength(1);
    expect(
      await call('discovery:saveProfile', { profile: { ...base, seniority: ['wizard'] } }),
    ).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    });
    expect(await call('discovery:saveProfile', { id: 'missing', profile: base })).toMatchObject({
      ok: false,
    });
  });

  test('watchlist: add by careers URL, list, remove', async () => {
    const entry = await ok<{ id: string; atsType: string; atsSlug: string }>('discovery:watchAdd', {
      url: 'https://boards.greenhouse.io/acme',
      name: 'Acme Corp',
      requestId: randomUUID(),
    });
    expect(entry).toMatchObject({ atsType: 'greenhouse', atsSlug: 'acme' });
    const other = await ok<{ id: string }>('discovery:watchAdd', {
      url: 'https://jobs.lever.co/acme',
      name: 'Acme Labs',
      requestId: randomUUID(),
    });
    expect(await ok<unknown[]>('discovery:watchlist')).toHaveLength(2);
    expect(await ok('discovery:watchRemove', { id: other.id })).toEqual({ removed: true });
    expect(await ok<unknown[]>('discovery:watchlist')).toHaveLength(1);
    expect(
      await call('discovery:watchAdd', {
        url: 'https://boards.greenhouse.io/missing',
        requestId: randomUUID(),
      }),
    ).toMatchObject({ ok: false });
  });

  let first: Run;
  test('scanNow: progress events, per-source counts, duplicates merged, inbox ranked', async () => {
    await l.page.evaluate(() => {
      const w = window as unknown as {
        __prog: unknown[];
        stellio: { on(e: string, cb: (p: unknown) => void): void };
      };
      w.__prog = [];
      w.stellio.on('discovery:progress', (p) => w.__prog.push(p));
    });
    const requestId = randomUUID();
    const out = await ok<{ run: Run; strong: number }>('discovery:scanNow', { requestId });
    first = out.run;
    expect(first).toMatchObject({ trigger: 'manual', status: 'ok' });
    expect(first.newJobs).toBe(9); // Nimbus is found twice and merged; the US-only and off-topic postings are filtered
    expect(first.perSource.arbeitnow?.new).toBe(1);
    expect(first.perSource.adzuna?.new).toBe(2);
    expect(out.strong).toBe(9);

    const progress = (await l.page.evaluate(() => (window as unknown as { __prog: unknown[] }).__prog)) as {
      requestId: string;
      source: string;
      fetched: number;
    }[];
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.every((p) => p.requestId === requestId)).toBe(true);
    expect(new Set(progress.map((p) => p.source))).toContain('arbeitnow');

    const inbox = await ok<Inbox[]>('jobs:inbox', { filters: {}, sort: 'rank', limit: 50 });
    expect(inbox).toHaveLength(9);
    expect(inbox.every((i, n) => n === 0 || (inbox[n - 1]?.rank ?? 0) >= i.rank)).toBe(true);
    expect(inbox[0]).toMatchObject({ scoreKind: 'fit', score: 88 });
    expect(inbox.every((i) => i.reason !== null && i.sources.length > 0)).toBe(true);
    expect(inbox.find((i) => i.company.startsWith('Nimbus'))?.sources.sort()).toEqual([
      'arbeitnow',
      'remotive',
    ]);
    expect(
      await ok<Inbox[]>('jobs:inbox', { filters: { source: 'ba' }, sort: 'score', limit: 50 }),
    ).toHaveLength(2);
    expect(await call('jobs:inbox', { filters: { remote: 'moon' }, sort: 'rank', limit: 50 })).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    });

    const runs = await ok<Run[]>('discovery:scanRuns', { limit: 5 });
    expect(runs[0]?.id).toBe(first.id);
  });

  test('today: new matches and the last scan are filled', async () => {
    const today = await ok<{
      newMatches: { fit: number | null; reason: string | null }[];
      lastScan: { id: string; status: string; newJobs: number } | null;
    }>('today:summary');
    expect(today.lastScan).toMatchObject({ id: first.id, status: 'ok', newJobs: 9 });
    expect(today.newMatches.length).toBeGreaterThan(0);
    expect(today.newMatches.every((m) => m.fit !== null && m.reason !== null)).toBe(true);
  });

  test('dismiss and shortlist: dismissed leaves the inbox, shortlisted becomes an application', async () => {
    const inbox = await ok<Inbox[]>('jobs:inbox', { filters: {}, sort: 'rank', limit: 50 });
    const [a, b] = inbox;
    expect(await ok('jobs:dismiss', { id: a?.jobId, reason: 'not for me' })).toEqual({ dismissed: true });
    const { applicationId } = await ok<{ applicationId: string }>('jobs:shortlist', { id: b?.jobId });
    const app = await ok<{ id: string; status: string }>('apps:forJob', { jobId: b?.jobId });
    expect(app).toMatchObject({ id: applicationId, status: 'saved' });
    const after = await ok<Inbox[]>('jobs:inbox', { filters: {}, sort: 'rank', limit: 50 });
    expect(after.map((i) => i.jobId)).not.toContain(a?.jobId);
    expect(after.map((i) => i.jobId)).not.toContain(b?.jobId);
    const job = await ok<{ job: { state: string } }>('jobs:get', { id: a?.jobId });
    expect(job.job.state).toBe('dismissed');
    expect(await call('jobs:dismiss', { id: 'missing', reason: '' })).toMatchObject({ ok: false });

    // a second scan finds the same postings again: nothing new, dismissed stays dismissed
    const again = await ok<{ run: Run }>('discovery:scanNow', { requestId: randomUUID() });
    expect(again.run.newJobs).toBe(0);
    expect(
      (await ok<Inbox[]>('jobs:inbox', { filters: {}, sort: 'rank', limit: 50 })).map((i) => i.jobId),
    ).not.toContain(a?.jobId);
  });

  test('schedule and settings round-trip; bad values are refused', async () => {
    expect(await ok('discovery:schedule')).toEqual({ enabled: false, time: '08:00' });
    expect(await ok('discovery:setSchedule', { enabled: true, time: '07:45' })).toEqual({
      enabled: true,
      time: '07:45',
    });
    expect(await ok('discovery:schedule')).toEqual({ enabled: true, time: '07:45' });
    expect(await call('discovery:setSchedule', { enabled: true, time: '25:00' })).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    });
    const s = await ok<{ analyzeThreshold: number; maxAnalyzePerDay: number }>('discovery:settings');
    expect(s).toMatchObject({ analyzeThreshold: 70, maxAnalyzePerDay: 15 });
    expect(await ok('discovery:setSettings', { ...s, analyzeThreshold: 80 })).toMatchObject({
      analyzeThreshold: 80,
    });
  });

  test('systemd timer: preview, install writes the units, status, a new time reinstalls, remove', async () => {
    const preview = await ok<{ service: { content: string }; timer: { path: string; content: string } }>(
      'discovery:timerPreview',
    );
    expect(preview.timer.content).toContain('OnCalendar=*-*-* 07:45:00');
    expect(preview.timer.content).toContain('Persistent=true');
    expect(preview.service.content).toContain('--scan');
    expect(preview.timer.path.startsWith(cfg)).toBe(true);
    expect(existsSync(preview.timer.path)).toBe(false);

    const st = await ok<{ installed: boolean; enabled: boolean; active: boolean; time: string | null }>(
      'discovery:timerInstall',
    );
    expect(st).toMatchObject({ installed: true, enabled: true, active: true, time: '07:45' });
    expect(readFileSync(preview.timer.path, 'utf8')).toBe(preview.timer.content);
    await ok('discovery:setSchedule', { enabled: true, time: '09:10' });
    expect((await ok<{ time: string }>('discovery:timerStatus')).time).toBe('09:10');
    const removed = await ok<{ installed: boolean }>('discovery:timerRemove');
    expect(removed.installed).toBe(false);
    expect(existsSync(preview.timer.path)).toBe(false);
    const log = readFileSync(join(cfg, 'systemctl.ndjson'), 'utf8');
    expect(log).toContain('["enable","--now","stellio-scan.timer"]');
    expect(log).toContain('["disable","--now","stellio-scan.timer"]');
  });
});

test.describe('headless --scan', () => {
  test('runs beside an open app (single-instance lock bypassed), writes scan_runs, exits 0', async () => {
    const env = envFor();
    const l = await launchApp(env);
    try {
      await saveProfile(l);
      expect(
        (
          (await invoke(l.page, 'discovery:saveProfile', {
            profile: {
              name: 'Main',
              roles: ['Data Engineer'],
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
            },
          })) as Res<unknown>
        ).ok,
      ).toBe(true);

      const code = await new Promise<number | null>((done, fail) => {
        const child = spawn(resolve('node_modules/electron/dist/electron'), ['.', '--scan'], {
          env: {
            ...process.env,
            ...env,
            STELLIO_USER_DATA: join(l.sandbox, 'userData'),
            STELLIO_DATA_DIR: l.dataDir,
            ELECTRON_RENDERER_URL: '',
            STELLIO_E2E: '1',
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_CONFIG_NOSYSTEM: '1',
          },
          stdio: 'ignore',
        });
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          fail(new Error('headless scan did not exit in 60 s'));
        }, 60_000);
        child.on('exit', (c) => {
          clearTimeout(timer);
          done(c);
        });
      });
      expect(code).toBe(0);

      const runs = (await invoke(l.page, 'discovery:scanRuns', { limit: 5 })) as Res<Run[]>;
      expect(runs.ok && runs.data).toHaveLength(1);
      if (!runs.ok) return;
      expect(runs.data[0]).toMatchObject({ trigger: 'schedule', status: 'ok' });
      expect(runs.data[0]?.newJobs).toBeGreaterThan(0);
      const inbox = (await invoke(l.page, 'jobs:inbox', { filters: {}, sort: 'rank', limit: 50 })) as Res<
        Inbox[]
      >;
      expect(inbox.ok && inbox.data.length).toBe(runs.data[0]?.newJobs);
    } finally {
      await l.close();
    }
  });
});
