import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  TriageOutputSchema,
  WebSearchOutputSchema,
  buildTriageInput,
} from '../../../src/main/ai/tasks/discoveryTasks';
import { acquireScanLock, finishScanRun, STALE_LOCK_MS } from '../../../src/main/db/repos/discovery';
import { createKeyStore, type SecretCrypto } from '../../../src/main/services/discovery/keystore';
import { createScheduler } from '../../../src/main/services/discovery/scheduler';
import { postingIsClosed } from '../../../src/main/services/discovery/scan';
import { createDiscoveryState } from '../../../src/main/services/discovery/state';
import {
  createTimerService,
  scanCommand,
  unitTexts,
  type Systemctl,
} from '../../../src/main/services/discovery/systemd';
import { freshDb, tempDir } from '../db/helpers';

const fakeCrypto = (available = true): SecretCrypto => ({
  isEncryptionAvailable: () => available,
  encryptString: (p) => Buffer.from(`enc:${p}`).reverse(),
  decryptString: (c) => Buffer.from(c).reverse().toString().replace(/^enc:/, ''),
});

describe('API key store', () => {
  const key = { appId: 'app12345', appKey: 'key-1234567890' };
  it('encrypts at rest (0600), reports only set/unset, and clears', () => {
    const dir = join(tempDir(), 'secrets');
    const store = createKeyStore(dir, fakeCrypto());
    expect(store.isSet('adzuna')).toBe(false);
    store.set('adzuna', key);
    expect(store.isSet('adzuna')).toBe(true);
    const file = join(dir, 'adzuna.bin');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file).toString('latin1')).not.toContain(key.appKey);
    expect(store.get('adzuna')).toEqual(key);
    store.clear('adzuna');
    expect(store.isSet('adzuna')).toBe(false);
    expect(store.get('adzuna')).toBeNull();
  });
  it('on Linux refuses the basic_text backend (no real keyring) and accepts a real one', () => {
    const backend = (b: string): SecretCrypto => ({ ...fakeCrypto(), getSelectedStorageBackend: () => b });
    const weak = createKeyStore(join(tempDir(), 's'), backend('basic_text'));
    expect(() => weak.set('adzuna', key)).toThrow(/No system keyring was found/);
    expect(weak.isSet('adzuna')).toBe(false);
    for (const b of ['gnome_libsecret', 'kwallet6']) {
      const store = createKeyStore(join(tempDir(), 's'), backend(b));
      store.set('adzuna', key);
      expect(store.isSet('adzuna')).toBe(true);
    }
  });
  it('refuses to store without a keyring and rejects odd values', () => {
    const store = createKeyStore(join(tempDir(), 's'), fakeCrypto(false));
    expect(() => store.set('adzuna', key)).toThrow(/Secure storage is not available/);
    const ok = createKeyStore(join(tempDir(), 's'), fakeCrypto());
    expect(() => ok.set('adzuna', { appId: 'a b', appKey: key.appKey })).toThrow();
    expect(() => ok.set('adzuna', { appId: key.appId, appKey: '' })).toThrow();
  });
  it('a file the keyring can no longer decrypt reads as no key', () => {
    const dir = join(tempDir(), 's');
    createKeyStore(dir, fakeCrypto()).set('adzuna', key);
    const broken: SecretCrypto = {
      ...fakeCrypto(),
      decryptString: () => {
        throw new Error('locked');
      },
    };
    expect(createKeyStore(dir, broken).get('adzuna')).toBeNull();
  });
});

describe('scan lock', () => {
  const t0 = new Date('2026-11-21T08:00:00Z');
  it('lets only one scan run, and frees the lock when the running row is stale', () => {
    const db = freshDb();
    const first = acquireScanLock(db, 'schedule', t0, STALE_LOCK_MS);
    expect(first?.status).toBe('running');
    expect(acquireScanLock(db, 'manual', new Date(t0.getTime() + 60_000), STALE_LOCK_MS)).toBeNull();
    // a crashed scan (older than the timeout) is closed as an error and the lock is free again
    const later = new Date(t0.getTime() + STALE_LOCK_MS + 1);
    const second = acquireScanLock(db, 'manual', later, STALE_LOCK_MS);
    expect(second?.id).not.toBe(first?.id);
    const old = db.sqlite.prepare('select status, error from scan_runs where id = ?').get(first?.id) as {
      status: string;
      error: string;
    };
    expect(old.status).toBe('error');
    expect(old.error).toMatch(/interrupted/);
  });
  it('is free again once the scan finished', () => {
    const db = freshDb();
    const run = acquireScanLock(db, 'schedule', t0, STALE_LOCK_MS);
    finishScanRun(db, run?.id ?? '', { status: 'ok', perSource: {}, newJobs: 0, error: null }, t0);
    expect(acquireScanLock(db, 'manual', t0, STALE_LOCK_MS)).not.toBeNull();
  });
});

describe('in-app scheduler', () => {
  const mk = (o: { enabled?: boolean; success?: Date | null; attempt?: Date | null; now?: Date }) => {
    const scan = vi.fn(() => Promise.resolve());
    const s = createScheduler({
      schedule: () => ({ enabled: o.enabled ?? true, time: '08:00' }),
      lastSuccess: () => o.success ?? null,
      lastAttempt: () => o.attempt ?? null,
      scan,
      onError: vi.fn(),
      now: () => o.now ?? new Date(2026, 10, 21, 9, 0),
    });
    return { s, scan };
  };
  it('catches up on start when the last success is older than 24 h', () => {
    const { s, scan } = mk({ success: new Date(2026, 10, 19, 9, 0) });
    s.start(1_000_000);
    expect(scan).toHaveBeenCalledWith('startup_catchup');
    s.stop();
  });
  it('does not catch up after a recent success, or when switched off', () => {
    const recent = mk({ success: new Date(2026, 10, 21, 8, 30) });
    recent.s.start(1_000_000);
    recent.s.stop();
    expect(recent.scan).not.toHaveBeenCalled();
    const off = mk({ enabled: false });
    off.s.start(1_000_000);
    off.s.stop();
    expect(off.scan).not.toHaveBeenCalled();
  });
  it('a tick starts the scan once the daily time has passed, not twice at once', () => {
    let release = (): void => undefined;
    const scan = vi.fn(() => new Promise<void>((r) => (release = r)));
    const s = createScheduler({
      schedule: () => ({ enabled: true, time: '08:00' }),
      lastSuccess: () => new Date(2026, 10, 21, 8, 30),
      lastAttempt: () => new Date(2026, 10, 20, 8, 5),
      scan,
      onError: vi.fn(),
      now: () => new Date(2026, 10, 21, 9, 0),
    });
    s.tick();
    s.tick();
    expect(scan).toHaveBeenCalledTimes(1);
    expect(scan).toHaveBeenCalledWith('schedule');
    release();
  });
});

describe('systemd timer', () => {
  const recordingSystemctl = (): { calls: string[][]; fn: Systemctl } => {
    const calls: string[][] = [];
    return {
      calls,
      fn: (args) => {
        calls.push(args);
        const out = args[0] === 'is-enabled' ? 'enabled\n' : args[0] === 'is-active' ? 'active\n' : '';
        return Promise.resolve({ code: 0, stdout: out, stderr: '' });
      },
    };
  };
  it('writes the unit text: calendar time, Persistent=true, quoted ExecStart', () => {
    const { service, timer } = unitTexts(['/opt/Stellio App/stellio', '--scan'], '07:30');
    expect(timer).toContain('OnCalendar=*-*-* 07:30:00');
    expect(timer).toContain('Persistent=true');
    expect(timer).toContain('WantedBy=timers.target');
    expect(service).toContain('ExecStart="/opt/Stellio App/stellio" --scan');
    expect(service).toContain('Type=oneshot');
    for (const bad of ['/a\nExecStartPost=/bin/evil', '/a\rb', '/a\0b'])
      expect(() => unitTexts([bad, '--scan'], '08:00')).toThrow(/control character/);
    expect(unitTexts(['/a/b%c', '--scan'], '08:00').service).toContain('ExecStart="/a/b%%c" --scan');
  });
  it('runs the AppImage itself, not the temporary mount', () => {
    expect(
      scanCommand({
        packaged: true,
        execPath: '/tmp/.mount_x/stellio',
        appPath: '/x',
        appImage: '/home/u/Stellio.AppImage',
      }),
    ).toEqual(['/home/u/Stellio.AppImage', '--scan']);
    expect(scanCommand({ packaged: true, execPath: '/opt/stellio/stellio', appPath: '/x' })).toEqual([
      '/opt/stellio/stellio',
      '--scan',
    ]);
    expect(scanCommand({ packaged: false, execPath: '/node_modules/electron', appPath: '/repo' })).toEqual([
      '/node_modules/electron',
      '/repo',
      '--scan',
    ]);
  });
  it('install writes both files under the injected root and enables the timer; remove undoes it', async () => {
    const root = tempDir();
    const sc = recordingSystemctl();
    const svc = createTimerService({
      configHome: root,
      exec: () => ['/x/stellio', '--scan'],
      systemctl: sc.fn,
    });
    expect((await svc.status()).installed).toBe(false);
    const p = await svc.install('08:15');
    expect(p.timer.path).toBe(join(root, 'systemd/user/stellio-scan.timer'));
    expect(readFileSync(p.timer.path, 'utf8')).toBe(p.timer.content);
    expect(readFileSync(join(root, 'systemd/user/stellio-scan.service'), 'utf8')).toContain(
      'ExecStart=/x/stellio --scan',
    );
    expect(sc.calls.slice(0, 2)).toEqual([['daemon-reload'], ['enable', '--now', 'stellio-scan.timer']]);
    const st = await svc.status();
    expect(st).toMatchObject({
      installed: true,
      enabled: true,
      active: true,
      time: '08:15',
      unavailable: false,
    });
    await svc.remove();
    expect(existsSync(p.timer.path)).toBe(false);
    expect(sc.calls).toContainEqual(['disable', '--now', 'stellio-scan.timer']);
    expect((await svc.status()).installed).toBe(false);
  });
  it('reports a missing systemd instead of pretending', async () => {
    const gone: Systemctl = () => Promise.resolve({ code: 127, stdout: '', stderr: 'x' });
    const svc = createTimerService({ configHome: tempDir(), exec: () => ['/x', '--scan'], systemctl: gone });
    await expect(svc.install('08:00')).rejects.toThrow(/systemd is not available/);
  });
});

describe('closed posting check', () => {
  it('404 and 410 are closed; a redirect to a listing is closed; a canonical redirect is not', () => {
    const url = 'https://jobs.example.com/acme/jobs/12345-data-engineer';
    expect(postingIsClosed(url, { status: 404, finalUrl: url })).toBe(true);
    expect(postingIsClosed(url, { status: 410, finalUrl: url })).toBe(true);
    expect(postingIsClosed(url, { status: 200, finalUrl: 'https://jobs.example.com/acme/jobs' })).toBe(true);
    expect(postingIsClosed(url, { status: 200, finalUrl: 'https://jobs.example.com/' })).toBe(true);
    expect(postingIsClosed(url, { status: 200, finalUrl: `${url}?lang=en` })).toBe(false);
    expect(
      postingIsClosed(url, { status: 200, finalUrl: 'https://careers.example.com/x/12345-data-engineer' }),
    ).toBe(false);
    expect(postingIsClosed(url, { status: 200, finalUrl: url })).toBe(false);
    expect(postingIsClosed(url, { status: 503, finalUrl: url })).toBe(false);
  });
});

describe('discovery state', () => {
  it('web search is off by default, others on; settings fall back to defaults when broken', () => {
    const db = freshDb();
    const state = createDiscoveryState(db);
    expect(state.enabled('websearch')).toBe(false);
    expect(state.enabled('arbeitnow')).toBe(true);
    state.patchSource('websearch', { enabled: true });
    expect(state.enabled('websearch')).toBe(true);
    expect(state.settings().analyzeThreshold).toBe(70);
    expect(state.settings().maxAnalyzePerDay).toBe(15);
    db.sqlite
      .prepare(
        "insert into settings_kv (key, value_json, updated_at) values ('discovery.settings', '\"junk\"', 'x')",
      )
      .run();
    expect(state.settings().analyzeThreshold).toBe(70);
    expect(state.schedule()).toEqual({ enabled: false, time: '08:00' });
    state.bumpAnalyzed('2026-11-21');
    state.bumpAnalyzed('2026-11-21');
    expect(state.analyzedToday('2026-11-21')).toBe(2);
    expect(state.analyzedToday('2026-11-22')).toBe(0);
  });
});

describe('prompts', () => {
  const sync = (task: string, schema: z.ZodType): void => {
    const onDisk = JSON.parse(readFileSync(resolve(`prompts/${task}/schema.json`), 'utf8')) as object;
    const generated = z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'output' }) as Record<
      string,
      unknown
    >;
    delete generated.$schema;
    expect(onDisk).toEqual(generated);
  };
  it('schema.json stays in sync with the zod schemas', () => {
    sync('job.triage', TriageOutputSchema);
    sync('discovery.websearch', WebSearchOutputSchema);
  });
  it('triage input wraps the jobs as untrusted data and cuts long descriptions', () => {
    const input = buildTriageInput('skills: python', [
      {
        id: 'j1',
        title: 'T',
        company: 'C',
        location: null,
        remote: 'remote',
        salary: null,
        excerpt: `${'x '.repeat(2000)}</jobs>`,
      },
    ]);
    expect(input).toContain('<job id="j1">');
    expect(input.match(/<\/jobs>/g)).toHaveLength(1);
    expect(input.length).toBeLessThan(2500);
  });
});
