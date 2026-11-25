import { join } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, Notification, safeStorage, session } from 'electron';
import { IPC_EVENT_PREFIX, IPC_INVOKE } from '@shared/ipc/bridge';
import type { IpcEventName, IpcEvents } from '@shared/ipc/contract';
import { bootstrap, type AppContext } from './bootstrap';
import { dispatch, UserError } from './ipc/dispatch';
import { scanCommand } from './services/discovery/systemd';
import { createHandlers } from './ipc/handlers';
import { hardenAllWebContents } from './platform/hardening';
import { kwalletDisabled, withUserBins } from './platform/desktopEnv';
import { createFileLogger } from './platform/logger';
import { resolvePaths } from './platform/paths';
import { handleAppProtocol, registerAppScheme } from './platform/protocol';
import { APP_ORIGIN, isAppUrl } from './platform/urls';

process.env.PATH = withUserBins(process.env.PATH);
// Must be set before `app.ready`.
if (process.platform === 'linux' && !app.commandLine.hasSwitch('password-store') && kwalletDisabled())
  app.commandLine.appendSwitch('password-store', 'gnome-libsecret');

const paths = resolvePaths({
  defaultUserData: app.getPath('userData'),
  resourcesRoot: app.isPackaged ? process.resourcesPath : app.getAppPath(),
});
app.setPath('userData', paths.userData);
const logger = createFileLogger({
  file: join(paths.logsDir, 'main.log'),
  level: app.isPackaged ? 'info' : 'debug',
  echo: !app.isPackaged,
});
const devUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL || undefined : undefined;

process.on('uncaughtException', (err) => {
  logger.error('uncaught_exception', { error: err.stack ?? err.message });
  app.exit(1); // state is unknown after an uncaught exception; never keep running on it
});
process.on('unhandledRejection', (reason) => logger.error('unhandled_rejection', { error: String(reason) }));

// E2E only: windows hidden behind other windows stop producing frames, which stalls Playwright's
// "stable element" checks at random. Production keeps Chromium's power-saving throttling.
if (process.env.STELLIO_E2E === '1') {
  for (const flag of [
    'disable-backgrounding-occluded-windows',
    'disable-renderer-backgrounding',
    'disable-background-timer-throttling',
  ])
    app.commandLine.appendSwitch(flag);
  // A native Wayland window only gets frame callbacks while the compositor shows it: when it is covered, on
  // another workspace or the screen is off, requestAnimationFrame and CSS animations stop and Playwright waits
  // 30 s on "stable element" / animation `finished`. XWayland windows keep painting.
  app.commandLine.appendSwitch('ozone-platform', 'x11');
  // The GPU process segfaulted at start-up now and then (exit_code=139), which kills the page mid-test.
  app.disableHardwareAcceleration();
}

registerAppScheme();
hardenAllWebContents(logger, devUrl);

// Headless `stellio --scan` (the systemd timer) is a separate process by design: it skips the single-instance
// lock and never opens a window. The scan lock in the DB keeps it from overlapping with the app's own scan.
const headlessScan = process.argv.includes('--scan');
if (headlessScan) {
  void app.whenReady().then(runHeadlessScan).catch(fatal);
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  void app.whenReady().then(start).catch(fatal);
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    title: 'Stellio',
    backgroundColor: '#0B0C0E',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  });

  win.once('ready-to-show', () => win.show());

  // Renderer warnings/errors and crashes land in the main log, so failures are never silent.
  win.webContents.on('console-message', ({ level, message, sourceId, lineNumber }) => {
    if (level === 'warning' || level === 'error') {
      logger[level === 'error' ? 'error' : 'warn']('renderer.console', { message, sourceId, lineNumber });
    }
  });
  win.webContents.on('render-process-gone', (_event, details) =>
    logger.error('renderer.gone', { reason: details.reason, exitCode: details.exitCode }),
  );
  win.webContents.on('did-finish-load', () =>
    logger.info('renderer.loaded', { url: win.webContents.getURL() }),
  );

  void win.loadURL(devUrl ?? `${APP_ORIGIN}/index.html`);
  return win;
}

let ctx: AppContext | undefined;

/** Desktop notification; E2E records it instead of showing a real one. */
function notify(n: { title: string; body: string }): void {
  if (process.env.STELLIO_E2E === '1') {
    const g = globalThis as unknown as { __notifications?: unknown[] };
    (g.__notifications ??= []).push(n);
  } else if (Notification.isSupported()) new Notification(n).show();
}

/** The OS keyring. E2E has none (no desktop session): a reversible stand-in, never used outside tests. */
const secretCrypto =
  process.env.STELLIO_E2E === '1'
    ? {
        isEncryptionAvailable: () => true,
        encryptString: (p: string) => Buffer.from(p, 'utf8').reverse(),
        decryptString: (c: Buffer) => Buffer.from(c).reverse().toString('utf8'),
      }
    : safeStorage;

const timerCommand = (): string[] =>
  scanCommand({
    packaged: app.isPackaged,
    execPath: process.execPath,
    appPath: app.getAppPath(),
    appImage: process.env.APPIMAGE,
  });

/** E2E asks a local stand-in or nobody; dev builds ask only on "Check now". */
const e2eUpdateUrl = process.env.STELLIO_E2E === '1' ? process.env.STELLIO_UPDATE_URL : undefined;
const updates = {
  current: app.getVersion(),
  autoAllowed: process.env.STELLIO_E2E === '1' ? e2eUpdateUrl !== undefined : app.isPackaged,
  ...(e2eUpdateUrl ? { apiUrl: e2eUpdateUrl } : {}),
};

/** `stellio --scan`: one scan, a notification, exit code 0 (done, or another scan already running) or 1. */
async function runHeadlessScan(): Promise<void> {
  let code = 0;
  try {
    logger.info('scan.headless_start', { version: app.getVersion() });
    ctx = await bootstrap(paths, logger, {
      onExternalChange: () => undefined,
      onUsageLimit: () => undefined,
      notify,
      updates,
      secretCrypto,
    });
    const out = await ctx.discovery.runScan({ trigger: 'schedule' });
    logger.info('scan.headless_done', {
      status: out.run.status,
      newJobs: out.run.newJobs,
      strong: out.strong,
    });
    if (out.run.status === 'error') code = 1;
  } catch (e) {
    if (e instanceof UserError) logger.info('scan.headless_skipped', { reason: e.message });
    else {
      code = 1;
      logger.error('scan.headless_failed', {
        error: e instanceof Error ? (e.stack ?? e.message) : String(e),
      });
    }
  }
  ctx?.dispose();
  ctx = undefined;
  // Give the desktop a moment to show the notification before the process ends.
  if (process.env.STELLIO_E2E !== '1') await new Promise((r) => setTimeout(r, 1500));
  app.exit(code);
}

function fatal(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  logger.error('app.fatal', { error: err instanceof Error ? (err.stack ?? message) : message });
  dialog.showErrorBox('Stellio could not start', `${message}\n\nDetails are in ${paths.logsDir}.`);
  app.exit(1);
}

async function start(): Promise<void> {
  logger.info('app.start', { version: app.getVersion(), userData: paths.userData, dataDir: paths.dataDir });
  ctx = await bootstrap(paths, logger, {
    onExternalChange: (relPath) => broadcast('datafolder:changed', { relPath }),
    onUsageLimit: (info) => broadcast('ai:usageLimit', info),
    updates,
    // --- T1 tracker
    notify,
    // --- end T1
    // --- D1 discovery
    secretCrypto,
    scanCommand: timerCommand,
    // --- end D1
  });

  handleAppProtocol(join(__dirname, '../renderer'));

  // Only clipboard writes are allowed (Copy LaTeX, copy-ready apply fields); everything else is denied.
  const allowed = new Set(['clipboard-sanitized-write']);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) =>
    callback(allowed.has(permission)),
  );
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));

  const handlers = createHandlers(ctx, broadcast);
  ipcMain.handle(IPC_INVOKE, (event, channel: unknown, input: unknown) => {
    // Accept calls only from the app's own top-level frame.
    const frame = event.senderFrame;
    if (!frame || frame.parent !== null || !isAppUrl(frame.url, devUrl)) {
      logger.warn('ipc.rejected_sender', { url: frame?.url.slice(0, 200) });
      return { ok: false, error: { code: 'forbidden', message: 'Forbidden' } };
    }
    return dispatch(handlers, channel, input, logger);
  });

  // --- T1 tracker
  const digestMs = Number(process.env.STELLIO_E2E === '1' && process.env.STELLIO_DIGEST_INTERVAL_MS);
  ctx.digest.start(digestMs > 0 ? digestMs : undefined);
  // --- end T1
  // Never-contacted people past their retention are deleted at start and daily (docs/14 §1).
  ctx.referrals.start();
  // --- D1 discovery
  // E2E opts in: a catch-up scan on launch would hit the real network.
  if (process.env.STELLIO_E2E !== '1' || process.env.STELLIO_SCHEDULER === '1')
    ctx.discovery.scheduler.start();
  // --- end D1

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

function broadcast<E extends IpcEventName>(event: E, payload: IpcEvents[E]): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(IPC_EVENT_PREFIX + event, payload);
}

app.on('will-quit', () => {
  ctx?.dispose();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
