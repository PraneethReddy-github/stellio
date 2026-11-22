import { expect, test, type ConsoleMessage, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp, type Launched } from './helpers';

let launched: Launched;
let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  launched = await launchApp();
  ({ app, page } = launched);
});

test.afterAll(async () => {
  await launched.close();
});

test('shell renders and reaches the main process over IPC', async () => {
  await expect(page).toHaveTitle('Stellio');
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  const info = await page.evaluate(() => window.stellio.invoke('app:getInfo', undefined));
  expect(info).toMatchObject({ ok: true, data: { platform: 'linux', gitAvailable: true } });
});

test('renderer has no Node access', async () => {
  const exposed = await page.evaluate(() => ({
    require: typeof (globalThis as Record<string, unknown>).require,
    process: typeof (globalThis as Record<string, unknown>).process,
    bridgeKeys: Object.keys(window.stellio),
  }));
  expect(exposed).toEqual({ require: 'undefined', process: 'undefined', bridgeKeys: ['invoke', 'on'] });
});

test('IPC rejects unknown channels and bad input', async () => {
  const results = await page.evaluate(async () => {
    const bridge = window.stellio as unknown as { invoke: (c: string, i: unknown) => Promise<unknown> };
    return [await bridge.invoke('fs:readAnything', {}), await bridge.invoke('app:ping', { message: 123 })];
  });
  expect(results).toMatchObject([
    { ok: false, error: { code: 'unknown_channel' } },
    { ok: false, error: { code: 'invalid_input' } },
  ]);
});

test('CSP nonce is fresh per load; un-nonced <style> is blocked', async () => {
  const nonce = await page.locator('meta[name="csp-nonce"]').getAttribute('content');
  expect(nonce).toMatch(/^[A-Za-z0-9+/=]{24}$/);
  const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  expect(csp).toContain(`'nonce-${nonce ?? ''}'`);
  const applied = await page.evaluate(() => {
    const s = document.createElement('style');
    s.textContent = 'body { --probe: 1; }';
    document.head.appendChild(s);
    return getComputedStyle(document.body).getPropertyValue('--probe').trim();
  });
  expect(applied).toBe('');

  await page.reload();
  const next = await page.locator('meta[name="csp-nonce"]').getAttribute('content');
  expect(next).toMatch(/^[A-Za-z0-9+/=]{24}$/);
  expect(next).not.toBe(nonce);
  const nextCsp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  expect(nextCsp).toContain(`'nonce-${next ?? ''}'`);
  expect(nextCsp).not.toContain(`'nonce-${nonce ?? ''}'`);
});

test('dialogs, the palette and selects open without CSP violations', async () => {
  const errors: string[] = [];
  const onConsole = (m: ConsoleMessage): void => {
    if (m.type() === 'error') errors.push(m.text());
  };
  page.on('console', onConsole);
  await page.evaluate(() => {
    window.location.hash = '/dev/ui';
  });
  await expect(page.locator('.cm-editor').first()).toBeVisible();

  await page.keyboard.press('Control+k');
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await page.getByRole('button', { name: 'Medium', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Dialog md' })).toBeVisible();
  // A Select inside the dialog: react-remove-scroll injects a <style> on every modal open.
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await page.getByRole('combobox', { name: 'Stage' }).click();
  await expect(page.getByRole('option', { name: 'Applied' })).toBeVisible();
  await page.keyboard.press('Escape');

  page.off('console', onConsole);
  expect(errors.filter((e) => e.includes('Content Security Policy'))).toEqual([]);
  await page.evaluate(() => {
    window.location.hash = '/';
  });
});

test('code editor renders under the production CSP', async () => {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.evaluate(() => {
    window.location.hash = '/dev/ui';
  });
  const editor = page.locator('.cm-editor').first();
  await expect(editor).toBeVisible();
  expect(await editor.evaluate((el) => getComputedStyle(el).display)).toBe('flex');
  expect(errors.filter((e) => e.includes('Content Security Policy'))).toEqual([]);
  await page.evaluate(() => {
    window.location.hash = '/';
  });
});

test('production CSP blocks inline scripts', async () => {
  const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  expect(csp).toContain("script-src 'self'");
  expect(csp).not.toContain('unsafe-inline');
  const ran = await page.evaluate(() => {
    const s = document.createElement('script');
    s.textContent = 'window.__inlineRan = true';
    document.body.appendChild(s);
    return (window as unknown as { __inlineRan?: boolean }).__inlineRan === true;
  });
  expect(ran).toBe(false);
});

test('window.open goes to the OS browser only for safe URLs; navigation is blocked', async () => {
  const before = app.windows().length;
  await page.evaluate(() => {
    window.open('https://example.com/job');
    window.open('file:///etc/passwd');
    window.open('javascript:alert(1)');
    window.location.href = 'https://example.com';
  });
  await page.waitForTimeout(500);
  expect(app.windows().length).toBe(before);
  expect(page.url()).toMatch(/^app:\/\/stellio\/index\.html(#.*)?$/);
  const opened = await app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened);
  expect(opened).toEqual(['https://example.com/job']);
});

test('renderer cannot read local files', async () => {
  const result = await page.evaluate(async () => {
    try {
      const res = await fetch('file:///etc/hostname');
      return `read ${String(res.status)}`;
    } catch {
      return 'blocked';
    }
  });
  expect(result).toBe('blocked');
});

test('app protocol refuses path traversal', async () => {
  const status = await page.evaluate(async () => {
    try {
      return (await fetch('app://stellio/%2e%2e/%2e%2e/%2e%2e/etc/hostname')).status;
    } catch {
      return -1;
    }
  });
  expect([404, -1]).toContain(status);
});
