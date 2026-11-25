import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';

export interface Launched {
  app: ElectronApplication;
  page: Page;
  sandbox: string;
  dataDir: string;
  close(): Promise<void>;
}

/**
 * Launches the built app against a throwaway userData + data folder.
 * STELLIO_E2E_EXECUTABLE=release/linux-unpacked/stellio runs the same tests against the packaged app.
 */
export async function launchApp(extraEnv: Record<string, string> = {}): Promise<Launched> {
  const sandbox = mkdtempSync(join(tmpdir(), 'stellio-e2e-'));
  const dataDir = join(sandbox, 'data');
  const executablePath = process.env.STELLIO_E2E_EXECUTABLE;
  const app = await electron.launch({
    ...(executablePath ? { executablePath, args: [] } : { args: ['.'] }),
    env: {
      ...process.env,
      STELLIO_USER_DATA: join(sandbox, 'userData'),
      STELLIO_DATA_DIR: dataDir,
      // The scan timer's unit files live here: never read or write the user's own.
      XDG_CONFIG_HOME: join(sandbox, 'config'),
      ELECTRON_RENDERER_URL: '',
      STELLIO_E2E: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      ...extraEnv,
    },
  });
  // An app that dies mid-test otherwise shows up only as "Target page, context or browser has been closed".
  // Remember how it ended and print its log tail, so the cause is in the report.
  let exitInfo: string | null = null;
  app.process().once('exit', (code, signal) => {
    exitInfo = `code=${String(code)} signal=${String(signal)}`;
  });
  const page = await app.firstWindow();
  // Never open the real OS browser from tests; record what would have been opened.
  await app.evaluate(({ shell }) => {
    const opened: string[] = [];
    (globalThis as unknown as { __opened: string[] }).__opened = opened;
    shell.openExternal = (url: string) => {
      opened.push(url);
      return Promise.resolve();
    };
  });
  return {
    app,
    page,
    sandbox,
    dataDir,
    close: async () => {
      const log = join(sandbox, 'userData', 'logs', 'main.log');
      const fatal = existsSync(log)
        ? readFileSync(log, 'utf8')
            .split('\n')
            .filter((l) => /renderer\.gone|uncaught_exception|unhandled_rejection|app\.fatal/.test(l))
        : [];
      if (fatal.length > 0) console.error(`[e2e] main.log recorded a crash:\n${fatal.join('\n')}`);
      if (exitInfo !== null) {
        const tail = existsSync(log)
          ? readFileSync(log, 'utf8').trim().split('\n').slice(-12).join('\n')
          : '(no log)';
        console.error(`[e2e] the app exited before the test ended (${exitInfo}). main.log tail:\n${tail}`);
      }
      await app.close().catch(() => undefined);
      rmSync(sandbox, { recursive: true, force: true });
    },
  };
}

/** Calls an IPC channel from the renderer, exactly as the UI would. */
export function invoke(page: Page, channel: string, input?: unknown): Promise<unknown> {
  return page.evaluate(
    ([c, i]) =>
      (window.stellio as unknown as { invoke: (c: string, i: unknown) => Promise<unknown> }).invoke(c, i),
    [channel, input] as const,
  );
}
