import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { Readable } from 'node:stream';
import zlib from 'node:zlib';
import { CANCELLED_MESSAGE } from '@shared/messages';

export const MAX_BYTES = 5 * 1024 * 1024;
export const TIMEOUT_MS = 15_000;
export const MAX_REDIRECTS = 5;
const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

export type FetchErrorKind =
  'scheme' | 'blocked' | 'timeout' | 'too_large' | 'redirects' | 'type' | 'network' | 'aborted';
/** Message is safe to show to the user. */
export class FetchError extends Error {
  override name = 'FetchError';
  constructor(
    message: string,
    readonly kind: FetchErrorKind,
  ) {
    super(message);
  }
}

export interface FetchOpts {
  signal?: AbortSignal;
  accept?: string;
  /** When set, every hop (redirects included) must be on one of these hosts. */
  allowedHosts?: readonly string[];
  /** Extra request headers (a public client id); never logged. */
  headers?: Record<string, string>;
}
export interface FetchResult {
  status: number;
  finalUrl: string;
  contentType: string;
  body: string;
}
export type Fetcher = (url: string, opts?: FetchOpts) => Promise<FetchResult>;

const blocked = new net.BlockList();
for (const [addr, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  blocked.addSubnet(addr, prefix, 'ipv4');
for (const [addr, prefix] of [
  ['::', 96], // unspecified and IPv4-compatible (deprecated)
  ['64:ff9b::', 96], // NAT64
  ['64:ff9b:1::', 48], // local-use NAT64
  ['100::', 64], // discard-only
  ['2001::', 32], // Teredo
  ['2002::', 16], // 6to4
  ['fec0::', 10], // site-local (deprecated)
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
  ['2001:db8::', 32],
] as const)
  blocked.addSubnet(addr, prefix, 'ipv6');

const mapped = new net.BlockList();
mapped.addSubnet('::ffff:0:0', 96, 'ipv6');

/** `::ffff:a.b.c.d` in any spelling → `a.b.c.d`; the URL parser canonicalizes it to `::ffff:hhhh:hhhh`. */
function unmapIPv4(ip: string): string | null {
  try {
    const m = /^\[::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$/.exec(new URL(`http://[${ip}]`).hostname);
    if (!m) return null;
    const n = (parseInt(m[1] ?? '', 16) << 16) | parseInt(m[2] ?? '', 16);
    return [24, 16, 8, 0].map((sh) => String((n >>> sh) & 255)).join('.');
  } catch {
    return null;
  }
}

/** False for loopback, private, link-local, multicast and other non-public addresses. */
export function isPublicAddress(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 0) return false;
  if (family === 6 && mapped.check(ip, 'ipv6')) {
    const v4 = unmapIPv4(ip);
    return v4 !== null && isPublicAddress(v4);
  }
  if (family === 4 ? ip.startsWith('127.') : ip === '::1')
    return process.env.STELLIO_ALLOW_LOOPBACK_FETCH === '1'; // tests only
  return !blocked.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

/** The link if it is http(s), else null: only those may be stored as a job's links (and later opened). */
export function httpUrlOrNull(u: string | null | undefined): string | null {
  if (!u) return null;
  try {
    const { protocol } = new URL(u);
    return protocol === 'http:' || protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

/** Scheme, credentials and literal-IP checks. Names are checked when they resolve (see `guardedLookup`). */
export function assertFetchable(url: URL): void {
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new FetchError('Only http and https links can be fetched.', 'scheme');
  if (url.username || url.password)
    throw new FetchError('Links with a username or password are not allowed.', 'scheme');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) !== 0 && !isPublicAddress(host))
    throw new FetchError('That address is not on the public internet.', 'blocked');
}

/** Validates every resolved address at connect time, so a DNS answer cannot change between check and use. */
const guardedLookup: net.LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return callback(err, '', 0);
    if (addrs.length === 0 || addrs.some((a) => !isPublicAddress(a.address)))
      return callback(new FetchError('That address is not on the public internet.', 'blocked'), '', 0);
    // `all: true` was forced above, so answer in whichever shape the caller asked for.
    if (options.all) return callback(null, addrs);
    const first = addrs[0];
    callback(null, first?.address ?? '', first?.family ?? 4);
  });
};

const decoderFor = (
  encoding: string | undefined,
): zlib.Gunzip | zlib.Inflate | zlib.BrotliDecompress | null => {
  switch ((encoding ?? '').trim().toLowerCase()) {
    case 'gzip':
    case 'x-gzip':
      return zlib.createGunzip();
    case 'deflate':
      return zlib.createInflate();
    case 'br':
      return zlib.createBrotliDecompress();
    default:
      return null;
  }
};

const ALLOWED_TYPES = /^(text\/html|application\/xhtml\+xml|application\/json|text\/plain)\b/i;

async function readBody(res: http.IncomingMessage): Promise<Buffer> {
  const declared = Number(res.headers['content-length']);
  if (declared > MAX_BYTES) throw new FetchError('That page is larger than 5 MB.', 'too_large');
  let stream: Readable = res;
  const decoder = decoderFor(res.headers['content-encoding']);
  if (decoder) {
    res.on('error', (e) => decoder.destroy(e));
    stream = res.pipe(decoder);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BYTES) {
      res.destroy();
      throw new FetchError('That page is larger than 5 MB.', 'too_large');
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function requestOnce(
  url: URL,
  accept: string,
  signal: AbortSignal,
  extra?: Record<string, string>,
): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(
      url,
      {
        method: 'GET',
        lookup: guardedLookup,
        agent: false,
        signal,
        headers: {
          'User-Agent': USER_AGENT,
          Accept: accept,
          'Accept-Language': 'en,de;q=0.8',
          'Accept-Encoding': 'gzip, deflate, br',
          ...extra,
        },
      },
      resolve,
    );
    req.on('error', reject);
    req.end();
  });
}

/**
 * GET with: http/https only, public addresses only, ≤ 5 redirects (each hop re-validated), 15 s overall,
 * 5 MB cap (after decompression). Never runs page scripts: it only returns text.
 */
export const guardedFetch: Fetcher = async (rawUrl, opts = {}) => {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  try {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new FetchError('That is not a valid link.', 'scheme');
    }
    for (let hops = 0; ; hops++) {
      assertFetchable(url);
      if (opts.allowedHosts && !opts.allowedHosts.includes(url.hostname))
        throw new FetchError('Redirected to a host that is not allowed.', 'blocked');
      const res = await requestOnce(
        url,
        opts.accept ?? 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.5',
        signal,
        opts.headers,
      );
      const status = res.statusCode ?? 0;
      const location = res.headers.location;
      if (status >= 300 && status < 400 && location) {
        res.resume();
        if (hops >= MAX_REDIRECTS) throw new FetchError('Too many redirects.', 'redirects');
        try {
          url = new URL(location, url);
        } catch {
          throw new FetchError('The page redirected to an invalid link.', 'redirects');
        }
        continue;
      }
      const contentType = res.headers['content-type'] ?? '';
      if (contentType && !ALLOWED_TYPES.test(contentType)) {
        res.destroy();
        throw new FetchError('That link is not a web page (unsupported content type).', 'type');
      }
      const buf = await readBody(res);
      const charset = /charset=["']?([\w-]+)/i.exec(contentType)?.[1] ?? 'utf-8';
      let body: string;
      try {
        body = new TextDecoder(charset).decode(buf);
      } catch {
        body = new TextDecoder('utf-8').decode(buf);
      }
      return { status, finalUrl: url.toString(), contentType, body };
    }
  } catch (e) {
    if (e instanceof FetchError) throw e;
    if (opts.signal?.aborted) throw new FetchError(CANCELLED_MESSAGE, 'aborted');
    if (timeout.aborted) throw new FetchError('The page took longer than 15 seconds to respond.', 'timeout');
    // A lookup rejected by guardedLookup surfaces as the original error.
    if (e instanceof Error && 'cause' in e && e.cause instanceof FetchError) throw e.cause;
    throw new FetchError(
      `Could not load the page (${e instanceof Error ? e.message : String(e)}).`,
      'network',
    );
  }
};
