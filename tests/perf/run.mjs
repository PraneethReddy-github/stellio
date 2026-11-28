// Performance budget run (docs/phases/phase-10-plan.md R1.6). Everything happens in a temp dir.
//   npm run perf            (builds, then runs this)
// Budget: cold start to an interactive Today < 2.5 s, IPC list p95 < 50 ms on 5,000 jobs, Inbox scroll without jank.
// Env: STELLIO_PERF_EXECUTABLE=release-e2e/linux-unpacked/stellio measures a packaged (unfused) build instead of out/.
import { _electron as electron } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { seedJobs } from './seed.mjs';

const JOBS = Number(process.env.STELLIO_PERF_JOBS ?? 5000);
const COLD_RUNS = 5;
const executablePath = process.env.STELLIO_PERF_EXECUTABLE;
const sandbox = mkdtempSync(join(tmpdir(), 'stellio-perf-'));
const dataDir = join(sandbox, 'data');
const userData = join(sandbox, 'userData');
const launch = () =>
  electron.launch({
    ...(executablePath ? { executablePath: resolve(executablePath), args: [] } : { args: ['.'] }),
    env: {
      ...process.env,
      STELLIO_USER_DATA: userData,
      STELLIO_DATA_DIR: dataDir,
      ELECTRON_RENDERER_URL: '',
      STELLIO_E2E: '1', // no catch-up scan on launch, recorded notifications; also keeps the window from being throttled
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    },
  });

const percentile = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};
const median = (xs) => percentile(xs, 50);
const round = (x) => Math.round(x * 10) / 10;

// 1. First launch creates and migrates the DB; then seed it and start measuring.
const first = await launch();
await first.firstWindow();
await first.close();
seedJobs(join(dataDir, '.stellio', 'stellio.db'), JOBS);

const result = { jobs: JOBS, build: executablePath ? 'packaged' : 'dev out/' };

console.error('seeded', JOBS);
// 2. Cold starts: process spawn -> first IPC answer, -> renderer.loaded (log timestamp), -> Today interactive.
const cold = { firstIpcMs: [], rendererLoadedMs: [], todayInteractiveMs: [] };
for (let i = 0; i < COLD_RUNS; i++) {
  const logFile = join(userData, 'logs', 'main.log');
  const t0 = Date.now();
  const app = await launch();
  const page = await app.firstWindow();
  await page.evaluate(() => window.stellio.invoke('app:getInfo', undefined));
  cold.firstIpcMs.push(Date.now() - t0);
  await page.getByRole('heading', { name: 'Today', level: 2 }).waitFor();
  // Interactive = the screen's data has arrived (no loading placeholder left) and the main nav is usable.
  await page
    .getByText(/^Loading/)
    .first()
    .waitFor({ state: 'detached', timeout: 10_000 })
    .catch(() => undefined);
  await page.getByRole('navigation', { name: 'Main' }).waitFor();
  cold.todayInteractiveMs.push(Date.now() - t0);
  const lines = existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split('\n') : [];
  const loaded = lines
    .map((l) => JSON.parse(l))
    .filter((l) => l.event === 'renderer.loaded' && Date.parse(l.t) >= t0)
    .at(0);
  if (loaded) cold.rendererLoadedMs.push(Date.parse(loaded.t) - t0);
  await app.close();
}
result.coldStartMs = Object.fromEntries(
  Object.entries(cold).map(([k, v]) => [k, { runs: v.map(round), median: round(median(v)) }]),
);

console.error('cold starts done');
// 3. IPC list latency on the seeded DB, and Inbox scrolling / selection in the UI.
const app = await launch();
const page = await app.firstWindow();
await page.setViewportSize({ width: 1360, height: 860 });
result.ipcMs = await page.evaluate(async () => {
  const bridge = window.stellio;
  const time = async (channel, input, n = 60) => {
    for (let i = 0; i < 5; i++) await bridge.invoke(channel, input); // warm-up (JIT, statement cache); cold start is measured above
    const xs = [];
    const stopAt = performance.now() + 15_000; // a very slow channel is reported from fewer samples
    for (let i = 0; i < n && (i < 5 || performance.now() < stopAt); i++) {
      const t = performance.now();
      const r = await bridge.invoke(channel, input);
      if (!r.ok) throw new Error(`${channel}: ${r.error.message}`);
      xs.push(performance.now() - t);
    }
    xs.sort((a, b) => a - b);
    const at = (p) => Math.round(xs[Math.min(xs.length - 1, Math.ceil((p / 100) * xs.length) - 1)] * 10) / 10;
    return { samples: xs.length, p50: at(50), p95: at(95), max: Math.round(xs.at(-1) * 10) / 10 };
  };
  return {
    'jobs:inbox (limit 500, rank)': await time('jobs:inbox', { filters: {}, sort: 'rank', limit: 500 }),
    'jobs:inbox (text filter)': await time('jobs:inbox', {
      filters: { text: 'engineer 42' },
      sort: 'rank',
      limit: 500,
    }),
    'jobs:inbox (recent)': await time('jobs:inbox', {
      filters: { minScore: 60 },
      sort: 'recent',
      limit: 100,
    }),
    'today:summary': await time('today:summary', undefined),
    'tracker:board': await time('tracker:board', undefined),
  };
});

console.error('ipc done');
// Without a search profile the Inbox shows its first-run state instead of the table.
await page.evaluate(() =>
  window.stellio.invoke('discovery:saveProfile', {
    profile: {
      name: 'Perf',
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
  }),
);
await page.evaluate(() => {
  window.location.hash = '/inbox';
});
const grid = page.getByRole('grid', { name: 'Discovered jobs' });
await grid.getByRole('row').nth(2).waitFor();
result.inboxRowsLoaded = await grid.getByRole('row').count();
// Scroll the table the way a wheel would: a fixed step per frame for 3 s, counting frames and long frames.
result.scroll = await page.evaluate(async () => {
  const el = document.querySelector('[role="grid"][aria-label="Discovered jobs"]');
  const frames = [];
  let last = performance.now();
  const end = last + 3000;
  let dir = 1;
  await new Promise((done) => {
    const tick = (now) => {
      frames.push(now - last);
      last = now;
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 5) dir = -1;
      else if (el.scrollTop <= 0) dir = 1;
      el.scrollTop += dir * 60;
      if (now < end) requestAnimationFrame(tick);
      else done();
    };
    requestAnimationFrame(tick);
  });
  frames.shift(); // the first interval includes setup
  const sorted = [...frames].sort((a, b) => a - b);
  const avg = frames.reduce((a, b) => a + b, 0) / frames.length;
  return {
    frames: frames.length,
    fps: Math.round((1000 / avg) * 10) / 10,
    p95FrameMs: Math.round(sorted[Math.ceil(0.95 * sorted.length) - 1] * 10) / 10,
    maxFrameMs: Math.round(sorted.at(-1) * 10) / 10,
    framesOver33ms: frames.filter((f) => f > 33.4).length,
  };
});
// Selection: ArrowDown moves the active row; time key press to the next painted frame.
await grid.focus();
result.selectionMs = await page.evaluate(async () => {
  const el = document.querySelector('[role="grid"][aria-label="Discovered jobs"]');
  const xs = [];
  for (let i = 0; i < 40; i++) {
    const t = performance.now();
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    xs.push(performance.now() - t);
  }
  xs.sort((a, b) => a - b);
  return {
    p50: Math.round(xs[19] * 10) / 10,
    p95: Math.round(xs[37] * 10) / 10,
    max: Math.round(xs[39] * 10) / 10,
  };
});
await app.close();
rmSync(sandbox, { recursive: true, force: true });

console.log(JSON.stringify(result, null, 2));
const failures = [];
if (result.coldStartMs.todayInteractiveMs.median > 2500)
  failures.push('cold start to interactive Today > 2.5 s');
for (const [k, v] of Object.entries(result.ipcMs))
  if (v.p95 > 50) failures.push(`${k} p95 ${v.p95} ms > 50 ms`);
if (result.scroll.p95FrameMs > 33) failures.push(`scroll p95 frame ${result.scroll.p95FrameMs} ms > 33 ms`);
if (failures.length) {
  console.error('PERF BUDGET MISSED:\n - ' + failures.join('\n - '));
  process.exit(1);
}
console.log('perf budget met');
