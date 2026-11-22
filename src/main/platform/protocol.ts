import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { net, protocol } from 'electron';
import { stampNonce } from '@shared/csp';
import { APP_SCHEME, resolveAppAsset } from './urls';

/** Must run before `app.ready`. Serving from app:// instead of file:// denies the renderer file:// reads. */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);
}

/** Serves only files under `rendererDir`. HTML pages get a fresh CSP nonce per load. */
export function handleAppProtocol(rendererDir: string): void {
  protocol.handle(APP_SCHEME, async (request) => {
    const file = resolveAppAsset(rendererDir, request.url);
    if (!file) return new Response('Not found', { status: 404 });
    if (file.endsWith('.html')) {
      const html = stampNonce(await readFile(file, 'utf8'), randomBytes(18).toString('base64'));
      return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    return net.fetch(pathToFileURL(file).toString());
  });
}
