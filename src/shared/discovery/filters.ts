import { normalizeCompany } from '../jobs/dedupe';
import type { NormalizedJob, SearchProfile } from './schemas';

export const fold = (s: string): string =>
  s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replaceAll('ß', 'ss');

const ALIASES: string[][] = [['germany', 'deutschland', 'de']];
const GERMAN_CITIES = [
  'berlin',
  'munich',
  'muenchen',
  'hamburg',
  'frankfurt',
  'cologne',
  'koeln',
  'stuttgart',
  'dusseldorf',
  'duesseldorf',
  'leipzig',
  'dresden',
  'nuremberg',
  'nurnberg',
  'hannover',
  'bremen',
  'dortmund',
  'essen',
  'bonn',
  'karlsruhe',
  'mannheim',
  'potsdam',
];
const WIDE = /worldwide|anywhere|global|world wide|international|europe|\beu\b|emea|\bdach\b/;

const wordIn = (needle: string, hay: string): boolean =>
  needle.length <= 2 ? new RegExp(`(^|[^a-z])${needle}([^a-z]|$)`).test(hay) : hay.includes(needle);

/** The place plus its aliases ("germany" also answers to "deutschland"). */
function expand(place: string): string[] {
  const f = fold(place).trim();
  return [f, ...(ALIASES.find((g) => g.includes(f)) ?? [])];
}

export const isGermanPlace = (text: string): boolean =>
  expand('germany').some((a) => wordIn(a, text)) || GERMAN_CITIES.some((c) => text.includes(c));

/** True when a profile looks for jobs in Germany (decides whether the Bundesagentur source applies). */
export const wantsGermany = (p: Pick<SearchProfile, 'locations' | 'countries'>): boolean =>
  [...p.locations, ...p.countries].some((l) => isGermanPlace(fold(l)));

const DE_WORDS = new Set(
  'und der die das mit für wir sie ihre ihr ein eine von im zu den dem auf ist sind werden bei als oder'.split(
    ' ',
  ),
);
const EN_WORDS = new Set(
  'and the with for our you your will to of a in is are we as or be on that this'.split(' '),
);

/** Cheap de/en detector: null when the text is too short or ambiguous. */
export function detectLanguage(text: string): 'de' | 'en' | null {
  const words = fold(text)
    .split(/[^\p{L}]+/u)
    .filter(Boolean);
  if (words.length < 40) return null;
  let de = 0;
  let en = 0;
  for (const w of words) {
    if (DE_WORDS.has(w)) de++;
    if (EN_WORDS.has(w)) en++;
  }
  if (de > en * 1.5 && de >= 5) return 'de';
  if (en > de * 1.5 && en >= 5) return 'en';
  return null;
}

const LANG_CODES: Record<string, string> = { english: 'en', en: 'en', german: 'de', deutsch: 'de', de: 'de' };
const langCode = (l: string): string => LANG_CODES[fold(l).trim()] ?? fold(l).trim();

const SENIORITY_WORDS: [RegExp, string][] = [
  [/\b(intern|internship|praktikum|praktikant\w*|werkstudent\w*|trainee)\b/, 'intern'],
  [/\b(junior|jr|berufseinsteiger\w*|entry[- ]level)\b/, 'junior'],
  [/\b(principal|staff)\b/, 'staff'],
  [/\b(senior|sr|erfahren\w*)\b/, 'senior'],
  [/\b(lead|head of|teamlead\w*|team lead)\b/, 'lead'],
  [/\b(director|vp|vice president)\b/, 'director'],
  [/\b(manager)\b/, 'manager'],
];
export function detectSeniority(title: string): string | null {
  const t = fold(title);
  return SENIORITY_WORDS.find(([re]) => re.test(t))?.[1] ?? null;
}

const YEAR_FACTOR: Record<string, number> = { year: 1, month: 12, week: 52, day: 220, hour: 1800 };
/** Upper bound of the stated pay, as a yearly figure; null when unknown. */
export function yearlyMax(
  j: Pick<NormalizedJob, 'salaryMin' | 'salaryMax'> & { salaryPeriod: string | null },
): number | null {
  const top = j.salaryMax ?? j.salaryMin;
  if (top === null || top <= 0) return null;
  return top * (YEAR_FACTOR[j.salaryPeriod ?? 'year'] ?? 1);
}

function locationReject(job: NormalizedJob, p: SearchProfile): string | null {
  const text = fold([job.locationText, job.city, job.country].filter(Boolean).join(' '));
  const wanted = [...p.locations, ...p.countries].flatMap(expand);
  const matchesWanted = wanted.some((w) => wordIn(w, text));
  // Naming the country (not just a German city) opens every German place.
  const germanWanted =
    [...p.locations, ...p.countries].some((l) => expand('germany').includes(fold(l).trim())) &&
    isGermanPlace(text);
  if (job.remote === 'remote') {
    if (!p.remoteOk) return 'remote roles not wanted';
    if (text === '' || WIDE.test(text) || matchesWanted || germanWanted) return null;
    return 'remote but restricted to another region';
  }
  if (wanted.length === 0 || text === '') return null;
  return matchesWanted || germanWanted ? null : 'location does not match';
}

const HOURS =
  /(\d{1,2})(?:[,.]\d)?\s*(?:(?:-|–|bis|to)\s*\d{1,2}(?:[,.]\d)?\s*)?(?:std\.?|stunden|hours|hrs|h)\s*(?:\/|pro|per|a|je|in der|the)?\s*(?:woche|week|wk|wo\.|weekly)/;

/** The lowest weekly hours a posting states ("15-20 Stunden pro Woche" gives 15); null when it names none. */
export function statedWeeklyHours(text: string): number | null {
  const m = HOURS.exec(fold(text));
  return m?.[1] ? Number(m[1]) : null;
}

const FULL_TIME = /\b(vollzeit|full[- ]time)\b/;

/** Side-job profiles: no full-time roles, no more hours than wanted, no hourly pay below the floor. */
function sideReject(job: NormalizedJob, p: SearchProfile): string | null {
  if (job.employmentType === 'full_time' || FULL_TIME.test(fold(job.title))) return 'full-time role';
  const hours = statedWeeklyHours(`${job.title}\n${job.descriptionMd}`);
  if (p.maxHoursPerWeek !== null && hours !== null && hours > p.maxHoursPerWeek) return 'too many hours';
  const top = job.salaryMax ?? job.salaryMin;
  if (
    p.minHourlyPay !== null &&
    job.salaryPeriod === 'hour' &&
    top !== null &&
    top > 0 &&
    top < p.minHourlyPay
  )
    return 'hourly pay below floor';
  return null;
}

/** Why the job is out for this search profile, or null when it passes. Pure code, no AI. */
export function hardFilter(
  job: NormalizedJob,
  p: SearchProfile,
  { now, maxAgeDays }: { now: Date; maxAgeDays: number },
): string | null {
  const company = fold(job.company);
  if (p.excludedCompanies.some((c) => c.trim() && company.includes(fold(c)))) return 'excluded company';
  const haystack = fold(`${job.title}\n${job.descriptionMd}`);
  if (p.excludeKeywords.some((k) => k.trim() && haystack.includes(fold(k)))) return 'excluded keyword';
  if (job.postedAt) {
    const t = Date.parse(job.postedAt);
    if (!Number.isNaN(t) && now.getTime() - t > maxAgeDays * 86_400_000) return 'posting too old';
  }
  const loc = locationReject(job, p);
  if (loc) return loc;
  if (p.kind === 'side') {
    const side = sideReject(job, p);
    if (side) return side;
  }
  const level = job.seniority ?? detectSeniority(job.title);
  if (p.seniority.length > 0 && level && !p.seniority.includes(level as (typeof p.seniority)[number]))
    return 'seniority does not match';
  const top = yearlyMax(job);
  if (
    p.salaryFloor !== null &&
    top !== null &&
    (!p.currency || !job.salaryCurrency || p.currency.toUpperCase() === job.salaryCurrency.toUpperCase()) &&
    top < p.salaryFloor
  )
    return 'salary below floor';
  if (p.languages.length > 0) {
    const lang = detectLanguage(job.descriptionMd);
    if (lang && !p.languages.map(langCode).includes(lang)) return 'posting language not spoken';
  }
  return null;
}

const STOP = new Set(['m', 'w', 'd', 'f', 'x', 'i', 'of', 'the', 'and', 'for']);
const tokens = (s: string): string[] =>
  fold(s)
    .split(/[^\p{L}\p{N}+#.]+/u)
    .filter((t) => t.length > 1 && !STOP.has(t));

/**
 * For sources that cannot search (Arbeitnow, RemoteOK, Remotive, ATS boards): the title must carry all words of
 * one wanted role, or the posting must name one of the keywords. No roles and no keywords means everything fits.
 */
export function matchesQuery(job: NormalizedJob, p: Pick<SearchProfile, 'roles' | 'keywords'>): boolean {
  const roles = p.roles.map(tokens).filter((t) => t.length > 0);
  const keywords = p.keywords.map(fold).filter(Boolean);
  if (roles.length === 0 && keywords.length === 0) return true;
  const title = new Set(tokens(`${job.title} ${job.tags.join(' ')}`));
  if (roles.some((r) => r.every((w) => title.has(w)))) return true;
  const text = fold(`${job.title} ${job.tags.join(' ')} ${job.descriptionMd}`);
  return keywords.some((k) => wordIn(k, text));
}

export { normalizeCompany };
