import { z } from 'zod';
import { NormalizedJobSchema, type NormalizedJob } from '@shared/discovery/schemas';
import { fragmentToMarkdown } from '../../jobs/html';
import { unescapeEntities } from '../../jobs/ats';
import { httpUrlOrNull } from '../../jobs/net';
import { baseUrl, blankJob, employmentFrom, SourceError, toIso, type SourceAdapter } from './http';

/**
 * Public job-board APIs without a key: Arbeitnow, Remotive, RemoteOK, Himalayas. Shapes checked against the live
 * APIs on 2026-11-21 (see docs/05 §6). Each yields raw items; `normalize` validates one item with zod.
 */

const str = z.string().nullish();
const clean = (html: string | null | undefined): string => fragmentToMarkdown(unescapeEntities(html ?? ''));
const roles = (p: { roles: string[] }): string[] => p.roles.slice(0, 3);

// ---- Arbeitnow -------------------------------------------------------------------------------------------

const ArbeitnowItem = z.looseObject({
  slug: z.string(),
  company_name: z.string(),
  title: z.string(),
  description: str,
  remote: z.boolean().nullish(),
  url: str,
  tags: z.array(z.string()).nullish(),
  job_types: z.array(z.string()).nullish(),
  location: str,
  created_at: z.number().nullish(),
});
const ArbeitnowPage = z.looseObject({
  data: z.array(z.unknown()),
  links: z.looseObject({ next: str }).nullish(),
});

export const arbeitnow: SourceAdapter = {
  id: 'arbeitnow',
  label: 'Arbeitnow',
  needsKey: false,
  rateLimit: { rps: 1, burst: 2 },
  perProfile: false,
  queryless: true,
  applies: () => true,
  async *search(ctx) {
    const base = baseUrl('arbeitnow', 'https://www.arbeitnow.com');
    let yielded = 0;
    for (let page = 1; page <= 3; page++) {
      const body = ArbeitnowPage.safeParse(
        await ctx.getJson(`${base}/api/job-board-api?page=${String(page)}`),
      );
      if (!body.success) throw new SourceError('unexpected Arbeitnow response');
      for (const item of body.data.data) {
        // Newest first: everything after the first posting older than `since` was seen on an earlier scan.
        const at = (item as { created_at?: unknown }).created_at;
        if (typeof at === 'number' && at * 1000 < ctx.since.getTime()) return;
        if (yielded++ >= ctx.limit) return;
        yield item;
      }
      if (!body.data.links?.next) return;
    }
  },
  normalize(raw): NormalizedJob {
    const j = ArbeitnowItem.parse(raw);
    return NormalizedJobSchema.parse({
      ...blankJob('arbeitnow'),
      externalId: j.slug,
      url: httpUrlOrNull(j.url),
      applyUrl: httpUrlOrNull(j.url),
      title: j.title,
      company: j.company_name,
      locationText: j.location ?? null,
      city: j.location?.split(',')[0]?.trim() || null,
      remote: j.remote ? 'remote' : 'unknown',
      employmentType: employmentFrom((j.job_types ?? []).join(' ')),
      postedAt: toIso(j.created_at),
      descriptionMd: clean(j.description),
      tags: j.tags ?? [],
    });
  },
};

// ---- Remotive --------------------------------------------------------------------------------------------

const RemotiveItem = z.looseObject({
  id: z.number(),
  url: str,
  title: z.string(),
  company_name: z.string(),
  category: str,
  tags: z.array(z.string()).nullish(),
  job_type: str,
  publication_date: str,
  candidate_required_location: str,
  salary: str,
  description: str,
});
const RemotiveBody = z.looseObject({ jobs: z.array(z.unknown()) });

export const remotive: SourceAdapter = {
  id: 'remotive',
  label: 'Remotive',
  needsKey: false,
  // Remotive asks for at most ~4 fetches a day and blocks > 2 per minute.
  rateLimit: { rps: 1 / 35, burst: 2 },
  perProfile: false,
  queryless: true,
  applies: () => true,
  async *search(ctx) {
    const base = baseUrl('remotive', 'https://remotive.com');
    let yielded = 0;
    for (const category of ['software-dev', 'data']) {
      const body = RemotiveBody.safeParse(
        await ctx.getJson(
          `${base}/api/remote-jobs?category=${category}&limit=${String(Math.min(ctx.limit, 200))}`,
        ),
      );
      if (!body.success) throw new SourceError('unexpected Remotive response');
      for (const item of body.data.jobs) {
        if (yielded++ >= ctx.limit) return;
        yield item;
      }
    }
  },
  normalize(raw): NormalizedJob {
    const j = RemotiveItem.parse(raw);
    return NormalizedJobSchema.parse({
      ...blankJob('remotive'),
      externalId: String(j.id),
      url: httpUrlOrNull(j.url),
      applyUrl: httpUrlOrNull(j.url),
      title: j.title,
      company: j.company_name,
      locationText: j.candidate_required_location ?? null,
      remote: 'remote',
      employmentType: employmentFrom(j.job_type),
      postedAt: toIso(j.publication_date),
      descriptionMd: [j.salary && `Salary: ${j.salary}`, clean(j.description)].filter(Boolean).join('\n\n'),
      tags: [...(j.tags ?? []), j.category ?? ''].filter(Boolean),
    });
  },
};

// ---- RemoteOK --------------------------------------------------------------------------------------------

const RemoteOkItem = z.looseObject({
  id: z.union([z.string(), z.number()]),
  position: z.string(),
  company: z.string(),
  url: str,
  apply_url: str,
  date: str,
  location: str,
  tags: z.array(z.string()).nullish(),
  description: str,
  salary_min: z.number().nullish(),
  salary_max: z.number().nullish(),
});

export const remoteok: SourceAdapter = {
  id: 'remoteok',
  label: 'RemoteOK',
  needsKey: false,
  rateLimit: { rps: 0.2, burst: 1 },
  perProfile: false,
  queryless: true,
  applies: () => true,
  async *search(ctx) {
    const body = await ctx.getJson(`${baseUrl('remoteok', 'https://remoteok.com')}/api`);
    if (!Array.isArray(body)) throw new SourceError('unexpected RemoteOK response');
    let yielded = 0;
    // The first element is the legal notice, not a job.
    for (const item of body) {
      if (typeof item !== 'object' || item === null || !('position' in item)) continue;
      if (yielded++ >= ctx.limit) return;
      yield item;
    }
  },
  normalize(raw): NormalizedJob {
    const j = RemoteOkItem.parse(raw);
    const pay = (j.salary_max ?? 0) > 0 || (j.salary_min ?? 0) > 0;
    return NormalizedJobSchema.parse({
      ...blankJob('remoteok'),
      externalId: String(j.id),
      url: httpUrlOrNull(j.url),
      applyUrl: httpUrlOrNull(j.apply_url) ?? httpUrlOrNull(j.url),
      title: j.position,
      company: j.company,
      locationText: j.location || null,
      remote: 'remote',
      salaryMin: pay ? (j.salary_min ?? null) : null,
      salaryMax: pay ? (j.salary_max ?? null) : null,
      salaryCurrency: pay ? 'USD' : null,
      salaryPeriod: pay ? 'year' : null,
      postedAt: toIso(j.date),
      descriptionMd: clean(j.description),
      tags: j.tags ?? [],
    });
  },
};

// ---- Himalayas -------------------------------------------------------------------------------------------

const HimalayasItem = z.looseObject({
  title: z.string(),
  companyName: z.string(),
  guid: str,
  applicationLink: str,
  description: str,
  excerpt: str,
  employmentType: str,
  minSalary: z.number().nullish(),
  maxSalary: z.number().nullish(),
  currency: str,
  salaryPeriod: str,
  seniority: z.array(z.string()).nullish(),
  locationRestrictions: z.array(z.string()).nullish(),
  categories: z.array(z.string()).nullish(),
  pubDate: z.number().nullish(),
});
const HimalayasPage = z.looseObject({ jobs: z.array(z.unknown()), nextCursor: str });

const HIMALAYAS_SENIORITY: Record<string, NormalizedJob['seniority']> = {
  entry: 'junior',
  junior: 'junior',
  mid: 'mid',
  senior: 'senior',
  manager: 'manager',
  director: 'director',
  executive: 'executive',
};
const HIMALAYAS_PERIOD: Record<string, NormalizedJob['salaryPeriod']> = {
  annual: 'year',
  yearly: 'year',
  monthly: 'month',
  weekly: 'week',
  daily: 'day',
  hourly: 'hour',
};

export const himalayas: SourceAdapter = {
  id: 'himalayas',
  label: 'Himalayas',
  needsKey: false,
  rateLimit: { rps: 1, burst: 2 },
  perProfile: true,
  queryless: false,
  applies: () => true,
  async *search(ctx) {
    const base = baseUrl('himalayas', 'https://himalayas.app');
    const queries = roles(ctx.profile).length > 0 ? roles(ctx.profile) : [''];
    let yielded = 0;
    for (const q of queries) {
      for (let page = 1; page <= 2; page++) {
        const url = q
          ? `${base}/jobs/api/search?q=${encodeURIComponent(q)}&sort=recent&page=${String(page)}`
          : `${base}/jobs/api?limit=20&offset=${String((page - 1) * 20)}`;
        const body = HimalayasPage.safeParse(await ctx.getJson(url));
        if (!body.success) throw new SourceError('unexpected Himalayas response');
        for (const item of body.data.jobs) {
          if (yielded++ >= ctx.limit) return;
          yield item;
        }
        if (body.data.jobs.length < 20) break;
      }
    }
  },
  normalize(raw): NormalizedJob {
    const j = HimalayasItem.parse(raw);
    const where = (j.locationRestrictions ?? []).join(', ');
    const pay = (j.minSalary ?? 0) > 0 || (j.maxSalary ?? 0) > 0;
    return NormalizedJobSchema.parse({
      ...blankJob('himalayas'),
      externalId: j.guid ?? `${j.companyName}/${j.title}`,
      url: httpUrlOrNull(j.guid),
      // Himalayas' terms: applying goes through its own link.
      applyUrl: httpUrlOrNull(j.applicationLink) ?? httpUrlOrNull(j.guid),
      title: j.title,
      company: j.companyName,
      locationText: where || 'Worldwide',
      remote: 'remote',
      employmentType: employmentFrom(j.employmentType),
      seniority: HIMALAYAS_SENIORITY[(j.seniority?.[0] ?? '').toLowerCase()] ?? null,
      salaryMin: pay ? (j.minSalary ?? null) : null,
      salaryMax: pay ? (j.maxSalary ?? null) : null,
      salaryCurrency: pay ? (j.currency ?? null) : null,
      salaryPeriod: pay ? (HIMALAYAS_PERIOD[(j.salaryPeriod ?? 'annual').toLowerCase()] ?? 'year') : null,
      postedAt: toIso(j.pubDate),
      descriptionMd: clean(j.description ?? j.excerpt),
      tags: j.categories ?? [],
    });
  },
};
