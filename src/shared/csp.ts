/** Placeholder the app:// handler replaces with a fresh random nonce on every page load. */
export const CSP_NONCE_TOKEN = '__STELLIO_CSP_NONCE__';

/**
 * Content-Security-Policy for the renderer.
 * Production allows only bundled scripts. Styles: bundled files plus <style> elements carrying the
 * per-load nonce (CodeMirror injects its styles that way). Dev adds what Vite HMR needs.
 */
export function buildCsp(dev: boolean, nonce: string = CSP_NONCE_TOKEN): string {
  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    'script-src': dev ? ["'self'", "'unsafe-inline'"] : ["'self'"],
    'style-src': dev ? ["'self'", "'unsafe-inline'"] : ["'self'", `'nonce-${nonce}'`],
    'img-src': ["'self'", 'data:'],
    'font-src': ["'self'"],
    'connect-src': dev ? ["'self'", 'ws://localhost:*', 'http://localhost:*'] : ["'self'"],
    'object-src': ["'none'"],
    'base-uri': ["'none'"],
    'form-action': ["'none'"],
    'frame-src': ["'none'"],
  };
  return Object.entries(directives)
    .map(([key, values]) => `${key} ${values.join(' ')}`)
    .join('; ');
}

/** Stamps a nonce into the built index.html (CSP meta + the `csp-nonce` meta the renderer reads). */
export function stampNonce(html: string, nonce: string): string {
  if (!/^[A-Za-z0-9+/=]{16,}$/.test(nonce)) throw new Error('invalid nonce');
  return html.replaceAll(CSP_NONCE_TOKEN, nonce);
}
