// Smoke test for a FUSED release build (Playwright cannot attach to one: the inspector fuse is off).
// Launches the app as a fresh user (temp HOME and XDG dirs), with ELECTRON_RUN_AS_NODE=1 set and a `-e` script,
// then checks that
//   - the app started normally and logged `renderer.loaded` (the window really loaded the UI),
//   - the `-e` script did not run (RunAsNode fuse is off), and
//   - the data folder was seeded in the temp HOME.
// Usage: node tests/packaging/fused-smoke.mjs release/linux-unpacked/stellio   (or the AppImage)
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const exe = resolve(process.argv[2] ?? 'release/linux-unpacked/stellio');
if (!existsSync(exe)) throw new Error(`not found: ${exe}`);

const home = mkdtempSync(join(tmpdir(), 'stellio-fused-'));
for (const d of ['.config', '.local/share', '.cache']) mkdirSync(join(home, d), { recursive: true });
const log = join(home, '.config', 'Stellio', 'logs', 'main.log');

const child = spawn(exe, ['-e', 'console.log("RAN_AS_NODE")'], {
  env: {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local/share'),
    XDG_CACHE_HOME: join(home, '.cache'),
    ELECTRON_RUN_AS_NODE: '1',
    APPIMAGE_EXTRACT_AND_RUN: '1', // no FUSE needed when the target is an AppImage
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true, // own process group: an AppImage wrapper leaves children behind
});
let output = '';
child.stdout.on('data', (b) => (output += b));
child.stderr.on('data', (b) => (output += b));
let exited = null;
child.on('exit', (code) => (exited = code));

const deadline = Date.now() + 45_000;
let loaded = false;
while (Date.now() < deadline && exited === null) {
  if (existsSync(log) && readFileSync(log, 'utf8').includes('renderer.loaded')) {
    loaded = true;
    break;
  }
  await new Promise((r) => setTimeout(r, 250));
}
const logText = existsSync(log) ? readFileSync(log, 'utf8') : '';
const stop = (signal) => {
  try {
    process.kill(-child.pid, signal);
  } catch {
    // already gone
  }
};
stop('SIGTERM');
await new Promise((r) => setTimeout(r, 1000));
stop('SIGKILL');

const checks = {
  'renderer.loaded logged': loaded,
  'no app.fatal / renderer.gone': !/app\.fatal|renderer\.gone/.test(logText),
  'RunAsNode fuse off (-e script did not run)': !output.includes('RAN_AS_NODE'),
  'data folder seeded': existsSync(join(home, 'Stellio', 'profile', 'profile.md')),
};
rmSync(home, { recursive: true, force: true });
for (const [name, ok] of Object.entries(checks)) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
const failed = !Object.values(checks).every(Boolean);
if (failed) console.log(output.slice(-1500));
process.exit(failed ? 1 : 0);
