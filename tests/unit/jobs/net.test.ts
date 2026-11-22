import http from 'node:http';
import type { AddressInfo } from 'node:net';
import zlib from 'node:zlib';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  assertFetchable,
  FetchError,
  guardedFetch,
  isPublicAddress,
} from '../../../src/main/services/jobs/net';

let server: http.Server;
let base: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname;
    if (path === '/ok') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<h1>Hello Zürich</h1>');
    } else if (path === '/gzip') {
      res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Encoding': 'gzip' });
      res.end(zlib.gzipSync('<p>zipped</p>'));
    } else if (path === '/bomb') {
      res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Encoding': 'gzip' });
      res.end(zlib.gzipSync(Buffer.alloc(8 * 1024 * 1024, 'a'))); // 8 MB inflated from a few KB
    } else if (path === '/big') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(Buffer.alloc(6 * 1024 * 1024, 'a'));
    } else if (path === '/pdf') {
      res.writeHead(200, { 'Content-Type': 'application/pdf' });
      res.end('%PDF');
    } else if (path === '/hop') {
      const n = Number(url.searchParams.get('n') ?? '0');
      res.writeHead(302, { Location: n > 0 ? `/hop?n=${String(n - 1)}` : '/ok' });
      res.end();
    } else if (path === '/to-file') {
      res.writeHead(302, { Location: 'file:///etc/passwd' });
      res.end();
    } else if (path === '/to-private') {
      res.writeHead(302, { Location: 'http://10.0.0.1/secret' });
      res.end();
    } else if (path === '/slow') {
      setTimeout(() => res.end('late'), 5000);
    } else if (path === '/latin1') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=iso-8859-1' });
      res.end(Buffer.from('K\xf6ln', 'latin1'));
    } else {
      res.writeHead(404).end('nope');
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});
afterEach(() => {
  delete process.env.STELLIO_ALLOW_LOOPBACK_FETCH;
});

const allowLoopback = () => {
  process.env.STELLIO_ALLOW_LOOPBACK_FETCH = '1';
};
const kind = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'resolved';
  } catch (e) {
    return e instanceof FetchError ? e.kind : `other:${String(e)}`;
  }
};

describe('isPublicAddress', () => {
  it.each(['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111'])('%s is public', (ip) => {
    expect(isPublicAddress(ip)).toBe(true);
  });
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    'fe80::1',
    'fc00::1',
    'fd12:3456::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:10.0.0.1',
    '0:0:0:0:0:ffff:7f00:1', // mapped loopback, not written with the ::ffff: prefix
    '0::ffff:a9fe:a9fe', // mapped 169.254.169.254
    '::7f00:1', // IPv4-compatible ::/96
    '::8.8.8.8',
    '2002:7f00:1::', // 6to4
    '2001:0:4136:e378::1', // Teredo
    '64:ff9b::a00:1', // NAT64
    '64:ff9b:1::1', // local-use NAT64
    '100::1', // discard-only
    'fec0::1', // site-local
    'not an ip',
  ])('%s is not public', (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });
  it('unwraps an IPv4-mapped address and judges the IPv4 inside', () => {
    expect(isPublicAddress('::ffff:8.8.8.8')).toBe(true);
    expect(isPublicAddress('0:0:0:0:0:ffff:808:808')).toBe(true);
  });
  it('allows only loopback (not private ranges) with STELLIO_ALLOW_LOOPBACK_FETCH=1', () => {
    allowLoopback();
    expect(isPublicAddress('127.0.0.1')).toBe(true);
    expect(isPublicAddress('::1')).toBe(true);
    expect(isPublicAddress('10.0.0.1')).toBe(false);
    expect(isPublicAddress('169.254.169.254')).toBe(false);
  });
});

describe('assertFetchable', () => {
  it.each([
    'file:///etc/passwd',
    'ftp://example.com/x',
    'javascript:alert(1)',
    'data:text/html,hi',
    'gopher://x',
  ])('rejects scheme in %s', (u) => {
    expect(() => assertFetchable(new URL(u))).toThrow(FetchError);
  });
  it.each([
    'http://127.0.0.1/',
    'http://localhost:1/', // resolved later, at connect time
    'http://[::1]/',
    'http://169.254.169.254/latest/meta-data',
    'http://2130706433/', // decimal form of 127.0.0.1: the URL parser normalises it
    'http://0x7f.1/',
    'http://user:pw@example.com/',
  ])('rejects %s', async (u) => {
    if (u.includes('localhost')) return expect(await kind(guardedFetch(u))).toBe('blocked');
    expect(() => assertFetchable(new URL(u))).toThrow(FetchError);
  });
});

describe('guardedFetch', () => {
  it('blocks loopback by default, including through a hostname', async () => {
    expect(await kind(guardedFetch(`${base}/ok`))).toBe('blocked');
    expect(await kind(guardedFetch(base.replace('127.0.0.1', 'localhost') + '/ok'))).toBe('blocked');
  });

  it('fetches text, decodes the declared charset', async () => {
    allowLoopback();
    const r = await guardedFetch(`${base}/ok`);
    expect(r).toMatchObject({ status: 200, body: '<h1>Hello Zürich</h1>' });
    expect((await guardedFetch(`${base}/latin1`)).body).toBe('Köln');
    expect((await guardedFetch(`${base}/missing`)).status).toBe(404);
  });

  it('decompresses gzip', async () => {
    allowLoopback();
    expect((await guardedFetch(`${base}/gzip`)).body).toBe('<p>zipped</p>');
  });

  it('caps the body at 5 MB, also after decompression', async () => {
    allowLoopback();
    expect(await kind(guardedFetch(`${base}/big`))).toBe('too_large');
    expect(await kind(guardedFetch(`${base}/bomb`))).toBe('too_large');
  });

  it('rejects non-page content types', async () => {
    allowLoopback();
    expect(await kind(guardedFetch(`${base}/pdf`))).toBe('type');
  });

  it('follows up to 5 redirects, not 6', async () => {
    allowLoopback();
    expect((await guardedFetch(`${base}/hop?n=4`)).body).toContain('Hello');
    expect(await kind(guardedFetch(`${base}/hop?n=5`))).toBe('redirects');
  });

  it('re-validates scheme and address on every hop', async () => {
    allowLoopback();
    expect(await kind(guardedFetch(`${base}/to-file`))).toBe('scheme');
    expect(await kind(guardedFetch(`${base}/to-private`))).toBe('blocked');
  });

  it('restricts every hop to allowedHosts', async () => {
    allowLoopback();
    expect(await kind(guardedFetch(`${base}/hop?n=1`, { allowedHosts: ['api.example.com'] }))).toBe(
      'blocked',
    );
  });

  it('can be cancelled', async () => {
    allowLoopback();
    const ctl = new AbortController();
    const p = guardedFetch(`${base}/slow`, { signal: ctl.signal });
    setTimeout(() => ctl.abort(), 100);
    expect(await kind(p)).toBe('aborted');
  });

  it('rejects invalid links', async () => {
    expect(await kind(guardedFetch('not a url'))).toBe('scheme');
  });
});
