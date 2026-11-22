import { describe, expect, it } from 'vitest';
import { demandKey } from '../../../src/shared/skills/demand';
import {
  normalizePriorities,
  rawPriority,
  roadmapSummary,
  unlockedJobs,
  whatIf,
  type RoadmapJob,
} from '../../../src/shared/skills/roadmap';
import { computeNudges, type NudgeInput } from '../../../src/shared/skills/nudges';

const T = demandKey('Tableau');
const D = demandKey('dbt');
const job = (id: string, o: Partial<RoadmapJob>): RoadmapJob => ({
  id,
  company: `Co ${id}`,
  title: `Role ${id}`,
  fit: 60,
  verdict: 'stretch',
  missingRequired: [],
  missingPreferred: [],
  ...o,
});
const JOBS = [
  job('j1', { fit: 62, missingRequired: [T], missingPreferred: [D] }),
  job('j2', { fit: 66, missingRequired: [T, D] }),
  job('j3', { fit: 50, missingRequired: [T] }),
  job('j4', { fit: 80, verdict: 'apply' }),
];

describe('unlockedJobs', () => {
  it('counts jobs whose only missing required skill is this one', () => {
    expect(unlockedJobs('Tableau', JOBS).map((j) => j.id)).toEqual(['j1', 'j3']);
    expect(unlockedJobs('dbt', JOBS)).toEqual([]); // j2 also misses Tableau
    expect(unlockedJobs('tableau', JOBS)).toHaveLength(2); // any spelling
  });
});

describe('priority', () => {
  // Tableau: share 0.5, required 0.4 -> weight 0.4 x 2 + 0.1 = 0.9; uplift 1 + 2/4 = 1.5; 25 h -> 0.054
  // dbt:     share 0.3, required 0.1 -> weight 0.1 x 2 + 0.2 = 0.4; uplift 1 + 0/4 = 1;   10 h -> 0.04
  const tableau = rawPriority({ share: 0.5, requiredShare: 0.4 }, 2, 4, 25);
  const dbt = rawPriority({ share: 0.3, requiredShare: 0.1 }, 0, 4, 10);

  it('raw priority = demand weight x fit-uplift / hours', () => {
    expect(tableau).toBeCloseTo(0.054, 6);
    expect(dbt).toBeCloseTo(0.04, 6);
  });
  it('normalises to 1-5 against the best item', () => {
    expect(normalizePriorities([tableau, dbt])).toEqual([5, 4]);
    expect(normalizePriorities([0.054, 0.001])).toEqual([5, 1]);
    expect(normalizePriorities([0, 0])).toEqual([1, 1]);
    expect(normalizePriorities([])).toEqual([]);
  });
  it('a missing estimate counts as 40 hours; no demand scores 0', () => {
    expect(rawPriority({ share: 0.4, requiredShare: 0.4 }, 0, 0, null)).toBeCloseTo((0.8 * 1) / 40, 9);
    expect(rawPriority(null, 3, 4, 10)).toBe(0);
  });
  it('the summary states demand, labelled hours and unlocked jobs', () => {
    expect(roadmapSummary('Tableau', { jobCount: 10, share: 0.5, requiredShare: 0.41 }, 25, 9)).toBe(
      'Tableau: required in 41% of your jobs, ~25 h (estimate) to working level, unlocks 9 jobs in your inbox.',
    );
    expect(roadmapSummary('Rust', null, null, 1)).toBe(
      'Rust: not named by your stored jobs, no hours estimate yet, unlocks 1 job in your inbox.',
    );
  });
});

describe('whatIf', () => {
  it('Tableau alone moves j2 (66 + 6 = 72); j1 stays at 68 and j3 at 56', () => {
    const r = whatIf(['Tableau'], JOBS);
    expect(r.stretchJobs).toBe(3);
    expect(r.moved).toEqual([{ jobId: 'j2', company: 'Co j2', title: 'Role j2', before: 66, after: 72 }]);
  });
  it('Tableau + dbt also moves j1 (62 + 6 + 3 = 71) and j2 (66 + 6 + 6 = 78)', () => {
    const r = whatIf(['Tableau', 'dbt'], JOBS);
    expect(r.moved.map((m) => [m.jobId, m.before, m.after])).toEqual([
      ['j1', 62, 71],
      ['j2', 66, 78],
    ]);
  });
  it('ignores jobs that are not at stretch, unscored jobs and unrelated skills', () => {
    expect(whatIf(['Rust'], JOBS).moved).toEqual([]);
    expect(whatIf(['Tableau'], [job('x', { fit: null, missingRequired: [T] })]).moved).toEqual([]);
    expect(whatIf(['Tableau'], [JOBS[3] as RoadmapJob]).stretchJobs).toBe(0);
  });
});

describe('computeNudges', () => {
  const now = new Date('2026-11-21T12:00:00Z');
  const input = (o: Partial<NudgeInput>): NudgeInput => ({
    now,
    lastReviewed: '',
    skills: [],
    resumeSkills: [],
    doing: [],
    ...o,
  });

  it('a skill last used over 3 years ago that is still on resumes', () => {
    const n = computeNudges(
      input({
        skills: [
          { skill: 'Perl', lastUsed: '2021', status: 'have' }, // ended 2021-12-31, before 2023-11-21
          { skill: 'jQuery', lastUsed: '2023', status: 'have' }, // ended 2023-12-31, still inside 3 years
          { skill: 'Cobol', lastUsed: '2019', status: 'have' }, // stale but not on a resume
          { skill: 'Fortran', lastUsed: '2019', status: 'learning' },
          { skill: 'Python', lastUsed: 'now', status: 'have' },
        ],
        resumeSkills: ['perl', 'jQuery', 'Fortran', 'Python'],
      }),
    );
    expect(n.map((x) => [x.kind, x.skill])).toEqual([['stale_skill', 'Perl']]);
  });

  it('a high-demand skill "doing" for over 6 months', () => {
    const n = computeNudges(
      input({
        doing: [
          {
            skill: 'dbt',
            updatedAt: '2026-03-01T10:00:00Z',
            demand: { jobCount: 5, share: 0.5, requiredShare: 0.4 },
          },
          {
            skill: 'Rust',
            updatedAt: '2026-02-01T10:00:00Z',
            demand: { jobCount: 1, share: 0.02, requiredShare: 0 },
          },
          {
            skill: 'Airflow',
            updatedAt: '2026-10-01T10:00:00Z',
            demand: { jobCount: 5, share: 0.5, requiredShare: 0.4 },
          },
        ],
      }),
    );
    expect(n.map((x) => [x.kind, x.skill])).toEqual([['stuck_learning', 'dbt']]);
    expect(n[0]?.text).toContain('9 months');
  });

  it('a profile not reviewed for over 30 days; never set or recent gives nothing', () => {
    expect(computeNudges(input({ lastReviewed: '2026-10-10' }))).toEqual([
      { kind: 'profile_review', skill: null, text: 'Profile last reviewed 42 days ago', to: '/profile' },
    ]);
    expect(computeNudges(input({ lastReviewed: '2026-11-01' }))).toEqual([]);
    expect(computeNudges(input({ lastReviewed: '' }))).toEqual([]);
  });
});
