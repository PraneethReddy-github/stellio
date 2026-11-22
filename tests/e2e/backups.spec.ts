import { existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { invoke, launchApp } from './helpers';
import { SHOTS } from './trackerSeed';

type Res<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };
interface Notifications {
  digestEnabled: boolean;
  digestTime: string;
  scanEnabled: boolean;
}
interface Backup {
  name: string;
  kind: string;
  restorable: boolean;
}

test('restore round trip: snapshot first, swap, restart on the restored data; a corrupt backup changes nothing', async () => {
  const first = await launchApp();
  const { page, app } = first;
  const call = <T>(channel: string, input?: unknown) => invoke(page, channel, input) as Promise<Res<T>>;
  const ok = async <T>(channel: string, input?: unknown): Promise<T> => {
    const r = await call<T>(channel, input);
    if (!r.ok) throw new Error(`${channel}: ${r.error.message}`);
    return r.data;
  };
  const marker = (digestTime: string): Promise<Notifications> =>
    ok('notifications:set', { digestEnabled: false, digestTime, scanEnabled: false });
  let second: Awaited<ReturnType<typeof launchApp>> | undefined;
  try {
    await marker('07:30');
    const snapshot = await ok<Backup>('backups:create');
    expect(snapshot).toMatchObject({ kind: 'database', restorable: true });
    await marker('18:45'); // the newer state the restore will replace

    // A corrupt file named like a backup is refused and nothing changes.
    const corrupt = 'stellio-2026-01-01-corrupt.db';
    writeFileSync(join(first.dataDir, '.stellio', 'backups', corrupt), 'this is not a database');
    const refused = await call('backups:restore', { name: corrupt });
    expect(refused).toMatchObject({ ok: false, error: { message: expect.stringContaining('not a usable') } });
    expect((await ok<Notifications>('notifications:get')).digestTime).toBe('18:45');
    expect(readdirSync(join(first.dataDir, '.stellio')).filter((f) => f.includes('restore-tmp'))).toEqual([]);
    expect((await ok<Backup[]>('backups:list')).some((b) => b.name.includes('pre-restore'))).toBe(false);
    // Names that are not backup files never reach the file system.
    expect(await call('backups:restore', { name: '../stellio.db' })).toMatchObject({ ok: false });

    // Restore from the UI.
    await page.evaluate(() => {
      window.location.hash = '/settings';
    });
    const region = page.getByRole('region', { name: 'Backups', exact: true });
    await expect(region.getByRole('button', { name: `Restore ${snapshot.name}` })).toBeVisible();
    const closed = app.waitForEvent('close');
    await region.getByRole('button', { name: `Restore ${snapshot.name}` }).click();
    if (SHOTS) {
      for (const theme of ['dark', 'light'] as const) {
        await page.evaluate((t) => {
          document.documentElement.dataset.theme = t;
        }, theme);
        await page.screenshot({ path: `${SHOTS}/settings-restore-dialog-${theme}.png` });
      }
    }
    await page.getByRole('button', { name: 'Restore and restart' }).click();
    await closed; // E2E quits instead of relaunching

    second = await launchApp({
      STELLIO_USER_DATA: join(first.sandbox, 'userData'),
      STELLIO_DATA_DIR: first.dataDir,
    });
    const again = <T>(channel: string, input?: unknown) =>
      invoke(second?.page ?? page, channel, input) as Promise<Res<T>>;
    const restored = await again<Notifications>('notifications:get');
    expect(restored).toMatchObject({ ok: true, data: { digestTime: '07:30' } });
    const list = await again<Backup[]>('backups:list');
    expect(list.ok && list.data.some((b) => b.name.includes('pre-restore'))).toBe(true);
  } finally {
    await second?.close();
    await app.close().catch(() => undefined);
    rmSync(first.sandbox, { recursive: true, force: true });
  }
  expect(existsSync(first.sandbox)).toBe(false);
});

test('notification settings validate and persist', async () => {
  const l = await launchApp();
  try {
    const bad = await invoke(l.page, 'notifications:set', {
      digestEnabled: true,
      digestTime: '25:99',
      scanEnabled: true,
    });
    expect(bad).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    await l.page.evaluate(() => {
      window.location.hash = '/settings';
    });
    const region = l.page.getByRole('region', { name: 'Notifications', exact: true });
    await region.getByRole('switch', { name: 'Tell me when a scheduled scan finds new matches' }).click();
    await region.getByRole('textbox', { name: 'Digest time' }).fill('06:15');
    await expect
      .poll(async () => ((await invoke(l.page, 'notifications:get')) as Res<Notifications>).ok)
      .toBe(true);
    await expect
      .poll(async () => ((await invoke(l.page, 'notifications:get')) as { data: Notifications }).data)
      .toEqual({ digestEnabled: true, digestTime: '06:15', scanEnabled: false });
    if (SHOTS) {
      await l.page.setViewportSize({ width: 1360, height: 860 });
      await invoke(l.page, 'backups:create');
      await l.page.reload();
      await expect(l.page.getByRole('table', { name: 'Backups' })).toBeVisible();
      for (const theme of ['dark', 'light'] as const) {
        await l.page.evaluate((t) => {
          document.documentElement.dataset.theme = t;
        }, theme);
        for (const id of ['notifications', 'backups'])
          await l.page
            .locator(`#settings-${id}`)
            .screenshot({ path: `${SHOTS}/settings-${id}-${theme}.png` });
      }
    }
  } finally {
    await l.close();
  }
});
