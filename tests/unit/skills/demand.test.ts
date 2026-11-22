import { describe, expect, it } from 'vitest';
import type { Jd } from '../../../src/shared/jobs/schemas';
import { computeDemand, demandKey, demandPriority } from '../../../src/shared/skills/demand';
import { sampleJd } from '../../fixtures/jobs';

const NOW = new Date('2026-11-20T12:00:00Z');
const daysAgo = (n: number): string => new Date(NOW.getTime() - n * 86_400_000).toISOString();
const jd = (...reqs: [kind: 'required' | 'preferred', ...skills: string[]][]): Jd => ({
  ...sampleJd,
  requirements: reqs.map(([kind, ...skills]) => ({ text: skills.join(', '), kind, skills })),
});
const by = (rows: ReturnType<typeof computeDemand>['all'], skill: string) =>
  rows.find((r) => r.skill === skill);

describe('computeDemand', () => {
  const jobs = [
    { at: daysAgo(5), jd: jd(['required', 'Python', 'SQL'], ['preferred', 'dbt']) },
    { at: daysAgo(20), jd: jd(['required', 'python'], ['preferred', 'Python']) }, // alias/case, listed twice
    { at: daysAgo(60), jd: jd(['preferred', 'Postgres', 'Python']) },
    { at: daysAgo(200), jd: jd(['required', 'Python', 'Kubernetes']) },
    { at: daysAgo(10), jd: null }, // never parsed: not counted anywhere
  ];
  const d = computeDemand(jobs, NOW);

  it('counts jobs per window and divides by jobs with a parsed JD in that window', () => {
    expect(by(d['30d'], 'Python')).toEqual({ skill: 'Python', jobCount: 2, share: 1, requiredShare: 1 });
    expect(by(d['90d'], 'Python')).toEqual({ skill: 'Python', jobCount: 3, share: 1, requiredShare: 2 / 3 });
    expect(by(d.all, 'Python')).toEqual({ skill: 'Python', jobCount: 4, share: 1, requiredShare: 3 / 4 });
  });

  it('separates required from preferred and canonicalises aliases', () => {
    expect(by(d['90d'], 'dbt')).toMatchObject({ jobCount: 1, share: 1 / 3, requiredShare: 0 });
    expect(by(d['90d'], 'PostgreSQL')).toMatchObject({ jobCount: 1, requiredShare: 0 });
    expect(by(d['30d'], 'PostgreSQL')).toBeUndefined();
  });

  it('leaves out skills that only appear outside the window', () => {
    expect(by(d['90d'], 'Kubernetes')).toBeUndefined();
    expect(by(d.all, 'Kubernetes')).toMatchObject({ jobCount: 1, share: 1 / 4 });
  });

  it('orders by job count, then name, and handles empty input', () => {
    expect(d.all.map((r) => r.skill).slice(0, 2)).toEqual(['Python', 'dbt']);
    expect(computeDemand([], NOW)).toEqual({ '30d': [], '90d': [], all: [] });
  });

  it('counts a job with an unreadable date only in `all`; a far-future date is not "recent"', () => {
    const odd = computeDemand(
      [
        { at: 'garbage', jd: jd(['required', 'Go']) },
        { at: daysAgo(-400), jd: jd(['required', 'Go']) },
      ],
      NOW,
    );
    expect(odd['90d']).toEqual([]);
    expect(by(odd.all, 'Go')?.jobCount).toBe(2);
  });

  it('shares stay within 0-1', () => {
    for (const w of Object.values(d))
      for (const r of w) {
        expect(r.share).toBeGreaterThan(0);
        expect(r.share).toBeLessThanOrEqual(1);
        expect(r.requiredShare).toBeLessThanOrEqual(r.share);
      }
  });
});

describe('demandKey and demandPriority', () => {
  it('uses the dictionary name when known', () => {
    expect(demandKey('Postgres')).toBe(demandKey('PostgreSQL'));
    expect(demandKey('  Some Thing ')).toBe('some thing');
  });

  it('maps demand to 1-5, required counting double', () => {
    expect(demandPriority(null)).toBe(1);
    expect(demandPriority({ share: 0.02, requiredShare: 0 })).toBe(1);
    expect(demandPriority({ share: 0.1, requiredShare: 0 })).toBe(2);
    expect(demandPriority({ share: 0.2, requiredShare: 0 })).toBe(3);
    expect(demandPriority({ share: 0.2, requiredShare: 0.2 })).toBe(4);
    expect(demandPriority({ share: 0.3, requiredShare: 0.3 })).toBe(5);
    expect(demandPriority({ share: 1, requiredShare: 1 })).toBe(5);
  });
});
