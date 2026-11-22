import { app, shell } from 'electron';
import type { Logger } from './logger';
import { isAppUrl, isSafeExternalUrl } from './urls';

/**
 * Applies to every webContents the app ever creates (windows, future PDF previews):
 * no navigation away from the app, no new windows, no <webview>; external links go to the OS browser.
 */
export function hardenAllWebContents(logger: Logger, devUrl?: string): void {
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      if (isSafeExternalUrl(url)) void shell.openExternal(url);
      else logger.warn('security.window_open_blocked', { url: url.slice(0, 200) });
      return { action: 'deny' };
    });
    contents.on('will-navigate', (event, url) => {
      if (!isAppUrl(url, devUrl)) event.preventDefault();
    });
    contents.on('will-redirect', (event, url) => {
      if (!isAppUrl(url, devUrl)) event.preventDefault();
    });
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });
}
