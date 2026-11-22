import { describe, expect, it } from 'vitest';
import { checkNumbers, numbersIn } from '../../../src/shared/insights';

const DATA = 'adzuna: 5 applications, response rate 60%, interview rate 20%. median days 2.5';

describe('numbersIn', () => {
  it('reads counts, percentages and decimals; skips list markers and glued tokens', () => {
    expect(numbersIn('60% of 5, then 2.5 days')).toEqual([60, 5, 2.5]);
    expect(numbersIn('1. First\n2) Second')).toEqual([]);
    expect(numbersIn('Python3 and Q3 and v2')).toEqual([]);
  });
});

describe('checkNumbers', () => {
  const out = (answer: string, used: [string, string][]) => ({
    answer,
    numbers_used: used.map(([label, value]) => ({ label, value })),
  });

  it('passes when every number is listed and exists in the data', () => {
    const r = checkNumbers(
      out('Adzuna answered 60% of 5 applications.', [
        ['Adzuna response rate', '60%'],
        ['Adzuna applications', '5'],
      ]),
      DATA,
    );
    expect(r).toEqual({ ok: true, issues: [] });
  });

  it('fails a number in the answer that numbers_used does not list', () => {
    const r = checkNumbers(out('Adzuna answered 60% of 5.', [['rate', '60%']]), DATA);
    expect(r.ok).toBe(false);
    expect(r.issues).toEqual(['"5" is in the answer but not in numbers_used.']);
  });

  it('fails a listed number that is not in the data (a wrong or invented figure)', () => {
    const r = checkNumbers(out('Adzuna answered 75%.', [['rate', '75%']]), DATA);
    expect(r.ok).toBe(false);
    expect(r.issues).toEqual(['numbers_used "rate": 75 does not appear in the data.']);
  });

  it('fails a listed value with no number', () => {
    const r = checkNumbers(out('No numbers here.', [['rate', 'high']]), DATA);
    expect(r.issues).toEqual(['numbers_used "rate" has no number in "high".']);
  });

  it('an answer without numbers passes', () => {
    expect(checkNumbers(out('Apply to more roles.', []), DATA).ok).toBe(true);
  });
});
