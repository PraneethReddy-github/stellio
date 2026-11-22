import { join, normalize, sep } from 'node:path';

/** Origin the production renderer is served from (see protocol.ts). */
export const APP_SCHEME = 'app';
export const APP_ORIGIN = 'app://stellio';

/** Links the renderer may hand to the OS browser. */
export function isSafeExternalUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === 'https:' || protocol === 'http:' || protocol === 'mailto:';
  } catch {
    return false;
  }
}

/** True when `url` belongs to the app's own renderer (prod app:// origin, or the dev server). */
export function isAppUrl(url: string, devUrl?: string): boolean {
  try {
    const u = new URL(url);
    if (`${u.protocol}//${u.host}` === APP_ORIGIN) return true;
    if (devUrl) return u.origin === new URL(devUrl).origin;
    return false;
  } catch {
    return false;
  }
}

/**
 * Maps an app:// request URL to a file inside `rootDir`. Returns null for other hosts and for
 * any path that would escape `rootDir` (traversal, encoded separators).
 */
export function resolveAppAsset(rootDir: string, url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (`${u.protocol}//${u.host}` !== APP_ORIGIN) return null;
  let pathname: string;
  try {
    pathname = decodeURIComponent(u.pathname);
  } catch {
    return null;
  }
  if (pathname.includes('\0')) return null;
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const root = normalize(rootDir);
  const file = normalize(join(root, rel));
  return file.startsWith(root.endsWith(sep) ? root : root + sep) ? file : null;
}
