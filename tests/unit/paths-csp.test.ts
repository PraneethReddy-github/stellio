import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolvePaths } from '../../src/main/platform/paths';
import { buildCsp, CSP_NONCE_TOKEN, stampNonce } from '../../src/shared/csp';

const inputs = { defaultUserData: '/u', resourcesRoot: '/app' };

describe('resolvePaths', () => {
  it('uses defaults', () => {
    expect(resolvePaths(inputs, {})).toEqual({
      userData: '/u',
      dataDir: join(homedir(), 'Stellio'),
      logsDir: '/u/logs',
      seedDir: '/app/seed',
      aiCwd: '/u/ai-cwd',
    });
  });
  it('honours test overrides', () => {
    expect(resolvePaths(inputs, { STELLIO_USER_DATA: '/t/u', STELLIO_DATA_DIR: '/t/d' })).toMatchObject({
      userData: '/t/u',
      dataDir: '/t/d',
      logsDir: '/t/u/logs',
      aiCwd: '/t/u/ai-cwd',
    });
  });
});

describe('buildCsp', () => {
  it('is strict in production', () => {
    const csp = buildCsp(false);
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).toContain("object-src 'none'");
  });
  it('relaxes only what HMR needs in dev', () => {
    const csp = buildCsp(true);
    expect(csp).toContain('ws://localhost:*');
    expect(csp).not.toContain('unsafe-eval');
  });
});

describe('stampNonce', () => {
  it('replaces every token occurrence', () => {
    const html = `<meta content="${buildCsp(false)}"><meta name="csp-nonce" content="${CSP_NONCE_TOKEN}">`;
    const out = stampNonce(html, 'AbCdEfGhIjKlMnOpQrSt');
    expect(out).not.toContain(CSP_NONCE_TOKEN);
    expect(out.match(/AbCdEfGhIjKlMnOpQrSt/g)).toHaveLength(2);
    expect(out).toContain("style-src 'self' 'nonce-AbCdEfGhIjKlMnOpQrSt'");
  });
  it('rejects nonces that could break out of the attribute', () => {
    expect(() => stampNonce('x', 'short')).toThrow();
    expect(() => stampNonce('x', '"><script>alert(1)</script>')).toThrow();
  });
});
