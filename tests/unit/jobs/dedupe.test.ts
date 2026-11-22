import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  dedupeKey,
  normalizeCompany,
  normalizeLocation,
  normalizeTitle,
} from '../../../src/shared/jobs/dedupe';

describe('normalizeCompany', () => {
  it('ignores case, punctuation and legal suffixes', () => {
    expect(normalizeCompany('Nimbus Analytics GmbH')).toBe('nimbus analytics');
    expect(normalizeCompany('NIMBUS  analytics, Inc.')).toBe('nimbus analytics');
    expect(normalizeCompany('Acme Co. Ltd')).toBe('acme');
  });
  it('folds diacritics and ß', () => {
    expect(normalizeCompany('Müller & Söhne KG')).toBe('muller and sohne');
    expect(normalizeCompany('Straße AG')).toBe('strasse');
  });
  it('keeps the name when it is only a suffix', () => {
    expect(normalizeCompany('GmbH')).toBe('gmbh');
  });
});

describe('normalizeTitle', () => {
  it('drops gender markers', () => {
    expect(normalizeTitle('Data Engineer (m/w/d)')).toBe('data engineer');
    expect(normalizeTitle('Data Engineer (f/m/x)')).toBe('data engineer');
    expect(normalizeTitle('Data Engineer m/f/d')).toBe('data engineer');
  });
  it('normalizes case, punctuation and spacing', () => {
    expect(normalizeTitle('  Senior  Backend-Engineer, Java ')).toBe('senior backend engineer java');
  });
});

describe('normalizeLocation', () => {
  it('uses "remote" for remote roles regardless of city', () => {
    expect(normalizeLocation('Berlin', 'remote')).toBe('remote');
  });
  it('uses the folded city otherwise', () => {
    expect(normalizeLocation('München', 'hybrid')).toBe('munchen');
    expect(normalizeLocation(null, 'unknown')).toBe('');
  });
});

describe('dedupeKey', () => {
  it('matches the same job written two ways', () => {
    const a = dedupeKey({
      company: 'Nimbus Analytics GmbH',
      title: 'Data Engineer (m/w/d)',
      city: 'Berlin',
      remote: 'hybrid',
    });
    const b = dedupeKey({
      company: 'nimbus analytics',
      title: 'DATA ENGINEER',
      city: 'berlin',
      remote: 'onsite',
    });
    expect(a).toBe(b);
    expect(a).toBe('nimbus analytics|data engineer|berlin');
  });
  it('separates different cities, titles and companies', () => {
    const base = { company: 'Acme', title: 'Engineer', city: 'Berlin', remote: 'onsite' };
    expect(dedupeKey(base)).not.toBe(dedupeKey({ ...base, city: 'Hamburg' }));
    expect(dedupeKey(base)).not.toBe(dedupeKey({ ...base, title: 'Senior Engineer' }));
    expect(dedupeKey(base)).not.toBe(dedupeKey({ ...base, company: 'Acme Robotics' }));
  });
  it('is idempotent on its own parts', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(normalizeTitle(normalizeTitle(s))).toBe(normalizeTitle(s));
        expect(normalizeCompany(normalizeCompany(s))).toBe(normalizeCompany(s));
      }),
    );
  });
});
