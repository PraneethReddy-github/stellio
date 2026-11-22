import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TimerPreview, TimerStatus } from '@shared/discovery/schemas';
import { UserError } from '../../ipc/dispatch';

const SERVICE = 'stellio-scan.service';
const TIMER = 'stellio-scan.timer';

export interface SystemctlResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type Systemctl = (args: string[]) => Promise<SystemctlResult>;

/** `systemctl --user ...`; `STELLIO_SYSTEMCTL` replaces the binary (tests). Code 127 = not runnable. */
export const runSystemctl: Systemctl = (args) =>
  new Promise((resolve) => {
    const child = spawn(process.env.STELLIO_SYSTEMCTL ?? 'systemctl', ['--user', ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', () => resolve({ code: 127, stdout, stderr: 'systemctl could not be started' }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });

/** The command the timer runs: this app with `--scan`. An AppImage must run itself, not its temp mount. */
export function scanCommand(o: {
  packaged: boolean;
  execPath: string;
  appPath: string;
  appImage?: string;
}): string[] {
  return o.packaged ? [o.appImage || o.execPath, '--scan'] : [o.execPath, o.appPath, '--scan'];
}

const quote = (a: string): string => {
  // A newline would start a new directive in the unit file; NUL and CR are never valid either.
  if (/[\0\r\n]/.test(a))
    throw new UserError('The app path or an argument contains a control character, so no unit was written.');
  return /^[A-Za-z0-9_/.:=@+-]+$/.test(a)
    ? a
    : `"${a.replace(/[\\"]/g, '\\$&').replace(/%/g, '%%').replace(/\$/g, '$$$$')}"`;
};

export function unitTexts(exec: string[], time: string): { service: string; timer: string } {
  return {
    service: `[Unit]\nDescription=Stellio daily job scan\n\n[Service]\nType=oneshot\nExecStart=${exec.map(quote).join(' ')}\n`,
    timer: `[Unit]\nDescription=Run the Stellio job scan every day at ${time}\n\n[Timer]\nOnCalendar=*-*-* ${time}:00\nPersistent=true\nUnit=${SERVICE}\n\n[Install]\nWantedBy=timers.target\n`,
  };
}

export interface TimerDeps {
  /** `~/.config` (or `$XDG_CONFIG_HOME`): the unit files go to `<configHome>/systemd/user`. */
  configHome: string;
  exec: () => string[];
  systemctl?: Systemctl;
}

export function createTimerService({ configHome, exec, systemctl = runSystemctl }: TimerDeps) {
  const dir = join(configHome, 'systemd', 'user');
  const servicePath = join(dir, SERVICE);
  const timerPath = join(dir, TIMER);
  const fail = (what: string, r: SystemctlResult): never => {
    const line = r.stderr.trim().split('\n')[0]?.slice(0, 200) ?? '';
    throw new UserError(
      r.code === 127 ? 'systemd is not available in this session.' : `${what}${line ? `: ${line}` : ''}`,
    );
  };

  const preview = (time: string): TimerPreview => {
    const t = unitTexts(exec(), time);
    return {
      service: { path: servicePath, content: t.service },
      timer: { path: timerPath, content: t.timer },
    };
  };

  return {
    preview,

    async install(time: string): Promise<TimerPreview> {
      const p = preview(time);
      mkdirSync(dir, { recursive: true });
      writeFileSync(servicePath, p.service.content);
      writeFileSync(timerPath, p.timer.content);
      const reload = await systemctl(['daemon-reload']);
      if (reload.code !== 0) fail('Could not reload systemd', reload);
      const enable = await systemctl(['enable', '--now', TIMER]);
      if (enable.code !== 0) fail('Could not enable the timer', enable);
      return p;
    },

    async remove(): Promise<void> {
      await systemctl(['disable', '--now', TIMER]); // already gone is fine
      rmSync(timerPath, { force: true });
      rmSync(servicePath, { force: true });
      await systemctl(['daemon-reload']);
    },

    async status(): Promise<TimerStatus> {
      const installed = existsSync(timerPath) && existsSync(servicePath);
      const time = installed
        ? (/OnCalendar=\*-\*-\* (\d\d:\d\d)/.exec(readFileSync(timerPath, 'utf8'))?.[1] ?? null)
        : null;
      if (!installed)
        return { installed, enabled: false, active: false, unavailable: false, time, nextRun: null };
      const [enabled, active, next] = await Promise.all([
        systemctl(['is-enabled', TIMER]),
        systemctl(['is-active', TIMER]),
        systemctl(['show', TIMER, '-p', 'NextElapseUSecRealtime', '--value']),
      ]);
      const parsed = Date.parse(next.stdout.trim().replace(/ [A-Z]{2,5}$/, ''));
      return {
        installed,
        enabled: enabled.stdout.trim() === 'enabled',
        active: active.stdout.trim() === 'active',
        unavailable: enabled.code === 127,
        time,
        nextRun: Number.isNaN(parsed) ? null : new Date(parsed).toISOString(),
      };
    },
  };
}
export type TimerService = ReturnType<typeof createTimerService>;
