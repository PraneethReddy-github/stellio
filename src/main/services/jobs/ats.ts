import { z } from 'zod';
import type { REMOTE_KINDS } from '@shared/jobs/schemas';

type RemoteKind = (typeof REMOTE_KINDS)[number];

/**
 * Known applicant-tracking systems: a posting URL maps to the vendor's public JSON, which beats scraping HTML.
 * The API hosts are a fixed allow-list; slugs and ids are validated before they enter a URL.
 * Shapes follow the vendors' public docs (Greenhouse Job Board API, Lever Postings API, Ashby Public Job
 * Posting API, SmartRecruiters Posting API). The Workable widget endpoint is undocumented: shape from observation.
 */
export type AtsKind = 'greenhouse' | 'lever' | 'ashby' | 'smartrecruiters' | 'workable';

export interface AtsRef {
  kind: AtsKind;
  company: string;
  id: string;
  apiUrl: string;
  /** Only this host may be contacted (also after redirects). */
  apiHost: string;
}

/** A posting normalised across vendors. */
export interface AtsJob {
  title: string;
  company: string | null;
  location: string | null;
  remote: RemoteKind | null;
  /** HTML (or entity-escaped HTML, already decoded). */
  descriptionHtml: string;
  /** Pay as the vendor states it, for the description header. */
  salaryText: string | null;
  url: string | null;
  applyUrl: string | null;
  postedAt: string | null;
  deadline: string | null;
  raw: unknown;
}

const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
export const isAtsSlug = (s: string): boolean => SLUG.test(s);
const NUM = /^\d{1,20}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHORTCODE = /^[A-Za-z0-9]{3,32}$/;

export const ATS_API_HOSTS = [
  'boards-api.greenhouse.io',
  'api.lever.co',
  'api.eu.lever.co',
  'api.ashbyhq.com',
  'api.smartrecruiters.com',
  'apply.workable.com',
] as const;

const enc = encodeURIComponent;

export function detectAts(rawUrl: string): AtsRef | null {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const [co = '', a = '', b = ''] = u.pathname.split('/').filter(Boolean);
  const host = u.hostname.toLowerCase();

  if (['boards.greenhouse.io', 'job-boards.greenhouse.io', 'job-boards.eu.greenhouse.io'].includes(host)) {
    if (SLUG.test(co) && a === 'jobs' && NUM.test(b))
      return {
        kind: 'greenhouse',
        company: co,
        id: b,
        apiHost: 'boards-api.greenhouse.io',
        apiUrl: `https://boards-api.greenhouse.io/v1/boards/${enc(co)}/jobs/${b}?pay_transparency=true`,
      };
    return null;
  }
  if (host === 'jobs.lever.co' || host === 'jobs.eu.lever.co') {
    if (!SLUG.test(co) || !UUID.test(a)) return null;
    const apiHost = host === 'jobs.lever.co' ? 'api.lever.co' : 'api.eu.lever.co';
    return {
      kind: 'lever',
      company: co,
      id: a,
      apiHost,
      apiUrl: `https://${apiHost}/v0/postings/${enc(co)}/${a}`,
    };
  }
  if (host === 'jobs.ashbyhq.com') {
    if (!SLUG.test(co) || !UUID.test(a)) return null;
    return {
      kind: 'ashby',
      company: co,
      id: a,
      apiHost: 'api.ashbyhq.com',
      apiUrl: `https://api.ashbyhq.com/posting-api/job-board/${enc(co)}?includeCompensation=true`,
    };
  }
  if (host === 'jobs.smartrecruiters.com') {
    const id = /^(\d{6,20})(?:-|$)/.exec(a)?.[1];
    if (!SLUG.test(co) || !id) return null;
    return {
      kind: 'smartrecruiters',
      company: co,
      id,
      apiHost: 'api.smartrecruiters.com',
      apiUrl: `https://api.smartrecruiters.com/v1/companies/${enc(co)}/postings/${id}`,
    };
  }
  if (host === 'apply.workable.com') {
    if (SLUG.test(co) && a === 'j' && SHORTCODE.test(b))
      return {
        kind: 'workable',
        company: co,
        id: b,
        apiHost: 'apply.workable.com',
        apiUrl: `https://apply.workable.com/api/v1/widget/accounts/${enc(co)}?details=true`,
      };
    return null;
  }
  return null;
}

const str = z.string().nullish();
const isoDate = (v: string | number | null | undefined): string | null => {
  if (v === null || v === undefined || v === '') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const money = (
  min: number | null | undefined,
  max: number | null | undefined,
  cur: string | null | undefined,
  per?: string | null,
): string | null => {
  if (min == null && max == null) return null;
  const range =
    min != null && max != null && min !== max ? `${String(min)}-${String(max)}` : String(min ?? max);
  return [range, cur, per ? `per ${per}` : ''].filter(Boolean).join(' ');
};

/** Greenhouse returns HTML with its angle brackets entity-escaped. */
export function unescapeEntities(s: string): string {
  if (/<\w+[^>]*>/.test(s)) return s;
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

const Greenhouse = z.looseObject({
  title: z.string(),
  company_name: str,
  location: z.looseObject({ name: str }).nullish(),
  content: str,
  absolute_url: str,
  first_published: str,
  updated_at: str,
  application_deadline: str,
  pay_input_ranges: z
    .array(
      z.looseObject({
        min_cents: z.number().nullish(),
        max_cents: z.number().nullish(),
        currency_type: str,
        title: str,
      }),
    )
    .nullish(),
});

const Lever = z.looseObject({
  text: z.string(),
  categories: z.looseObject({ location: str, allLocations: z.array(z.string()).nullish() }).nullish(),
  description: str,
  lists: z.array(z.looseObject({ text: str, content: str })).nullish(),
  additional: str,
  hostedUrl: str,
  applyUrl: str,
  createdAt: z.number().nullish(),
  workplaceType: str,
  salaryRange: z
    .looseObject({ min: z.number().nullish(), max: z.number().nullish(), currency: str, interval: str })
    .nullish(),
});

const AshbyCompensation = z.looseObject({
  compensationTierSummary: str,
  scrapeableCompensationSalarySummary: str,
});
const AshbyJob = z.looseObject({
  id: str,
  title: z.string(),
  location: str,
  isRemote: z.boolean().nullish(),
  workplaceType: str,
  descriptionHtml: str,
  publishedAt: str,
  jobUrl: str,
  applyUrl: str,
  compensation: AshbyCompensation.nullish(),
});
const Ashby = z.looseObject({ jobs: z.array(AshbyJob), compensation: AshbyCompensation.nullish() });

const SrSection = z.looseObject({ title: str, text: str }).nullish();
const SmartRecruiters = z.looseObject({
  name: z.string(),
  company: z.looseObject({ name: str }).nullish(),
  location: z
    .looseObject({
      city: str,
      region: str,
      country: str,
      remote: z.boolean().nullish(),
      hybrid: z.boolean().nullish(),
    })
    .nullish(),
  jobAd: z
    .looseObject({
      sections: z
        .looseObject({
          companyDescription: SrSection,
          jobDescription: SrSection,
          qualifications: SrSection,
          additionalInformation: SrSection,
        })
        .nullish(),
    })
    .nullish(),
  postingUrl: str,
  applyUrl: str,
  releasedDate: str,
});

const WorkableJob = z.looseObject({
  title: z.string(),
  shortcode: z.string(),
  description: str,
  requirements: str,
  benefits: str,
  url: str,
  shortlink: str,
  application_url: str,
  published_on: str,
  created_at: str,
  city: str,
  state: str,
  country: str,
  telecommuting: z.boolean().nullish(),
});
const Workable = z.looseObject({ name: str, jobs: z.array(WorkableJob) });

export class AtsNotFoundError extends Error {
  override name = 'AtsNotFoundError';
}

const place = (...parts: (string | null | undefined)[]): string | null =>
  parts.filter((p): p is string => !!p).join(', ') || null;

/** Maps a vendor response to an AtsJob. Throws ZodError on an unexpected shape, AtsNotFoundError for a missing id. */
export function parseAtsResponse(ref: AtsRef, json: unknown): AtsJob {
  switch (ref.kind) {
    case 'greenhouse': {
      const j = Greenhouse.parse(json);
      const pay = j.pay_input_ranges?.[0];
      return {
        title: j.title,
        company: j.company_name ?? null,
        location: j.location?.name ?? null,
        remote: null,
        descriptionHtml: unescapeEntities(j.content ?? ''),
        salaryText: pay
          ? money(
              pay.min_cents == null ? null : pay.min_cents / 100,
              pay.max_cents == null ? null : pay.max_cents / 100,
              pay.currency_type,
            )
          : null,
        url: j.absolute_url ?? null,
        applyUrl: j.absolute_url ?? null,
        postedAt: isoDate(j.first_published ?? j.updated_at),
        deadline: j.application_deadline?.slice(0, 10) ?? null,
        raw: json,
      };
    }
    case 'lever': {
      const j = Lever.parse(json);
      const lists = (j.lists ?? [])
        .map((l) => `<h3>${l.text ?? ''}</h3><ul>${l.content ?? ''}</ul>`)
        .join('');
      const wt = j.workplaceType;
      return {
        title: j.text,
        company: null,
        location: j.categories?.allLocations?.join('; ') || (j.categories?.location ?? null),
        remote: wt === 'remote' ? 'remote' : wt === 'hybrid' ? 'hybrid' : wt === 'on-site' ? 'onsite' : null,
        descriptionHtml: `${j.description ?? ''}${lists}${j.additional ?? ''}`,
        salaryText: j.salaryRange
          ? money(
              j.salaryRange.min,
              j.salaryRange.max,
              j.salaryRange.currency,
              j.salaryRange.interval?.replace(/^per-|-(?:salary|wage)$/g, ''),
            )
          : null,
        url: j.hostedUrl ?? null,
        applyUrl: j.applyUrl ?? null,
        postedAt: isoDate(j.createdAt),
        deadline: null,
        raw: json,
      };
    }
    case 'ashby': {
      const all = Ashby.parse(json);
      const j = all.jobs.find((x) => x.id === ref.id);
      if (!j) throw new AtsNotFoundError('Ashby board has no posting with that id');
      const comp = j.compensation ?? all.compensation;
      const wt = j.workplaceType?.toLowerCase();
      return {
        title: j.title,
        company: null,
        location: j.location ?? null,
        remote:
          j.isRemote || wt === 'remote'
            ? 'remote'
            : wt === 'hybrid'
              ? 'hybrid'
              : wt === 'onsite'
                ? 'onsite'
                : null,
        descriptionHtml: j.descriptionHtml ?? '',
        salaryText: comp?.scrapeableCompensationSalarySummary ?? comp?.compensationTierSummary ?? null,
        url: j.jobUrl ?? null,
        applyUrl: j.applyUrl ?? null,
        postedAt: isoDate(j.publishedAt),
        deadline: null,
        raw: j,
      };
    }
    case 'smartrecruiters': {
      const j = SmartRecruiters.parse(json);
      const s = j.jobAd?.sections;
      const html = [s?.companyDescription, s?.jobDescription, s?.qualifications, s?.additionalInformation]
        .filter((x) => x?.text)
        .map((x) => `<h2>${x?.title ?? ''}</h2>${x?.text ?? ''}`)
        .join('');
      const l = j.location;
      return {
        title: j.name,
        company: j.company?.name ?? null,
        location: place(l?.city, l?.region, l?.country?.toUpperCase()),
        remote: l?.remote ? 'remote' : l?.hybrid ? 'hybrid' : null,
        descriptionHtml: html,
        salaryText: null,
        url: j.postingUrl ?? null,
        applyUrl: j.applyUrl ?? null,
        postedAt: isoDate(j.releasedDate),
        deadline: null,
        raw: json,
      };
    }
    case 'workable': {
      const all = Workable.parse(json);
      const j = all.jobs.find((x) => x.shortcode === ref.id);
      if (!j) throw new AtsNotFoundError('Workable account has no posting with that shortcode');
      const html = [
        j.description,
        j.requirements && `<h3>Requirements</h3>${j.requirements}`,
        j.benefits && `<h3>Benefits</h3>${j.benefits}`,
      ]
        .filter(Boolean)
        .join('');
      return {
        title: j.title,
        company: all.name ?? null,
        location: place(j.city, j.state, j.country),
        remote: j.telecommuting ? 'remote' : null,
        descriptionHtml: html,
        salaryText: null,
        url: j.url ?? j.shortlink ?? null,
        applyUrl: j.application_url ?? j.url ?? null,
        postedAt: isoDate(j.published_on ?? j.created_at),
        deadline: null,
        raw: j,
      };
    }
  }
}
