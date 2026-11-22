import { describe, expect, it } from 'vitest';
import {
  levelOf,
  rankPeople,
  groundForSearch,
  sharedGroundFrom,
  validateCandidates,
  type RankTarget,
  type RawCandidate,
} from '../../../src/shared/referrals';
import { fullProfile } from '../../fixtures/resume';
import { COMPANY, TEAM_PAGE, jane, john } from '../../fixtures/referrals';

const now = new Date('2026-11-21T10:00:00Z');
const ground = sharedGroundFrom(fullProfile);
const target: RankTarget = { roleKeywords: ['data engineer'], location: 'Berlin, Germany' };
const rank = (raw: RawCandidate[], t: RankTarget = target) =>
  rankPeople(validateCandidates(raw, { company: COMPANY, now }).people, t, ground, now);
const person = (name: string, title: string, extra: Partial<RawCandidate> = {}): RawCandidate =>
  john({
    full_name: name,
    title,
    profile_urls: [`https://github.com/${name.toLowerCase().replace(/\W+/g, '-')}`],
    facts: [{ text: `${title} at Nimbus Analytics`, source_url: TEAM_PAGE }],
    why: '',
    ...extra,
  });

describe('sharedGroundFrom', () => {
  it('lists institutions, employers, languages, city and projects, never contact data', () => {
    const g = sharedGroundFrom(fullProfile);
    expect(g).toEqual(
      expect.arrayContaining([
        { kind: 'education', label: 'Example University' },
        { kind: 'employer', label: 'Globex' },
        { kind: 'employer', label: 'Initrode' },
        { kind: 'language', label: 'German' },
        { kind: 'city', label: 'Berlin' },
        { kind: 'project', label: 'Ledger' },
      ]),
    );
    const text = JSON.stringify(g);
    expect(text).not.toMatch(/@|\+49|example\.test/);
  });
});

describe('groundForSearch', () => {
  it('drops city and project titles, keeps education, employers and languages', () => {
    const kinds = new Set(groundForSearch(sharedGroundFrom(fullProfile)).map((g) => g.kind));
    expect([...kinds].sort()).toEqual(['education', 'employer', 'language']);
  });
});

describe('levelOf', () => {
  it.each([
    ['Senior Data Engineer', 'senior'],
    ['Staff Software Engineer', 'senior'],
    ['Data Engineer', 'mid'],
    ['Engineering Manager', 'manager'],
    ['VP Engineering', 'executive'],
    ['Head of Data', 'executive'],
    ['Chief Technology Officer', 'executive'],
    ['Junior Developer', 'junior'],
    ['Werkstudent Data', 'junior'],
  ])('%s is %s', (title, level) => {
    expect(levelOf(title)).toBe(level);
  });
});

describe('rankPeople', () => {
  it('prefers a peer or senior IC over an executive, and the same role over another role', () => {
    const r = rank([
      person('Vera Vice', 'VP Data Engineer'),
      person('Mia Mid', 'Data Engineer'),
      person('Sam Senior', 'Senior Data Engineer'),
      person('Olga Other', 'Office Manager'),
    ]);
    expect(r.map((x) => x.person.fullName)).toEqual(['Sam Senior', 'Mia Mid', 'Vera Vice', 'Olga Other']);
    expect(r[0]?.score).toBeGreaterThan(r[1]?.score ?? 100);
    expect(r.every((x) => x.score >= 0 && x.score <= 100)).toBe(true);
  });

  it('adds shared ground that appears in the person facts and names it', () => {
    const r = rank([jane({ why: '' }), person('Plain Person', 'Senior Data Engineer')]);
    expect(r[0]?.person.fullName).toBe('Jane Doe');
    expect(r[0]?.sharedGround).toContain('Example University');
    expect(r[0]?.why).toMatch(/Shares Example University/);
    expect(r[1]?.sharedGround).not.toContain('Example University');
  });

  it('counts team, location, seniority hints, alumni and recent activity', () => {
    const base = rank([person('Plain Person', 'Data Engineer')])[0]?.score ?? 0;
    const team = rank(
      [
        person('Plain Person', 'Data Engineer', {
          facts: [{ text: 'Data Engineer at Nimbus Analytics on the payments team', source_url: TEAM_PAGE }],
        }),
      ],
      {
        ...target,
        team: 'payments',
      },
    )[0]?.score;
    expect(team).toBeGreaterThan(base);
    const senior = rank([person('Plain Person', 'Senior Data Engineer')], {
      ...target,
      seniority: 'senior',
    })[0]?.score;
    const noHint = rank([person('Plain Person', 'Senior Data Engineer')])[0]?.score;
    expect(senior).toBeGreaterThan(noHint ?? 100);
    const active = rank([
      person('Plain Person', 'Data Engineer', {
        facts: [{ text: 'Data Engineer at Nimbus Analytics; gave a talk in 2026', source_url: TEAM_PAGE }],
      }),
    ])[0];
    expect(active?.score).toBeGreaterThan(base);
    expect(active?.signals).toContain('recent public activity');
    const none: RankTarget = { roleKeywords: ['astronaut'] };
    const alumni = rank([jane()], { ...none, alumni: ['Example University'] })[0]?.score;
    expect(alumni).toBeGreaterThan(rank([jane()], none)[0]?.score ?? 100);
  });

  it("keeps the model's why when present and builds one from signals when empty", () => {
    const [a] = rank([jane({ why: '  same team as the role  ' })]);
    expect(a?.why).toBe('Same team as the role');
    const [b] = rank([jane({ why: '' })]);
    expect(b?.why.length).toBeGreaterThan(5);
    const [c] = rank([person('Nobody Special', 'Office Manager')], { roleKeywords: ['astronaut'] });
    expect(c?.why).toBeTruthy();
  });

  it('is deterministic: ties sort by name', () => {
    const r = rank([person('Zed Zulu', 'Data Engineer'), person('Abe Alpha', 'Data Engineer')]);
    expect(r.map((x) => x.person.fullName)).toEqual(['Abe Alpha', 'Zed Zulu']);
  });
});
