import { describe, expect, it } from 'vitest';
import { isAppUrl, isSafeExternalUrl, resolveAppAsset } from '../../src/main/platform/urls';

describe('isSafeExternalUrl', () => {
  it.each(['https://example.com', 'http://example.com/x?y=1', 'mailto:a@b.c'])('allows %s', (u) => {
    expect(isSafeExternalUrl(u)).toBe(true);
  });
  it.each([
    'file:///etc/passwd',
    'javascript:alert(1)',
    'smb://host/share',
    'app://stellio/x',
    'not a url',
    '',
  ])('rejects %s', (u) => {
    expect(isSafeExternalUrl(u)).toBe(false);
  });
});

describe('isAppUrl', () => {
  it('accepts the app origin and the dev server only', () => {
    expect(isAppUrl('app://stellio/index.html')).toBe(true);
    expect(isAppUrl('app://other/index.html')).toBe(false);
    expect(isAppUrl('http://localhost:5173/', 'http://localhost:5173')).toBe(true);
    expect(isAppUrl('http://localhost:5173/')).toBe(false);
    expect(isAppUrl('http://localhost:9999/', 'http://localhost:5173')).toBe(false);
    expect(isAppUrl('file:///x')).toBe(false);
    expect(isAppUrl('garbage')).toBe(false);
  });
});

describe('resolveAppAsset', () => {
  const root = '/app/out/renderer';
  it('maps app paths into the root', () => {
    expect(resolveAppAsset(root, 'app://stellio/')).toBe('/app/out/renderer/index.html');
    expect(resolveAppAsset(root, 'app://stellio/assets/a.js')).toBe('/app/out/renderer/assets/a.js');
  });
  it.each(['app://stellio/../../etc/passwd', 'app://stellio/%2e%2e/%2e%2e/etc/passwd'])(
    'keeps dot-segment URLs inside the root (%s)',
    (u) => {
      expect(resolveAppAsset(root, u)).toBe('/app/out/renderer/etc/passwd');
    },
  );
  it.each([
    'app://stellio/assets/..%2f..%2f..%2fetc%2fpasswd',
    'app://stellio/a%00b',
    'app://stellio/%E0%A4%A',
    'app://evil/index.html',
    'file:///etc/passwd',
  ])('refuses %s', (u) => {
    expect(resolveAppAsset(root, u)).toBeNull();
  });
});
