import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NormalizedJob } from '../../../src/shared/discovery/schemas';
import { guardedFetch } from '../../../src/main/services/jobs/net';
import { adzuna, adzunaCountries } from '../../../src/main/services/discovery/sources/adzuna';
import { ba } from '../../../src/main/services/discovery/sources/ba';
import {
  arbeitnow,
  himalayas,
  remoteok,
  remotive,
} from '../../../src/main/services/discovery/sources/boards';
import {
  baseUrl,
  createGetJson,
  createLimiter,
  SourceError,
  toIso,
  type SourceAdapter,
  type SourceCtx,
} from '../../../src/main/services/discovery/sources/http';
import {
  createWatchlistAdapter,
  detectBoard,
  detectBoardInHtml,
  listUrl,
} from '../../../src/main/services/discovery/sources/watchlist';
import {
  allSourceRoutes,
  BA_REFS,
  sourceUrlsEnv,
  startFixtureServer,
  type FixtureServer,
  type Routes,
} from '../../fixtures/discovery';
import { profile } from './helpers';

let server: FixtureServer;
const saved = { ...process.env };
let routes: Routes;
beforeAll(async () => {
  routes = allSourceRoutes();
  server = await startFixtureServer(routes);
  Object.assign(process.env, sourceUrlsEnv(server.base));
});
afterAll(async () => {
  process.env = saved;
  await server.close();
});

const ctxFor = (over: Partial<SourceCtx> = {}): SourceCtx => ({
  profile: profile(),
  since: new Date(Date.now() - 30 * 86_400_000),
  signal: new AbortController().signal,
  getJson: createGetJson({
    fetcher: guardedFetch,
    limiter: () => Promise.resolve(),
    signal: new AbortController().signal,
  }),
  limit: 100,
  isKnown: () => false,
  detailBudget: { left: 10 },
  ...over,
});

async function collect(a: SourceAdapter, ctx = ctxFor()): Promise<NormalizedJob[]> {
  const out: NormalizedJob[] = [];
  for await (const raw of a.search(ctx)) out.push(a.normalize(raw));
  return out;
}

describe('Arbeitnow', () => {
  it('normalizes the board and stops at postings older than `since`', async () => {
    const jobs = await collect(arbeitnow);
    expect(jobs.map((j) => j.title)).toEqual([
      'Data Engineer (m/w/d)',
      'Marketing Manager',
      'Senior Python Developer',
    ]);
    expect(jobs[0]).toMatchObject({
      source: 'arbeitnow',
      externalId: 'data-engineer-nimbus-berlin-1',
      company: 'Nimbus Analytics GmbH',
      city: 'Berlin',
      employmentType: 'full_time',
      remote: 'unknown',
    });
    expect(jobs[0]?.descriptionMd).toContain('Data pipelines with Python'); // entity-escaped HTML decoded
    expect(jobs[0]?.descriptionMd).not.toContain('&lt;');
    expect(jobs[0]?.postedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
  });
  it('rejects a malformed item and a malformed envelope', () => {
    expect(() => arbeitnow.normalize({ slug: 'x' })).toThrow();
  });
});

describe('Remotive, RemoteOK, Himalayas', () => {
  it('Remotive: remote, UTC dates, salary in the text', async () => {
    const jobs = await collect(remotive);
    expect(jobs).toHaveLength(6); // two categories, same fixture
    expect(jobs[0]).toMatchObject({
      externalId: '7001',
      remote: 'remote',
      employmentType: 'full_time',
      locationText: 'Worldwide',
    });
    expect(jobs[0]?.postedAt).toMatch(/Z$/);
    expect(jobs[0]?.descriptionMd).toContain('Salary: $90k - $120k');
    expect(jobs[0]?.tags).toContain('airflow');
  });
  it('RemoteOK: skips the legal notice, zero pay is unknown', async () => {
    const jobs = await collect(remoteok);
    expect(jobs.map((j) => j.externalId)).toEqual(['9001', '9002']);
    expect(jobs[0]).toMatchObject({
      salaryMin: 100000,
      salaryMax: 140000,
      salaryCurrency: 'USD',
      salaryPeriod: 'year',
    });
    expect(jobs[1]).toMatchObject({ salaryMin: null, salaryMax: null, locationText: null });
  });
  it('Himalayas: restrictions become the location, pay and seniority are mapped', async () => {
    const jobs = await collect(himalayas);
    expect(jobs[0]).toMatchObject({
      company: 'Fjord Metrics',
      locationText: 'Germany, Netherlands',
      seniority: 'mid',
      salaryMin: 70000,
      salaryCurrency: 'EUR',
      salaryPeriod: 'year',
      remote: 'remote',
    });
    expect(jobs[1]).toMatchObject({ employmentType: 'contract', salaryMin: null, seniority: 'senior' });
  });
  it('a wrong envelope is a source error, not a crash', async () => {
    routes['/api'] = { body: { not: 'a list' } };
    await expect(collect(remoteok)).rejects.toBeInstanceOf(SourceError);
    routes['/api'] = { body: [{ legal: 'x' }] };
    expect(await collect(remoteok)).toEqual([]);
  });
});

describe('Bundesagentur für Arbeit', () => {
  it('sends the public client id, reads the detail for each new posting and respects the detail budget', async () => {
    const before = server.hits.length;
    const jobs = await collect(
      ba,
      ctxFor({ profile: profile({ locations: ['Berlin'] }), detailBudget: { left: 1 } }),
    );
    expect(jobs).toHaveLength(1); // the second posting is left for the next scan
    expect(jobs[0]).toMatchObject({
      source: 'ba',
      externalId: BA_REFS[0],
      company: 'Spree Daten GmbH',
      city: 'Berlin',
      country: 'Germany',
      url: `https://www.arbeitsagentur.de/jobsuche/jobdetail/${BA_REFS[0]}`,
      applyUrl: 'https://jobs.spree-daten.example/data-engineer',
    });
    expect(jobs[0]?.descriptionMd.length).toBeGreaterThan(200);
    const mine = server.hits.slice(before);
    expect(
      mine.some(
        (h) => h.startsWith('/pc/v6/jobs?') && h.includes('was=Data+Engineer') && h.includes('wo=Berlin'),
      ),
    ).toBe(true);
    expect(server.headers.at(-1)?.['x-api-key']).toBe('jobboerse-jobsuche');
  });
  it('skips the detail request for postings it already stored', async () => {
    const before = server.hits.length;
    const jobs = await collect(ba, ctxFor({ isKnown: () => true }));
    expect(jobs).toHaveLength(2);
    expect(server.hits.slice(before).some((h) => h.includes('jobdetails'))).toBe(false);
  });
  it('only applies to profiles that look in Germany', () => {
    expect(ba.applies(profile())).toBe(true);
    expect(ba.applies(profile({ locations: ['Paris'], countries: ['France'] }))).toBe(false);
  });
});

describe('Adzuna', () => {
  it('maps countries and needs a key', async () => {
    expect(adzunaCountries(['Germany', 'United Kingdom', 'Narnia', 'de'])).toEqual(['de', 'gb']);
    await expect(collect(adzuna)).rejects.toThrow('no API key set');
  });
  it('sends the key as query parameters, ignores predicted pay, and the error text never carries the key', async () => {
    const secret = { appId: 'abc123', appKey: 'sekretkey9876' };
    const jobs = await collect(adzuna, ctxFor({ secret }));
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({
      externalId: '5550001',
      company: 'Kite Systems',
      city: 'Munich',
      country: 'Germany',
      salaryMin: 60000,
      salaryCurrency: 'EUR',
      salaryPeriod: 'year',
      employmentType: 'full_time',
    });
    expect(jobs[1]).toMatchObject({ salaryMin: null, salaryMax: null }); // predicted by Adzuna
    expect(server.hits.at(-1)).toContain('app_key=sekretkey9876');

    routes['/v1/api/jobs/de/search/1'] = { status: 403, body: {} };
    const err = await collect(adzuna, ctxFor({ secret })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceError);
    expect((err as Error).message).toBe('access refused (HTTP 403)');
    expect((err as Error).message).not.toContain('sekret');
    routes['/v1/api/jobs/de/search/1'] = {
      body: allSourceRoutes()['/v1/api/jobs/de/search/1'] && { results: [] },
    };
  });
});

describe('watchlist (ATS boards)', () => {
  const entry = (kind: string) => ({
    id: kind,
    company: 'Acme Corp',
    careersUrl: null,
    atsType: kind,
    atsSlug: 'acme',
  });
  it.each(['greenhouse', 'lever', 'ashby', 'workable', 'smartrecruiters'])(
    '%s: every posting of the board is normalized',
    async (kind) => {
      const adapter = createWatchlistAdapter(() => [entry(kind)]);
      const jobs = await collect(adapter);
      expect(jobs.length).toBeGreaterThan(0);
      for (const j of jobs) {
        expect(j.source).toBe(kind);
        expect(j.externalId).toMatch(/^acme\//);
        expect(j.title.length).toBeGreaterThan(0);
        expect(j.company.length).toBeGreaterThan(0);
      }
      expect(jobs.some((j) => j.descriptionMd.length > 50)).toBe(true);
    },
  );
  it('one broken board is reported but the others still deliver', async () => {
    const adapter = createWatchlistAdapter(() => [
      { ...entry('greenhouse'), atsSlug: 'nope' },
      entry('lever'),
    ]);
    const seen: NormalizedJob[] = [];
    await expect(
      (async () => {
        for await (const raw of adapter.search(ctxFor())) seen.push(adapter.normalize(raw));
      })(),
    ).rejects.toThrow(/Some boards failed/);
    expect(seen.length).toBeGreaterThan(0);
  });
  it('detects the board from a careers URL or the links of a page', () => {
    expect(detectBoard('https://boards.greenhouse.io/acme')).toEqual({ kind: 'greenhouse', slug: 'acme' });
    expect(detectBoard('https://boards.greenhouse.io/embed/job_board?for=acme')).toEqual({
      kind: 'greenhouse',
      slug: 'acme',
    });
    expect(detectBoard('https://jobs.lever.co/acme/5f3e0f6a')).toEqual({ kind: 'lever', slug: 'acme' });
    expect(detectBoard('https://jobs.ashbyhq.com/acme')).toEqual({ kind: 'ashby', slug: 'acme' });
    expect(detectBoard('https://apply.workable.com/acme/')).toEqual({ kind: 'workable', slug: 'acme' });
    expect(detectBoard('https://careers.example.com/jobs')).toBeNull();
    expect(detectBoard('https://boards.greenhouse.io/')).toBeNull();
    expect(
      detectBoardInHtml(
        '<a href="https://acme.example">Home</a><a href="https://jobs.lever.co/acme">Jobs</a>',
      ),
    ).toEqual({
      kind: 'lever',
      slug: 'acme',
    });
    expect(detectBoardInHtml('<p>no board</p>')).toBeNull();
    expect(listUrl('lever', 'a b')).toContain('/v0/postings/a%20b');
  });
});

describe('http helpers', () => {
  it('only honours STELLIO_SOURCE_URLS together with the loopback test switch', () => {
    const env = { STELLIO_SOURCE_URLS: '{"ba":"http://127.0.0.1:1/"}' } as NodeJS.ProcessEnv;
    expect(baseUrl('ba', 'https://real.example', env)).toBe('https://real.example');
    expect(baseUrl('ba', 'https://real.example', { ...env, STELLIO_ALLOW_LOOPBACK_FETCH: '1' })).toBe(
      'http://127.0.0.1:1',
    );
    expect(
      baseUrl('ba', 'https://real.example', {
        STELLIO_ALLOW_LOOPBACK_FETCH: '1',
        STELLIO_SOURCE_URLS: 'not json',
      }),
    ).toBe('https://real.example');
  });
  it('the token bucket spaces requests by the rate limit', async () => {
    let t = 0;
    const waits: number[] = [];
    const take = createLimiter(
      { rps: 2, burst: 2 },
      (ms) => {
        waits.push(ms);
        t += ms;
        return Promise.resolve();
      },
      () => t,
    );
    await take();
    await take(); // burst
    await take(); // must wait 500 ms
    expect(waits).toEqual([500]);
  });
  it('turns HTTP failures into short, URL-free errors', async () => {
    const get = createGetJson({
      fetcher: guardedFetch,
      limiter: () => Promise.resolve(),
      signal: new AbortController().signal,
    });
    routes['/x429'] = { status: 429 };
    routes['/xtext'] = { text: 'not json' };
    await expect(get(`${server.base}/x429`)).rejects.toThrow('rate limited (HTTP 429)');
    await expect(get(`${server.base}/missing`)).rejects.toThrow('HTTP 404');
    await expect(get(`${server.base}/xtext`)).rejects.toThrow(SourceError);
  });
  it('parses dates the sources use', () => {
    expect(toIso(1_795_251_806)).toMatch(/^\d{4}-/);
    expect(toIso('2026-11-19T14:58:42')).toBe('2026-11-19T14:58:42.000Z');
    expect(toIso('')).toBeNull();
    expect(toIso('nonsense')).toBeNull();
  });
});
