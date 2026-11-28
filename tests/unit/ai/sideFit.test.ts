import { describe, expect, it } from 'vitest';
import { validateSideFit } from '../../../src/main/ai/tasks/sideFit';
import { sideJobBrief, type SideBriefProfile } from '../../../src/main/services/discovery/triage';
import type { SideFitResult } from '../../../src/shared/jobs/schemas';

const POSTING = 'Aushilfe im Café, 10-12 Stunden pro Woche.\nGute Deutschkenntnisse.  15 € pro Stunde.';
const out = (o: Partial<SideFitResult> = {}): SideFitResult => ({
  side_score: 80,
  verdict: 'take',
  summary: 's',
  checks: [],
  ...o,
});

describe('validateSideFit', () => {
  it('keeps quotes the posting holds (whitespace and case aside) and drops invented ones', () => {
    const r = validateSideFit(
      out({
        checks: [
          { aspect: 'hours', status: 'ok', finding: 'f', quote: '10-12 stunden  pro Woche' },
          { aspect: 'pay', status: 'ok', finding: 'f', quote: '18 € pro Stunde' },
          { aspect: 'language', status: 'warn', finding: 'f', quote: '   ' },
        ],
      }),
      POSTING,
    );
    expect(r.checks.map((c) => c.quote)).toEqual(['10-12 stunden  pro Woche', null, null]);
    expect(r.checks.map((c) => c.finding)).toEqual(['f', 'f', 'f']);
  });
  it('keeps one check per aspect and puts the verdict in line with the score bands', () => {
    const twice = validateSideFit(
      out({
        checks: [
          { aspect: 'pay', status: 'ok', finding: 'first', quote: null },
          { aspect: 'pay', status: 'bad', finding: 'second', quote: null },
        ],
      }),
      POSTING,
    );
    expect(twice.checks).toHaveLength(1);
    expect(twice.checks[0]?.finding).toBe('first');
    expect(validateSideFit(out({ side_score: 75, verdict: 'skip' }), POSTING).verdict).toBe('take');
    expect(validateSideFit(out({ side_score: 50, verdict: 'take' }), POSTING).verdict).toBe('maybe');
    expect(validateSideFit(out({ side_score: 44, verdict: 'take' }), POSTING).verdict).toBe('skip');
  });
});

describe('sideJobBrief', () => {
  const p = (o: Partial<SideBriefProfile>): SideBriefProfile => ({
    kind: 'side',
    enabled: true,
    maxHoursPerWeek: 20,
    minHourlyPay: 13.9,
    locations: ['Berlin'],
    countries: [],
    languages: ['de'],
    remoteOk: false,
    currency: 'EUR',
    ...o,
  });
  it('uses the switched-on side profiles, the strictest limit winning', () => {
    const b = sideJobBrief([
      p({}),
      p({ maxHoursPerWeek: 12, minHourlyPay: 15 }),
      p({ kind: 'career', maxHoursPerWeek: 5 }),
    ]);
    expect(b).toContain('max hours per week: 12');
    expect(b).toContain('min hourly pay: 15 EUR');
  });
  it('falls back to switched-off side profiles, so old side jobs keep their limits', () => {
    const b = sideJobBrief([p({ enabled: false }), p({ kind: 'career', enabled: true })]);
    expect(b).toContain('max hours per week: 20');
    expect(b).toContain('places: Berlin');
    // a switched-on side profile wins over a switched-off one
    expect(sideJobBrief([p({ enabled: false, maxHoursPerWeek: 8 }), p({ maxHoursPerWeek: 16 })])).toContain(
      'max hours per week: 16',
    );
  });
});
