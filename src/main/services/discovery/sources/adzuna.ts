import { z } from 'zod';
import { fold, wantsGermany } from '@shared/discovery/filters';
import { NormalizedJobSchema, type NormalizedJob, type SearchProfile } from '@shared/discovery/schemas';
import { httpUrlOrNull } from '../../jobs/net';
import { baseUrl, blankJob, employmentFrom, SourceError, toIso, type SourceAdapter } from './http';

/**
 * Adzuna search API (https://developer.adzuna.com). `app_id` and `app_key` go in the query string, so no URL is
 * ever logged or stored. Descriptions are short snippets: `jd.parse` works from those. Shape from the public
 * documentation; not re-verified against the live API (needs a key).
 */
export const ADZUNA_COUNTRIES: Record<string, string> = {
  germany: 'de',
  deutschland: 'de',
  'united kingdom': 'gb',
  uk: 'gb',
  'great britain': 'gb',
  'united states': 'us',
  usa: 'us',
  india: 'in',
  netherlands: 'nl',
  france: 'fr',
  austria: 'at',
  switzerland: 'ch',
  australia: 'au',
  canada: 'ca',
  italy: 'it',
  spain: 'es',
  poland: 'pl',
  'new zealand': 'nz',
  brazil: 'br',
  singapore: 'sg',
  'south africa': 'za',
  mexico: 'mx',
};
const CURRENCY: Record<string, string> = {
  de: 'EUR',
  nl: 'EUR',
  fr: 'EUR',
  at: 'EUR',
  it: 'EUR',
  es: 'EUR',
  gb: 'GBP',
  us: 'USD',
  in: 'INR',
  ch: 'CHF',
  au: 'AUD',
  ca: 'CAD',
  pl: 'PLN',
  nz: 'NZD',
  br: 'BRL',
  sg: 'SGD',
  za: 'ZAR',
  mx: 'MXN',
};
const CODES = new Set(Object.values(ADZUNA_COUNTRIES));

export const adzunaCountries = (countries: string[]): string[] => [
  ...new Set(
    countries
      .map((c) => ADZUNA_COUNTRIES[fold(c).trim()] ?? (CODES.has(fold(c).trim()) ? fold(c).trim() : null))
      .filter((c): c is string => c !== null),
  ),
];

/** Countries to search: the stated ones, or Germany when the profile names a German place. */
const countriesOf = (p: SearchProfile): string[] =>
  adzunaCountries([...p.countries, ...(wantsGermany(p) ? ['Germany'] : [])]);

const AdzunaItem = z.looseObject({
  id: z.union([z.string(), z.number()]),
  title: z.string(),
  description: z.string().nullish(),
  created: z.string().nullish(),
  redirect_url: z.string().nullish(),
  company: z.looseObject({ display_name: z.string().nullish() }).nullish(),
  location: z
    .looseObject({ display_name: z.string().nullish(), area: z.array(z.string()).nullish() })
    .nullish(),
  salary_min: z.number().nullish(),
  salary_max: z.number().nullish(),
  salary_is_predicted: z.union([z.string(), z.number()]).nullish(),
  contract_time: z.string().nullish(),
  contract_type: z.string().nullish(),
  category: z.looseObject({ label: z.string().nullish() }).nullish(),
});
const AdzunaPage = z.looseObject({ results: z.array(z.unknown()) });

/** Country of the board (`gb` → Great Britain) used when the posting names none. */
const COUNTRY_NAME: Record<string, string> = Object.fromEntries(
  Object.entries(ADZUNA_COUNTRIES)
    .reverse()
    .map(([n, c]) => [c, n.replace(/\b\w/g, (m) => m.toUpperCase())]),
);

export const adzuna: SourceAdapter = {
  id: 'adzuna',
  label: 'Adzuna',
  needsKey: true,
  rateLimit: { rps: 1, burst: 2 },
  perProfile: true,
  queryless: false,
  applies: (p) => countriesOf(p).length > 0,
  async *search(ctx) {
    if (!ctx.secret) throw new SourceError('no API key set');
    const base = baseUrl('adzuna', 'https://api.adzuna.com');
    const countries = countriesOf(ctx.profile);
    const roles = ctx.profile.roles.length > 0 ? ctx.profile.roles.slice(0, 3) : [''];
    const where = ctx.profile.locations.find((l) => !ADZUNA_COUNTRIES[fold(l).trim()]);
    const maxDays = Math.min(60, Math.max(1, Math.ceil((Date.now() - ctx.since.getTime()) / 86_400_000) + 1));
    let yielded = 0;
    for (const country of countries.slice(0, 3)) {
      for (const what of roles) {
        const q = new URLSearchParams({
          app_id: ctx.secret.appId,
          app_key: ctx.secret.appKey,
          results_per_page: String(Math.min(50, ctx.limit)),
          max_days_old: String(maxDays),
          sort_by: 'date',
          'content-type': 'application/json',
        });
        if (what) q.set('what', what);
        if (where) q.set('where', where);
        const page = AdzunaPage.safeParse(
          await ctx.getJson(`${base}/v1/api/jobs/${country}/search/1?${q.toString()}`),
        );
        if (!page.success) throw new SourceError('unexpected Adzuna response');
        for (const item of page.data.results) {
          if (yielded++ >= ctx.limit) return;
          yield { ...(item as object), _country: country };
        }
      }
    }
  },
  normalize(raw): NormalizedJob {
    const j = AdzunaItem.parse(raw);
    const code = (raw as { _country?: unknown })._country;
    const place = j.location?.display_name ?? null;
    const predicted = String(j.salary_is_predicted ?? '0') === '1';
    const pay = !predicted && ((j.salary_min ?? 0) > 0 || (j.salary_max ?? 0) > 0);
    const url = httpUrlOrNull(j.redirect_url);
    return NormalizedJobSchema.parse({
      ...blankJob('adzuna'),
      externalId: String(j.id),
      url,
      applyUrl: url,
      title: j.title,
      company: j.company?.display_name || 'Unknown company',
      locationText: place,
      city: j.location?.area?.at(-1) ?? place?.split(',')[0]?.trim() ?? null,
      country: typeof code === 'string' ? (COUNTRY_NAME[code] ?? null) : null,
      employmentType: employmentFrom(`${j.contract_time ?? ''} ${j.contract_type ?? ''}`),
      salaryMin: pay ? (j.salary_min ?? null) : null,
      salaryMax: pay ? (j.salary_max ?? null) : null,
      salaryCurrency: pay && typeof code === 'string' ? (CURRENCY[code] ?? null) : null,
      salaryPeriod: pay ? 'year' : null,
      postedAt: toIso(j.created),
      descriptionMd: (j.description ?? '').trim(),
      tags: j.category?.label ? [j.category.label] : [],
    });
  },
};
