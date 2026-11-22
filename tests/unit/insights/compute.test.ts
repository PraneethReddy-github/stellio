import { describe, expect, it } from 'vitest';
import {
  computeInsights,
  daysBand,
  fitBand,
  roleFamily,
  seniorityLabel,
  type InsightApp,
} from '../../../src/shared/insights';

const NOW = new Date('2026-11-21T12:00:00Z');
const DAY = 86_400_000;
const base: InsightApp = {
  appliedAt: '2026-11-01T10:00:00Z',
  status: 'applied',
  events: [],
  interviews: [],
  source: 'adzuna',
  title: 'Data Engineer',
  seniority: null,
  fit: 60,
  remote: 'remote',
  postedAt: '2026-10-31T10:00:00Z',
  coverLetter: false,
  skills: [],
};
const app = (o: Partial<InsightApp>): InsightApp => ({ ...base, ...o });
const change = (toStatus: InsightApp['status'], at: string) => ({ type: 'status_change', toStatus, at });

// Hand-computed fixture. The 90-day window (from 2026-08-23) keeps everything but the August application.
const FIXTURE: InsightApp[] = [
  app({
    appliedAt: '2026-11-01T10:00:00Z',
    status: 'screening',
    events: [change('screening', '2026-11-04T10:00:00Z')],
    title: 'Senior Data Engineer',
    seniority: 'senior',
    fit: 90,
    postedAt: '2026-10-30T10:00:00Z',
    coverLetter: true,
    skills: ['Python', 'SQL'],
  }),
  app({
    appliedAt: '2026-11-02T10:00:00Z',
    status: 'rejected',
    events: [change('rejected', '2026-11-12T10:00:00Z')],
    fit: 75,
    postedAt: '2026-10-20T10:00:00Z',
    skills: ['Python'],
  }),
  app({
    appliedAt: '2026-11-03T10:00:00Z',
    title: 'Data Analyst',
    fit: 60,
    remote: 'hybrid',
    postedAt: '2026-11-01T10:00:00Z',
    skills: ['SQL'],
  }),
  app({
    appliedAt: '2026-11-04T10:00:00Z',
    status: 'interviewing',
    events: [change('interviewing', '2026-11-06T10:00:00Z')],
    interviews: [{ outcome: 'pending' }],
    title: 'Senior Data Scientist',
    seniority: 'senior',
    fit: 88,
    postedAt: '2026-10-01T10:00:00Z',
    coverLetter: true,
    skills: ['Python', 'SQL', 'Spark'],
  }),
  app({
    appliedAt: '2026-11-05T10:00:00Z',
    title: 'Backend Developer',
    fit: 45,
    remote: 'onsite',
    postedAt: '2026-11-04T10:00:00Z',
    skills: ['Go'],
  }),
  // greenhouse: one outside the 90-day window, two inside
  app({ source: 'greenhouse', appliedAt: '2026-08-01T10:00:00Z', status: 'ghosted' }),
  app({ source: 'greenhouse', appliedAt: '2026-11-10T10:00:00Z' }),
  app({
    source: 'greenhouse',
    appliedAt: '2026-11-11T10:00:00Z',
    status: 'acknowledged',
    events: [change('acknowledged', '2026-11-12T10:00:00Z')],
  }),
];

type Summary = ReturnType<typeof computeInsights>;
const seg = (s: Summary, dim: string, label: string) =>
  s.dimensions.find((d) => d.key === dim)?.segments.find((x) => x.label === label);
const counts = (s: Summary, dim: string) =>
  s.dimensions.find((d) => d.key === dim)?.segments.map((x) => [x.label, x.applications]);

describe('computeInsights (hand-computed fixture)', () => {
  const s = computeInsights(FIXTURE, '90d', NOW);

  it('totals: 7 applications, 4 replies (screening, rejected, interviewing, acknowledged), 1 interview', () => {
    expect(s.totals).toMatchObject({ applications: 7, responses: 4, interviews: 1 });
    expect(s.totals.responseRate).toBeCloseTo(4 / 7);
    expect(s.totals.interviewRate).toBeCloseTo(1 / 7);
  });

  it('the all-time window also counts the August application', () => {
    expect(computeInsights(FIXTURE, 'all', NOW).totals.applications).toBe(8);
  });

  it('source: adzuna has 5 applications, 60 % replies, 20 % interviews; greenhouse (2) is insufficient', () => {
    const a = seg(s, 'source', 'adzuna');
    expect(a).toMatchObject({ applications: 5, responses: 3, interviews: 1, insufficient: false });
    expect(a?.responseRate).toBeCloseTo(0.6);
    expect(a?.interviewRate).toBeCloseTo(0.2);
    expect(seg(s, 'source', 'greenhouse')).toMatchObject({
      applications: 2,
      responses: 1,
      insufficient: true,
      responseRate: null,
      interviewRate: null,
    });
    expect(counts(s, 'source')).toEqual([
      ['adzuna', 5],
      ['greenhouse', 2],
    ]);
  });

  it('role family and seniority', () => {
    expect(counts(s, 'roleFamily')).toEqual([
      ['Data engineering', 4], // Senior Data Engineer, Data Engineer, two greenhouse defaults
      ['Analytics / BI', 1],
      ['Data science / ML', 1],
      ['Software engineering', 1],
    ]);
    expect(counts(s, 'seniority')).toEqual([
      ['Senior', 2],
      ['Not stated', 5],
    ]);
  });

  it('fit band, remote type and cover letter', () => {
    // fits: 90, 75, 60, 88, 45, 60 (greenhouse), 60 (greenhouse)
    expect(counts(s, 'fitBand')).toEqual([
      ['0-49', 1],
      ['50-69', 3],
      ['70-84', 1],
      ['85+', 2],
    ]);
    expect(counts(s, 'remote')).toEqual([
      ['Remote', 5],
      ['Hybrid', 1],
      ['On-site', 1],
    ]);
    expect(counts(s, 'coverLetter')).toEqual([
      ['With cover letter', 2],
      ['Without cover letter', 5],
    ]);
  });

  it('days since posting at application: 2, 13, 2, 34, 1 days (adzuna), 10 and 11 days (greenhouse)', () => {
    expect(counts(s, 'daysSincePosting')).toEqual([
      ['0-3 days', 3],
      ['8-14 days', 3],
      ['15+ days', 1],
    ]);
  });

  it('skills on the final resume are counted per skill, most common first', () => {
    expect(counts(s, 'skills')).toEqual([
      ['Python', 3],
      ['SQL', 3],
      ['Go', 1],
      ['Spark', 1],
    ]);
  });

  it('median time to first response is 2.5 days (1, 2, 3 and 10)', () => {
    expect(s.timeToResponse).toEqual({ medianDays: 2.5, responses: 4 });
  });

  it('ghosting has no rate below 5 applications that are 30 days old', () => {
    expect(s.ghosting).toMatchObject({ eligible: 0, ghosted: 0, rate: null, insufficient: true });
  });
});

describe('ghosting rate', () => {
  const old = (day: number, o: Partial<InsightApp>): InsightApp =>
    app({ appliedAt: `2026-09-0${String(day)}T10:00:00Z`, ...o });
  const apps = [
    old(1, { status: 'rejected', events: [change('rejected', '2026-09-10T10:00:00Z')] }),
    old(2, { status: 'applied' }), // 80 days, never answered: ghosted
    old(3, { status: 'ghosted' }),
    old(4, { status: 'withdrawn' }), // not awaiting: not ghosted
    old(5, { status: 'interviewing', events: [change('interviewing', '2026-09-08T10:00:00Z')] }),
    app({ appliedAt: '2026-11-15T10:00:00Z' }), // 6 days old: not eligible
  ];
  it('2 of 5 eligible applications were ghosted', () => {
    const g = computeInsights(apps, 'all', NOW).ghosting;
    expect(g).toMatchObject({ eligible: 5, ghosted: 2, insufficient: false });
    expect(g.rate).toBeCloseTo(0.4);
  });
});

describe('normalizers', () => {
  it('role family', () => {
    expect(roleFamily('Senior Data Engineer (m/f/d)')).toBe('Data engineering');
    expect(roleFamily('Machine Learning Engineer')).toBe('Data science / ML');
    expect(roleFamily('Analytics Engineer')).toBe('Data engineering');
    expect(roleFamily('BI Developer')).toBe('Analytics / BI');
    expect(roleFamily('Site Reliability Engineer')).toBe('DevOps / platform');
    expect(roleFamily('Backend-Entwickler')).toBe('Software engineering');
    expect(roleFamily('Barista')).toBe('Other');
  });
  it('seniority prefers the JD, then the title', () => {
    expect(seniorityLabel('mid', 'Senior Engineer')).toBe('Mid');
    expect(seniorityLabel(null, 'Senior Engineer')).toBe('Senior');
    expect(seniorityLabel(null, 'Junior Data Analyst')).toBe('Junior');
    expect(seniorityLabel(null, 'Data Engineer')).toBe('Not stated');
  });
  it('fit band edges', () => {
    expect([0, 49, 50, 69, 70, 84, 85, 100].map(fitBand)).toEqual([
      '0-49',
      '0-49',
      '50-69',
      '50-69',
      '70-84',
      '70-84',
      '85+',
      '85+',
    ]);
    expect(fitBand(null)).toBe('Not scored');
  });
  it('days band edges', () => {
    const applied = '2026-11-20T10:00:00Z';
    const at = (d: number): string =>
      daysBand(new Date(Date.parse(applied) - d * DAY).toISOString(), applied);
    expect([0, 3, 4, 7, 8, 14, 15, 40].map(at)).toEqual([
      '0-3 days',
      '0-3 days',
      '4-7 days',
      '4-7 days',
      '8-14 days',
      '8-14 days',
      '15+ days',
      '15+ days',
    ]);
    expect(daysBand(null, applied)).toBe('Posting date unknown');
  });
});
