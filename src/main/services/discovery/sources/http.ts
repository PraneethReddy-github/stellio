import type { NormalizedJob, SearchProfile } from '@shared/discovery/schemas';
import { FetchError, guardedFetch, type Fetcher } from '../../jobs/net';

/** Error whose message is safe to store and show: it never carries a URL or a key. */
export class SourceError extends Error {
  override name = 'SourceError';
}

export interface SourceCtx {
  profile: SearchProfile;
  since: Date;
  signal: AbortSignal;
  /** Rate-limited, host-pinned GET that returns parsed JSON. */
  getJson(url: string, headers?: Record<string, string>): Promise<unknown>;
  /** Most raw items an adapter may yield for this profile. */
  limit: number;
  /** True when the source already stored this posting (skips detail requests). */
  isKnown(externalId: string): boolean;
  /** Requests for per-posting details this scan may still make. */
  detailBudget: { left: number };
  secret?: { appId: string; appKey: string };
}

export interface SourceAdapter {
  id: 'adzuna' | 'arbeitnow' | 'ba' | 'remotive' | 'remoteok' | 'himalayas' | 'watchlist';
  label: string;
  needsKey: boolean;
  rateLimit: { rps: number; burst: number };
  /** False = one fetch for all profiles; a job then has to fit any enabled profile. */
  perProfile: boolean;
  /** The source cannot search: titles are checked against the wanted roles in code. */
  queryless: boolean;
  applies(p: SearchProfile): boolean;
  search(ctx: SourceCtx): AsyncIterable<unknown>;
  /** zod-validated; throws on a malformed item (the pipeline counts it and moves on). */
  normalize(raw: unknown): NormalizedJob;
}

/** Tests only: `STELLIO_SOURCE_URLS='{"arbeitnow":"http://127.0.0.1:1234"}'` redirects an adapter's host. */
export function baseUrl(id: string, fallback: string, env: NodeJS.ProcessEnv = process.env): string {
  if (env.STELLIO_ALLOW_LOOPBACK_FETCH !== '1' || !env.STELLIO_SOURCE_URLS) return fallback;
  try {
    const v = (JSON.parse(env.STELLIO_SOURCE_URLS) as Record<string, unknown>)[id];
    return typeof v === 'string' ? v.replace(/\/$/, '') : fallback;
  } catch {
    return fallback;
  }
}

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;
export const sleep: Sleep = (ms, signal) =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });

/** Token bucket: `acquire` resolves when a request may go out. */
export function createLimiter(
  { rps, burst }: { rps: number; burst: number },
  wait: Sleep = sleep,
  now: () => number = Date.now,
) {
  let tokens = burst;
  let last = now();
  return async (signal?: AbortSignal): Promise<void> => {
    for (;;) {
      const t = now();
      tokens = Math.min(burst, tokens + ((t - last) * rps) / 1000);
      last = t;
      if (tokens >= 1) {
        tokens -= 1;
        return;
      }
      if (signal?.aborted) return;
      await wait(Math.ceil(((1 - tokens) * 1000) / rps), signal);
    }
  };
}

export function createGetJson(opts: {
  fetcher?: Fetcher;
  limiter: (signal?: AbortSignal) => Promise<void>;
  signal: AbortSignal;
}): SourceCtx['getJson'] {
  const fetcher = opts.fetcher ?? guardedFetch;
  return async (url, headers) => {
    await opts.limiter(opts.signal);
    if (opts.signal.aborted) throw new SourceError('cancelled');
    let res;
    try {
      res = await fetcher(url, {
        signal: opts.signal,
        accept: 'application/json',
        allowedHosts: [new URL(url).hostname],
        headers,
      });
    } catch (e) {
      // FetchError messages are user-safe and carry no URL.
      throw new SourceError(e instanceof FetchError ? e.message : 'request failed');
    }
    if (res.status === 429) throw new SourceError('rate limited (HTTP 429)');
    if (res.status === 401 || res.status === 403)
      throw new SourceError(`access refused (HTTP ${String(res.status)})`);
    if (res.status !== 200) throw new SourceError(`HTTP ${String(res.status)}`);
    try {
      return JSON.parse(res.body) as unknown;
    } catch {
      throw new SourceError('the answer was not JSON');
    }
  };
}

/** Unix seconds, ISO text or `YYYY-MM-DDTHH:MM:SS` (UTC) to ISO; null when unusable. */
export function toIso(v: string | number | null | undefined): string | null {
  if (v === null || v === undefined || v === '') return null;
  const naive = typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?$/.test(v) ? `${v}Z` : v;
  const d = new Date(typeof naive === 'number' ? naive * 1000 : naive);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Free-text contract type to the enum the job table uses. */
export function employmentFrom(text: string | null | undefined): NormalizedJob['employmentType'] {
  const t = (text ?? '').toLowerCase().replace(/[_-]/g, ' ');
  if (/part ?time|teilzeit/.test(t)) return 'part_time';
  if (/full ?time|vollzeit|permanent/.test(t)) return 'full_time';
  if (/intern|praktik|werkstudent/.test(t)) return 'internship';
  if (/contract|contractor|befrist/.test(t)) return 'contract';
  if (/freelanc/.test(t)) return 'freelance';
  if (/temp/.test(t)) return 'temporary';
  return null;
}

/** Common empty shape: an adapter overrides what its source states. */
export const blankJob = (source: string): Omit<NormalizedJob, 'externalId' | 'title' | 'company'> => ({
  source,
  url: null,
  applyUrl: null,
  locationText: null,
  city: null,
  country: null,
  remote: 'unknown',
  employmentType: null,
  seniority: null,
  salaryMin: null,
  salaryMax: null,
  salaryCurrency: null,
  salaryPeriod: null,
  postedAt: null,
  descriptionMd: '',
  tags: [],
});
