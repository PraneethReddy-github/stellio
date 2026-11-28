// Pure helpers for the discovery sections of Settings. No React, no IPC: unit-tested.
import {
  DiscoverySettingsSchema,
  SearchProfileInputSchema,
  SIDE_DEFAULTS,
  type DiscoverySettings,
  type SearchProfile,
  type SearchProfileInput,
} from '@shared/discovery/schemas';

/** "a, b\nc" -> ["a", "b", "c"]: trimmed, no empties, no repeats (case-insensitive, first spelling wins). */
export function parseList(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/[,\n]/)) {
    const v = raw.trim();
    if (v && !seen.has(v.toLowerCase())) {
      seen.add(v.toLowerCase());
      out.push(v);
    }
  }
  return out;
}
export const formatList = (v: readonly string[]): string => v.join(', ');

export interface ProfileForm {
  name: string;
  roles: string;
  keywords: string;
  excludeKeywords: string;
  locations: string;
  countries: string;
  languages: string;
  excludedCompanies: string;
  seniority: string[];
  salaryFloor: string;
  currency: string;
  remoteOk: boolean;
  enabled: boolean;
  side: boolean;
  maxHoursPerWeek: string;
  minHourlyPay: string;
}

export const EMPTY_PROFILE_FORM: ProfileForm = {
  name: '',
  roles: '',
  keywords: '',
  excludeKeywords: '',
  locations: '',
  countries: '',
  languages: '',
  excludedCompanies: '',
  seniority: [],
  salaryFloor: '',
  currency: '',
  remoteOk: true,
  enabled: true,
  side: false,
  maxHoursPerWeek: String(SIDE_DEFAULTS.maxHoursPerWeek),
  minHourlyPay: String(SIDE_DEFAULTS.minHourlyPay),
};

/** Starting roles for a new side-job profile (German job titles: student job, helper, minijob, part-time). */
export const SIDE_ROLES = 'Werkstudent, Aushilfe, Minijob, Teilzeit';

export const profileToForm = (p: SearchProfileInput): ProfileForm => ({
  name: p.name,
  roles: formatList(p.roles),
  keywords: formatList(p.keywords),
  excludeKeywords: formatList(p.excludeKeywords),
  locations: formatList(p.locations),
  countries: formatList(p.countries),
  languages: formatList(p.languages),
  excludedCompanies: formatList(p.excludedCompanies),
  seniority: [...p.seniority],
  salaryFloor: p.salaryFloor === null ? '' : String(p.salaryFloor),
  currency: p.currency ?? '',
  remoteOk: p.remoteOk,
  enabled: p.enabled,
  side: p.kind === 'side',
  maxHoursPerWeek: p.maxHoursPerWeek === null ? '' : String(p.maxHoursPerWeek),
  minHourlyPay: p.minHourlyPay === null ? '' : String(p.minHourlyPay),
});

/** A number field: null when empty, undefined when it is not a number in [min, max] (whole when `int`). */
function numberField(text: string, min: number, max: number, int: boolean): number | null | undefined {
  const s = text.trim().replace(',', '.');
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= min && n <= max && (!int || Number.isInteger(n)) ? n : undefined;
}

/** The profile to save, or a message for the first thing wrong. */
export function formToProfile(
  f: ProfileForm,
): { ok: true; value: SearchProfileInput } | { ok: false; error: string } {
  const floorText = f.salaryFloor.trim();
  const floor = floorText === '' ? null : Number(floorText);
  if (floor !== null && (!Number.isInteger(floor) || floor < 0))
    return { ok: false, error: 'Salary floor is a whole number, or empty.' };
  if (f.name.trim() === '') return { ok: false, error: 'Give the profile a name.' };
  const hours = f.side ? numberField(f.maxHoursPerWeek, 1, 60, true) : null;
  if (hours === undefined)
    return { ok: false, error: 'Max hours a week is a whole number from 1 to 60, or empty.' };
  const pay = f.side ? numberField(f.minHourlyPay, 0, 1000, false) : null;
  if (pay === undefined) return { ok: false, error: 'Min pay an hour is a number, or empty.' };
  const r = SearchProfileInputSchema.safeParse({
    name: f.name,
    roles: parseList(f.roles),
    keywords: parseList(f.keywords),
    excludeKeywords: parseList(f.excludeKeywords),
    locations: parseList(f.locations),
    countries: parseList(f.countries),
    languages: parseList(f.languages),
    excludedCompanies: parseList(f.excludedCompanies),
    seniority: f.side ? [] : f.seniority, // career-only fields are hidden for side jobs
    salaryFloor: f.side ? null : floor,
    currency: f.currency.trim() || null,
    remoteOk: f.remoteOk,
    enabled: f.enabled,
    kind: f.side ? 'side' : 'career',
    maxHoursPerWeek: hours,
    minHourlyPay: pay,
  });
  return r.success
    ? { ok: true, value: r.data }
    : { ok: false, error: 'Each list takes up to 50 entries of 100 characters, the currency up to 8.' };
}

/** One line for the profiles table: roles, else keywords. */
export const profileSummary = (p: Pick<SearchProfile, 'roles' | 'keywords'>): string =>
  formatList(p.roles.length > 0 ? p.roles : p.keywords) || '—';

// ---- discovery settings ----

export interface DiscoveryForm {
  threshold: string;
  perDay: string;
  fit: string;
  recency: string;
  source: string;
  salary: string;
}
export const toDiscoveryForm = (v: DiscoverySettings): DiscoveryForm => ({
  threshold: String(v.analyzeThreshold),
  perDay: String(v.maxAnalyzePerDay),
  fit: String(v.weights.fit),
  recency: String(v.weights.recency),
  source: String(v.weights.source),
  salary: String(v.weights.salary),
});

const num = (t: string): number | null => (t.trim() === '' || Number.isNaN(Number(t)) ? null : Number(t));

/** The settings to save (other stored values kept from `base`), or null while any field is invalid. */
export function buildDiscovery(f: DiscoveryForm, base: DiscoverySettings): DiscoverySettings | null {
  const r = DiscoverySettingsSchema.safeParse({
    ...base,
    analyzeThreshold: num(f.threshold),
    maxAnalyzePerDay: num(f.perDay),
    weights: { fit: num(f.fit), recency: num(f.recency), source: num(f.source), salary: num(f.salary) },
  });
  return r.success ? r.data : null;
}

export const sameDiscovery = (a: DiscoverySettings, b: DiscoverySettings): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

// ---- watchlist, key, schedule ----

/** Careers URLs are http(s) only; the main process does the real check and ATS detection. */
export const isCareersUrl = (v: string): boolean => /^https?:\/\/[^\s/]+\S*$/i.test(v.trim());

export const ATS_LABEL: Record<string, string> = {
  greenhouse: 'Greenhouse',
  lever: 'Lever',
  ashby: 'Ashby',
  smartrecruiters: 'SmartRecruiters',
  workable: 'Workable',
};

export const isScanTime = (v: string): boolean => /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
