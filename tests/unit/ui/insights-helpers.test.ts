import { describe, expect, it } from 'vitest';
import type { Dimension } from '../../../src/shared/insights';
import {
  dimensionRows,
  ghostingText,
  medianText,
  pct,
} from '../../../src/renderer/src/features/insights/helpers';
import { MAX_WHAT_IF, toggleWhatIf, whatIfLine } from '../../../src/renderer/src/features/skills/helpers';

describe('Insights helpers', () => {
  const dim: Dimension = {
    key: 'source',
    title: 'Source',
    segments: [
      {
        label: 'adzuna',
        applications: 5,
        responses: 3,
        interviews: 1,
        responseRate: 0.6,
        interviewRate: 0.2,
        insufficient: false,
      },
      {
        label: 'manual',
        applications: 2,
        responses: 1,
        interviews: 0,
        responseRate: null,
        interviewRate: null,
        insufficient: true,
      },
    ],
  };

  it('rows carry the rate as a bar and as text; a small segment is greyed with no bars', () => {
    expect(dimensionRows(dim)).toEqual([
      {
        label: 'Adzuna',
        count: 5,
        cells: [
          { value: 0.6, text: '60%' },
          { value: 0.2, text: '20%' },
        ],
      },
      {
        label: 'Pasted by you',
        count: 2,
        cells: [
          { value: 0, text: '—' },
          { value: 0, text: '—' },
        ],
        muted: 'not enough data',
      },
    ]);
  });

  it('formats rates, the median and the ghosting rate', () => {
    expect(pct(0.4286)).toBe('43%');
    expect(pct(null)).toBe('—');
    expect(medianText({ medianDays: 2.5, responses: 4 })).toBe('2.5');
    expect(medianText({ medianDays: null, responses: 0 })).toBe('—');
    expect(ghostingText({ eligible: 2, ghosted: 1, rate: null, insufficient: true })).toBe('—');
    expect(ghostingText({ eligible: 5, ghosted: 2, rate: 0.4, insufficient: false })).toBe('40%');
  });
});

describe('Learning helpers', () => {
  it('the what-if selection holds at most three skills', () => {
    let sel: string[] = [];
    for (const k of ['a', 'b', 'c', 'd']) sel = toggleWhatIf(sel, k);
    expect(sel).toEqual(['a', 'b', 'c']);
    expect(sel).toHaveLength(MAX_WHAT_IF);
    expect(toggleWhatIf(sel, 'b')).toEqual(['a', 'c']);
  });

  it('the result line says how many stretch jobs would move', () => {
    expect(whatIfLine({ skills: ['dbt'], stretchJobs: 7, moved: [1, 2] })).toBe(
      'Learning dbt would move 2 of 7 stretch jobs to apply.',
    );
    expect(whatIfLine({ skills: ['dbt', 'Tableau'], stretchJobs: 1, moved: [1] })).toBe(
      'Learning dbt and Tableau would move 1 of 1 stretch job to apply.',
    );
    expect(whatIfLine({ skills: ['a', 'b', 'c'], stretchJobs: 3, moved: [] })).toBe(
      'Learning a, b and c would move none of your 3 stretch jobs to apply.',
    );
    expect(whatIfLine({ skills: ['dbt'], stretchJobs: 0, moved: [] })).toBe(
      'Learning dbt changes nothing yet: none of your open jobs is at stretch.',
    );
  });
});
