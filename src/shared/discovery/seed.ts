import type { FrontMatter } from '../profile';
import { SENIORITY } from '../jobs/schemas';
import type { SearchProfileInput } from './schemas';

const LANG_CODES: Record<string, string> = { english: 'en', german: 'de', deutsch: 'de' };

/**
 * The first search profile, from the profile's front matter preferences. Without stated locations it follows
 * docs/13 question 1: Germany + EU remote + worldwide remote.
 */
export function seedSearchProfile(front: FrontMatter): SearchProfileInput {
  const p = front.preferences;
  const locations = p.locations.length > 0 ? p.locations : ['Germany'];
  return {
    name: 'My search',
    roles: p.roles.length > 0 ? p.roles : front.headline ? [front.headline] : [],
    keywords: [],
    excludeKeywords: [],
    locations,
    remoteOk: p.remote.toLowerCase() !== 'onsite',
    countries: p.locations.length > 0 ? [] : ['Germany'],
    seniority: p.seniority.filter((s): s is (typeof SENIORITY)[number] =>
      (SENIORITY as readonly string[]).includes(s),
    ),
    salaryFloor: p.salary_floor,
    currency: p.currency || null,
    languages: front.languages_spoken
      .map((l) => LANG_CODES[l.language.trim().toLowerCase()])
      .filter((l): l is string => !!l),
    excludedCompanies: p.companies_avoid,
    enabled: true,
  };
}
