import { describe, expect, it } from 'vitest';
import {
  detectLanguage,
  detectSeniority,
  hardFilter,
  matchesQuery,
  wantsGermany,
} from '../../../src/shared/discovery/filters';
import { rank, sourceQuality } from '../../../src/shared/discovery/ranking';
import {
  catchUpDue,
  latestScheduled,
  nextScheduled,
  scheduledDue,
} from '../../../src/shared/discovery/schedule';
import {
  DEFAULT_DISCOVERY_SETTINGS,
  type NormalizedJob,
  type SearchProfile,
} from '../../../src/shared/discovery/schemas';
import { seedSearchProfile } from '../../../src/shared/discovery/seed';
import { hamming, isNearDuplicate, simhash } from '../../../src/shared/discovery/simhash';
import { FrontMatterSchema } from '../../../src/shared/profile';
import { NIMBUS_DESC, prose } from '../../fixtures/discovery';

import { job, profile } from './helpers';

const NOW = new Date('2026-11-21T12:00:00Z');
const f = (j: Partial<NormalizedJob>, p: Partial<SearchProfile> = {}): string | null =>
  hardFilter(job(j), profile(p), { now: NOW, maxAgeDays: 30 });

describe('simhash', () => {
  it('matches near-identical text and separates different text', () => {
    const a = simhash(NIMBUS_DESC);
    const b = simhash(`${NIMBUS_DESC} Apply now.`);
    const c = simhash(prose('Marketing campaigns for retail brands'));
    expect(a).not.toBeNull();
    expect(isNearDuplicate(a, b)).toBe(true);
    expect(isNearDuplicate(a, c)).toBe(false);
    expect(hamming(a as string, a as string)).toBe(0);
  });
  it('returns null for text too short to hash', () => {
    expect(simhash('Build pipelines.')).toBeNull();
    expect(isNearDuplicate(null, null)).toBe(false);
  });
});

describe('hard filters', () => {
  it('passes a matching job', () => expect(f({})).toBeNull());
  it('drops excluded companies and keywords', () => {
    expect(f({}, { excludedCompanies: ['nimbus'] })).toBe('excluded company');
    expect(f({ descriptionMd: 'We use Cobol.' }, { excludeKeywords: ['cobol'] })).toBe('excluded keyword');
  });
  it('drops postings older than N days', () => {
    expect(f({ postedAt: '2026-09-01T00:00:00Z' })).toBe('posting too old');
    expect(f({ postedAt: '2026-11-15T00:00:00Z' })).toBeNull();
  });
  it('checks location and remote', () => {
    expect(f({ locationText: 'Paris', city: 'Paris' })).toBe('location does not match');
    expect(f({ locationText: 'Munich', city: 'Munich' })).toBeNull(); // German city, profile wants Germany
    expect(f({ remote: 'remote', locationText: 'Worldwide' })).toBeNull();
    expect(f({ remote: 'remote', locationText: 'Europe' })).toBeNull();
    expect(f({ remote: 'remote', locationText: 'USA', city: null })).toBe(
      'remote but restricted to another region',
    );
    expect(f({ remote: 'remote', locationText: 'Germany, Austria' })).toBeNull();
    expect(f({ remote: 'remote', locationText: null })).toBeNull();
    expect(f({ remote: 'remote', locationText: 'Worldwide' }, { remoteOk: false })).toBe(
      'remote roles not wanted',
    );
    expect(f({ locationText: null, city: null })).toBeNull(); // unknown place is not a mismatch
  });
  it('checks seniority from the title', () => {
    expect(detectSeniority('Senior Data Engineer')).toBe('senior');
    expect(detectSeniority('Werkstudent Data (m/w/d)')).toBe('intern');
    expect(f({ title: 'Senior Data Engineer' }, { seniority: ['mid'] })).toBe('seniority does not match');
    expect(f({ title: 'Senior Data Engineer' }, { seniority: ['mid', 'senior'] })).toBeNull();
    expect(f({ title: 'Data Engineer' }, { seniority: ['senior'] })).toBeNull(); // unknown level passes
  });
  it('checks the salary floor only when pay and currency are known', () => {
    const pay = { salaryMin: 3000, salaryMax: 4000, salaryPeriod: 'month' as const, salaryCurrency: 'EUR' };
    expect(f(pay, { salaryFloor: 60000, currency: 'EUR' })).toBe('salary below floor'); // 48k a year
    expect(f({ ...pay, salaryMax: 6000 }, { salaryFloor: 60000, currency: 'EUR' })).toBeNull();
    expect(f(pay, { salaryFloor: 60000, currency: 'USD' })).toBeNull(); // different currency: unknown
    expect(f({}, { salaryFloor: 60000, currency: 'EUR' })).toBeNull(); // no pay stated
  });
  it('drops postings in a language the candidate does not speak', () => {
    const de =
      'Wir suchen für unser Team eine Person mit Erfahrung. Sie arbeiten mit der Datenplattform und den Daten der Kunden. '.repeat(
        4,
      );
    expect(detectLanguage(de)).toBe('de');
    expect(detectLanguage(NIMBUS_DESC)).toBe('en');
    expect(f({ descriptionMd: de }, { languages: ['en'] })).toBe('posting language not spoken');
    expect(f({ descriptionMd: de }, { languages: ['en', 'de'] })).toBeNull();
    expect(f({ descriptionMd: 'short' }, { languages: ['en'] })).toBeNull();
  });
  it('knows when a profile wants Germany and what a query-less source must match', () => {
    expect(wantsGermany({ locations: ['Berlin'], countries: [] })).toBe(true);
    expect(wantsGermany({ locations: ['Paris'], countries: ['France'] })).toBe(false);
    expect(matchesQuery(job({ title: 'Senior Data Platform Engineer' }), profile())).toBe(true);
    expect(matchesQuery(job({ title: 'Marketing Manager' }), profile())).toBe(false);
    expect(
      matchesQuery(
        job({ title: 'Marketing Manager', descriptionMd: 'uses dbt' }),
        profile({ keywords: ['dbt'] }),
      ),
    ).toBe(true);
    expect(matchesQuery(job({ title: 'Anything' }), profile({ roles: [] }))).toBe(true);
  });
});

describe('ranking', () => {
  const base = {
    score: 80,
    postedAt: NOW.toISOString(),
    firstSeenAt: NOW.toISOString(),
    sources: ['greenhouse'],
    salaryMin: null,
    salaryMax: null,
    salaryPeriod: null,
    salaryFloor: null,
  };
  const cfg = DEFAULT_DISCOVERY_SETTINGS;
  it('applies 0.6 fit + 0.15 recency + 0.15 source + 0.1 salary', () => {
    // 0.6*80 + 0.15*100 + 0.15*100 + 0.1*50 (salary unknown)
    expect(rank(base, NOW, cfg)).toBe(83);
  });
  it('rewards ATS over aggregator over web, fresh over old, higher pay fit', () => {
    expect(sourceQuality(['websearch'])).toBeLessThan(sourceQuality(['adzuna']));
    expect(sourceQuality(['adzuna'])).toBeLessThan(sourceQuality(['lever']));
    expect(sourceQuality(['adzuna', 'lever'])).toBe(100);
    const old = { ...base, postedAt: '2026-10-22T12:00:00Z' };
    expect(rank(old, NOW, cfg)).toBeLessThan(rank(base, NOW, cfg));
    const paid = { ...base, salaryMax: 90000, salaryPeriod: 'year', salaryFloor: 60000 };
    expect(rank(paid, NOW, cfg)).toBeGreaterThan(rank(base, NOW, cfg));
  });
  it('uses the weights from settings and a neutral score when nothing scored the job', () => {
    expect(
      rank({ ...base, score: 100 }, NOW, { ...cfg, weights: { fit: 1, recency: 0, source: 0, salary: 0 } }),
    ).toBe(100);
    expect(
      rank({ ...base, score: null }, NOW, { ...cfg, weights: { fit: 1, recency: 0, source: 0, salary: 0 } }),
    ).toBe(40);
  });
});

describe('schedule math', () => {
  const at = (s: string): Date => new Date(s);
  it('finds the latest and next daily time', () => {
    const now = new Date(2026, 10, 21, 9, 30);
    expect(latestScheduled(now, '08:00')).toEqual(new Date(2026, 10, 21, 8, 0));
    expect(latestScheduled(new Date(2026, 10, 21, 7, 0), '08:00')).toEqual(new Date(2026, 10, 20, 8, 0));
    expect(nextScheduled(now, '08:00')).toEqual(new Date(2026, 10, 22, 8, 0));
  });
  it('catches up when the last success is older than 24 h or missing', () => {
    const now = at('2026-11-21T12:00:00Z');
    expect(catchUpDue(null, now)).toBe(true);
    expect(catchUpDue(at('2026-11-20T11:00:00Z'), now)).toBe(true);
    expect(catchUpDue(at('2026-11-20T13:00:00Z'), now)).toBe(false);
  });
  it('runs on a tick once per day, also after a failed attempt', () => {
    const now = new Date(2026, 10, 21, 9, 0);
    expect(scheduledDue(now, '08:00', new Date(2026, 10, 20, 8, 5))).toBe(true);
    expect(scheduledDue(now, '08:00', new Date(2026, 10, 21, 8, 5))).toBe(false);
    expect(scheduledDue(new Date(2026, 10, 21, 7, 0), '08:00', new Date(2026, 10, 20, 8, 5))).toBe(false);
    expect(scheduledDue(now, '08:00', null)).toBe(true);
  });
});

describe('seed search profile', () => {
  it('follows docs/13: Germany + remote when the profile states nothing', () => {
    const s = seedSearchProfile(FrontMatterSchema.parse({ headline: 'Data Engineer' }));
    expect(s).toMatchObject({
      roles: ['Data Engineer'],
      locations: ['Germany'],
      countries: ['Germany'],
      remoteOk: true,
    });
  });
  it('takes roles, locations, seniority, salary and avoided companies from the preferences', () => {
    const s = seedSearchProfile(
      FrontMatterSchema.parse({
        languages_spoken: [
          { language: 'English', level: 'C1' },
          { language: 'German', level: 'A2' },
        ],
        preferences: {
          roles: ['ML Engineer'],
          locations: ['Berlin'],
          seniority: ['senior', 'bogus'],
          remote: 'onsite',
          salary_floor: 70000,
          currency: 'EUR',
          companies_avoid: ['Evil Corp'],
        },
      }),
    );
    expect(s).toMatchObject({
      roles: ['ML Engineer'],
      locations: ['Berlin'],
      countries: [],
      seniority: ['senior'],
      remoteOk: false,
      salaryFloor: 70000,
      currency: 'EUR',
      excludedCompanies: ['Evil Corp'],
      languages: ['en', 'de'],
    });
  });
});
