import { describe, expect, it } from 'vitest';
import {
  checkTruth,
  experienceYears,
  extractQuantities,
  type ResumeContent,
} from '../../../src/shared/documents';
import type { Jd } from '../../../src/shared/jobs/schemas';
import { sampleJd } from '../../fixtures/jobs';
import { fullProfile, goodContent, seedPolicy } from '../../fixtures/resume';

// Regression tests for the adversarial review of B1 (each case was a verified bypass).
const today = new Date('2026-11-20');
const truth = (c: ResumeContent, jd: Jd | null = null) =>
  checkTruth(c, fullProfile, { policy: seedPolicy, jd, today });
const bullet = (text: string, entry = 'exp-globex', source_ids: string[] = []): ResumeContent => ({
  ...goodContent,
  experience: [{ entry_id: entry, bullets: [{ text, source_ids }] }],
});
const summary = (text: string): ResumeContent => ({ ...goodContent, summary: text });
const details = (c: ResumeContent, jd: Jd | null = null) =>
  truth(c, jd).violations.map((v) => `${v.kind}: ${v.detail}`);
const kinds = (c: ResumeContent, jd: Jd | null = null) => truth(c, jd).violations.map((v) => v.kind);

describe('quantities (review items 5, 6)', () => {
  it('reads multipliers, scale and vague words, written numbers and a decade', () => {
    const q = (s: string) => extractQuantities(s).map((x) => [x.value, x.unit]);
    expect(q('Doubled throughput, halved cost, twice as fast')).toEqual([
      [2, 'x'],
      [0.5, 'x'],
      [2, 'x'],
    ]);
    expect(q('x10, 10x, tenfold, 12-fold')).toEqual([
      [10, 'x'],
      [10, 'x'],
      [10, 'x'],
      [12, 'x'],
    ]);
    expect(q('six million users, thousands of teams, 3 billion rows')).toEqual([
      [6e6, 'user'],
      [1000, 'team'],
      [3e9, 'row'],
    ]);
    expect(q('twenty-five engineers, a decade, 5+ years, 40 per cent, $1.5k')).toEqual([
      [25, 'engineer'],
      [10, 'y'],
      [5, 'y'],
      [40, '%'],
      [1500, 'cur'],
    ]);
    expect(q('one of the first, no one else, one team')).toEqual([[1, 'team']]);
  });

  it.each([
    'Doubled throughput of SQL pipelines.',
    'Improved SQL pipeline speed x10.',
    'Made SQL pipelines tenfold faster.',
    'Owned the Airflow deployment for six million users.',
    'Owned the Airflow deployment serving thousands of teams.',
    'Owned the Airflow deployment for twenty teams.',
  ])('flags quantity words the source lacks: %s', (text) => {
    expect(kinds(bullet(text))).toEqual(['number_not_in_source']);
  });

  it('compares number+unit pairs, not a bag of numbers', () => {
    // the source has "10 min" and "2 h", not 10% or 2 teams
    expect(details(bullet('Cut cloud costs by 10% for 2 teams.'))).toEqual([
      'number_not_in_source: 10, 2 not found in the cited profile entries',
    ]);
    expect(kinds(bullet('Cut report runtime from 2 hours to 10 minutes.'))).toEqual([]);
    expect(kinds(bullet('Owned the Airflow deployment for 6 teams.'))).toEqual([]);
    expect(kinds(bullet('Owned the Airflow deployment for 6 users.'))).toEqual(['number_not_in_source']);
  });

  it('summary years: only from the summary/headline or up to the whole years in the experience dates', () => {
    expect(experienceYears(fullProfile, today)).toBe(6); // Jun 2020 – Feb 2022 + Mar 2022 – Nov 2026
    expect(kinds(summary('Data engineer with 6 years of experience.'))).toEqual([]);
    expect(kinds(summary('Data engineer with 7 years of experience.'))).toEqual(['number_not_in_source']);
    expect(kinds(summary('Data engineer with 10 years of experience.'))).toEqual(['number_not_in_source']);
    expect(details(summary('Data engineer with 4 years leading teams and a decade of experience.'))).toEqual([
      'number_not_in_source: decade not found in the cited profile entries',
    ]);
    // a skill's "years" column is not a summary source
    expect(kinds(summary('Data engineer who ran 2 teams.'))).toEqual(['number_not_in_source']);
  });

  it('summary numbers may restate entry facts with the same unit (eval false positive)', () => {
    const r = truth(
      summary('Data engineer at Globex who owns Airflow for six teams and cut runtime from 2 h to 10 min.'),
    );
    expect(r).toEqual({ ok: true, violations: [], warnings: [] });
    expect(kinds(summary('Data engineer who cut costs by 10%.'))).toEqual(['number_not_in_source']);
    expect(kinds(summary('Data engineer with 2022 commits.'))).toEqual(['number_not_in_source']);
  });
});

describe('skills in prose (review items 1, 3, 4)', () => {
  it('the summary may not name blocked skills', () => {
    expect(details(summary('Data engineer experienced with Kubernetes and Docker.'))).toEqual([
      'skill_not_allowed: Kubernetes has status "want"',
      'skill_not_allowed: Docker has status "learning" and learning skills are not allowed',
    ]);
    expect(kinds(summary('Data engineer working in Python, PostgreSQL and Airflow.'))).toEqual([]);
  });

  it('dictionary skills that are not in the profile are caught, JD or not', () => {
    expect(details(bullet('Rewrote SQL pipelines in Rust on Snowflake with Kafka.'))).toEqual([
      'skill_not_allowed: Rust is not in the profile',
      'skill_not_allowed: Snowflake is not in the profile',
      'skill_not_allowed: Apache Kafka is not in the profile',
    ]);
    expect(kinds(summary('AWS Certified data engineer.'))).toEqual(['skill_not_allowed']);
    // an ambiguous word in its everyday sense is not a skill
    expect(kinds(bullet('Helped six teams go live with SQL pipelines, a swift rollout.'))).toEqual([]);
  });

  it('a profile skill in a bullet needs the cited entries to show it', () => {
    const text = 'Built weekly dashboards in Python and Airflow on PostgreSQL.';
    expect(details(bullet(text, 'exp-initrode'))).toEqual([
      'skill_not_allowed: Python is not shown in the cited entries (exp-initrode); its evidence is exp-globex, proj-ledger',
      'skill_not_allowed: Airflow is not shown in the cited entries (exp-initrode); its evidence is exp-globex',
      'skill_not_allowed: PostgreSQL is not shown in the cited entries (exp-initrode); its evidence is exp-globex',
    ]);
    // citing an entry the skill row lists as evidence fixes it; so does the entry text naming it
    expect(kinds(bullet(text, 'exp-initrode', ['exp-globex']))).toEqual([]);
    expect(kinds(bullet('Built weekly dashboards in SQL.', 'exp-initrode'))).toEqual([]);
  });

  it('a skill approved for this job may appear without evidence', () => {
    const r = checkTruth(bullet('Owned the Airflow deployment and its Kafka topics.'), fullProfile, {
      policy: seedPolicy,
      jd: null,
      approvedSkills: ['Kafka'],
      today,
    });
    expect(r.violations).toEqual([]);
  });
});

describe('organisations and unverified terms (review item 3)', () => {
  it('organisations not in the profile are violations', () => {
    expect(details(bullet('Led a migration at Google and Meta to SQL pipelines.'))).toEqual([
      'unknown_organisation: "Google" is not an organisation in the profile',
      'unknown_organisation: "Meta" is not an organisation in the profile',
    ]);
    expect(kinds(bullet('Built SQL reports for Acme Corp and its six teams.'))).toEqual([
      'unknown_organisation',
    ]);
    expect(kinds(bullet('Owned the Airflow deployment at Globex for six teams.'))).toEqual([]);
    expect(kinds(bullet('Built SQL reports for Finance and Sales at Globex.'))).toEqual([]);
  });

  it('the target company may be named in the summary, never in a bullet', () => {
    const jd = { ...sampleJd };
    expect(
      kinds(summary('Data engineer ready to bring Python and SQL to Nimbus Analytics GmbH.'), jd),
    ).toEqual([]);
    expect(kinds(bullet('Built SQL pipelines for Nimbus Analytics GmbH.'), jd)).toEqual([
      'unknown_organisation',
    ]);
  });

  it('other capitalised terms the sources lack are warnings, not violations', () => {
    const r = truth(bullet('Owned the Airflow deployment for six teams across Zalando Berlin.'));
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual([
      expect.objectContaining({ kind: 'unverified_term', text: 'Zalando', path: 'experience[0].bullets[0]' }),
    ]);
  });
});

describe('skill-line labels (review item 2)', () => {
  it('only labels from the fixed list', () => {
    const c = (category_label: string): ResumeContent => ({
      ...goodContent,
      skills: [{ category_label, skills: ['Python'] }],
    });
    expect(kinds(c('Kubernetes, Rust, AWS Certified'))).toEqual(['label_not_allowed']);
    expect(kinds(c('Cloud & Tools'))).toEqual([]);
    expect(kinds(c('Languages'))).toEqual([]);
  });
});
