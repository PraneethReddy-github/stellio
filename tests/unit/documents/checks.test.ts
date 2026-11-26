import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  checkAts,
  checkTruth,
  extractNumbers,
  lintContent,
  lintResume,
  renderResume,
  type ResumeContent,
} from '../../../src/shared/documents';
import type { Jd } from '../../../src/shared/jobs/schemas';
import type { Profile } from '../../../src/shared/profile';
import { sampleJd } from '../../fixtures/jobs';
// The checks are template-agnostic; these tests use the format 1 template, whose output they were written for.
import {
  airflowBullet,
  fullProfile,
  goodContent,
  seedPolicy,
  v1Rules as seedRules,
  v1Template as seedTemplate,
} from '../../fixtures/resume';

const truth = (
  c: ResumeContent,
  extra: { jd?: Jd | null; approvedSkills?: string[]; profile?: Profile } = {},
) =>
  checkTruth(c, extra.profile ?? fullProfile, {
    policy: seedPolicy,
    jd: extra.jd ?? null,
    approvedSkills: extra.approvedSkills,
    today: new Date('2026-11-20'),
  });
const withBullet = (text: string, source_ids: string[] = []): ResumeContent => ({
  ...goodContent,
  experience: [{ entry_id: 'exp-globex', bullets: [{ text, source_ids }] }],
});
const kinds = (c: ResumeContent, extra = {}) => truth(c, extra).violations.map((v) => v.kind);

describe('extractNumbers', () => {
  it('normalises separators, suffixes, percent and number words', () => {
    expect(extractNumbers('Cut 40% of 1,200 jobs, saving $1.5k for six teams')).toEqual([
      '40',
      '1200',
      '1500',
      '6',
    ]);
    expect(extractNumbers('40 percent')).toEqual(['40']);
    expect(extractNumbers('Ran on EC2 and S3 with k8s')).toEqual([]);
    expect(extractNumbers('2 h to 10min, 3 months')).toEqual(['2', '10', '3']);
    expect(extractNumbers('1.200.000 rows, 2,5 TB')).toEqual(['1200000', '2.5']);
  });
});

describe('checkTruth', () => {
  it('passes truthful content', () => {
    expect(truth(goodContent)).toEqual({ ok: true, violations: [], warnings: [] });
  });

  it('catches numbers that are not in the cited entries', () => {
    const r = truth(withBullet('Cut nightly report runtime by 85% for 6 teams.'));
    expect(r.ok).toBe(false);
    expect(r.violations).toEqual([
      expect.objectContaining({
        kind: 'number_not_in_source',
        path: 'experience[0].bullets[0]',
        detail: expect.stringContaining('85') as string,
      }),
    ]);
  });

  it('a number from another entry counts only when that entry is cited', () => {
    const text = 'Built weekly dashboards and cut nightly runtime from 2 h to 10 min.';
    const c = (source_ids: string[]): ResumeContent => ({
      ...goodContent,
      experience: [{ entry_id: 'exp-initrode', bullets: [{ text, source_ids }] }],
    });
    expect(kinds(c([]))).toEqual(['number_not_in_source']);
    expect(kinds(c(['exp-globex']))).toEqual([]);
  });

  it('flags invented summary numbers', () => {
    expect(kinds({ ...goodContent, summary: 'Data engineer with 9 years of experience.' })).toEqual([
      'number_not_in_source',
    ]);
  });

  it('flags unknown entry ids and unknown source ids', () => {
    expect(kinds({ ...goodContent, experience: [{ entry_id: 'exp-acme', bullets: [] }] })).toEqual([
      'unknown_id',
    ]);
    expect(kinds(withBullet('Owned the Airflow deployment.', ['exp-nope']))).toEqual(['unknown_id']);
  });

  it('flags entries cited in the wrong section and excluded entries', () => {
    expect(kinds({ ...goodContent, experience: [{ entry_id: 'proj-ledger', bullets: [] }] })).toEqual([
      'entry_not_in_profile',
    ]);
    const profile: Profile = {
      ...fullProfile,
      experience: fullProfile.experience.map((e) =>
        e.id === 'exp-initrode' ? { ...e, meta: { ...e.meta, exclude: 'true' } } : e,
      ),
    };
    expect(kinds(goodContent, { profile })).toEqual(['entry_not_in_profile']);
  });

  it('skills section: only skills the policy allows', () => {
    const c = (skills: string[]): ResumeContent => ({
      ...goodContent,
      skills: [{ category_label: 'Tools', skills }],
    });
    expect(kinds(c(['Postgres', 'python3']))).toEqual([]); // aliases are fine
    expect(truth(c(['Kubernetes'])).violations[0]?.detail).toMatch(/want/);
    expect(truth(c(['Docker'])).violations[0]?.detail).toMatch(/learning/);
    expect(truth(c(['Rust'])).violations[0]).toMatchObject({ kind: 'skill_not_allowed', text: 'Rust' });
    expect(kinds(c(['dbt']), { approvedSkills: ['dbt'] })).toEqual([]);
    expect(kinds(c(['Docker']), { approvedSkills: ['Docker'] })).toEqual([]);
  });

  it('bullets may not claim JD skills the profile lacks, or blocked skills, unless the source says so', () => {
    const jd: Jd = {
      ...sampleJd,
      requirements: [{ text: 'dbt and Kafka', kind: 'required', skills: ['dbt', 'Kafka', 'Python'] }],
    };
    expect(kinds(withBullet('Owned the Airflow deployment and dbt models.'), { jd })).toEqual([
      'skill_not_allowed',
    ]);
    expect(kinds(withBullet('Owned the Airflow deployment on Kubernetes.'))).toEqual(['skill_not_allowed']);
    expect(
      kinds(withBullet('Owned the Airflow deployment and dbt models.'), { jd, approvedSkills: ['dbt'] }),
    ).toEqual([]);
    // Docker is "learning", but the Ledger project lists it in its stack
    expect(kinds(withBullet('Shipped the tracker in Docker.', ['proj-ledger']))).toEqual([]);
  });

  it('property: an invented number in any bullet is always caught', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 11, max: 999_999 }),
        fc.constantFrom('%', '', ' users', 'k EUR'),
        (n, unit) => {
          fc.pre(![2022, 2020].includes(n));
          const r = truth(withBullet(`Improved throughput by ${String(n)}${unit} across pipelines.`));
          expect(r.violations.map((v) => v.kind)).toContain('number_not_in_source');
        },
      ),
      { numRuns: 300 },
    );
  });

  it('property: a skill name not in the profile is always caught in the skills section', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[A-Z][a-z]{3,10}$/), (name) => {
        fc.pre(
          !fullProfile.skills.some((s) =>
            [s.skill, ...s.aliases].some((a) => a.toLowerCase() === name.toLowerCase()),
          ),
        );
        const r = truth({ ...goodContent, skills: [{ category_label: 'Tools', skills: [name] }] });
        expect(r.violations).toEqual([expect.objectContaining({ kind: 'skill_not_allowed', text: name })]);
      }),
      { numRuns: 200 },
    );
  });
});

const tex = (c: ResumeContent = goodContent, rules = seedRules) =>
  renderResume(c, fullProfile, seedTemplate, rules, seedPolicy);
const rulesOf = (c: ResumeContent) =>
  lintResume(tex(c), seedRules).issues.map((i) => `${i.severity}:${i.rule}`);
/** Globex with the tested bullet plus a clean one, so the bullet count rule stays quiet. */
const lintBullet = (text: string): ResumeContent => ({
  ...goodContent,
  experience: [
    {
      entry_id: 'exp-globex',
      bullets: [{ text, source_ids: [] }, airflowBullet],
    },
  ],
});

describe('lintResume', () => {
  it('passes the sample with no errors', () => {
    expect(lintResume(tex(), seedRules).ok).toBe(true);
  });

  it('banned words and first person are errors', () => {
    expect(
      rulesOf(lintBullet('Leveraged Airflow to own the deployment for six teams in the company.')),
    ).toContain('error:banned_words');
    expect(rulesOf(lintBullet('Owned my Airflow deployment for six teams in the whole company.'))).toContain(
      'error:first_person',
    );
    expect(rulesOf(lintBullet('Owned the Airflow deployment for six teams in the US and the EU.'))).toEqual(
      [],
    );
  });

  it('bullet length, verb-first and bullet counts', () => {
    expect(rulesOf(lintBullet('Owned Airflow.'))).toEqual(['warning:bullet_length']);
    expect(rulesOf(lintBullet(`Owned ${'the Airflow deployment '.repeat(10)}`))).toEqual([
      'error:bullet_length',
    ]);
    expect(rulesOf(lintBullet('The Airflow deployment for six teams was owned end to end by me.'))).toEqual(
      expect.arrayContaining(['warning:verb_first', 'error:first_person']),
    );
    const many = Array.from({ length: 7 }, () => ({
      text: 'Owned the Airflow deployment for six teams across the whole company.',
      source_ids: [],
    }));
    expect(rulesOf({ ...goodContent, experience: [{ entry_id: 'exp-globex', bullets: many }] })).toContain(
      'error:bullets_per_entry',
    );
  });

  it('summary length, skills limits and required sections', () => {
    expect(rulesOf({ ...goodContent, summary: 'Data engineer. '.repeat(30) })).toContain(
      'error:summary_words',
    );
    const skills = Array.from({ length: 5 }, (_, i) => ({
      category_label: `C${String(i)}`,
      skills: ['Python'],
    }));
    expect(rulesOf({ ...goodContent, skills })).toContain('error:skills_lines');
    expect(
      rulesOf({
        ...goodContent,
        skills: [{ category_label: 'All', skills: Array(25).fill('SQL') as string[] }],
      }),
    ).toContain('error:skills_count');
    expect(rulesOf({ ...goodContent, experience: [] })).toContain('error:sections_required');
  });

  it('works on hand-edited tex: wrong order and odd headings', () => {
    const t = tex().replace('\\section{Education}', '\\section{Schooling}');
    const issues = lintResume(t, seedRules).issues.map((i) => i.rule);
    expect(issues).toEqual(expect.arrayContaining(['section_heading', 'sections_required']));
  });
});

describe('checkAts', () => {
  const jd: Jd = {
    ...sampleJd,
    requirements: [
      { text: 'Python and Postgres', kind: 'required', skills: ['Python', 'Postgres'] },
      { text: 'Nice: dbt, Docker', kind: 'preferred', skills: ['dbt', 'Docker', 'python'] },
    ],
  };
  it('scores alias-aware coverage, required ×2, and marks what you have', () => {
    const r = checkAts({ tex: tex(), jd, profile: fullProfile, rules: seedRules });
    expect(r.required).toEqual([
      { term: 'Python', found: true, youHave: true },
      { term: 'Postgres', found: true, youHave: true },
    ]);
    expect(r.preferred).toEqual([
      { term: 'dbt', found: false, youHave: false },
      { term: 'Docker', found: true, youHave: false },
    ]);
    expect(r.score).toBe(Math.round((100 * 5) / 6));
  });

  it('uses the PDF text when given and adds the PDF checks', () => {
    const r = checkAts({
      tex: tex(),
      jd,
      profile: fullProfile,
      rules: seedRules,
      pdfText: 'nothing relevant',
      pdfBytes: 2 * 1024 * 1024,
    });
    expect(r.score).toBe(0);
    expect(r.format.find((f) => f.check === 'file_size')?.ok).toBe(false);
    expect(r.format.find((f) => f.check === 'selectable_text')?.ok).toBe(true);
  });

  it('format checks flag tables, images, columns and inconsistent dates', () => {
    const t = tex()
      .replace(
        '\\section{Skills}',
        '\\section{Skills}\\begin{tabular}{l}x\\end{tabular}\\includegraphics{x}\\begin{multicols}{2}',
      )
      .replace('Mar 2022 -- Present', '03/2022 -- Present');
    const bad = checkAts({ tex: t, jd: null, profile: fullProfile, rules: seedRules })
      .format.filter((f) => !f.ok)
      .map((f) => f.check);
    expect(bad).toEqual(['single_column', 'no_images', 'no_layout_tables', 'date_format']);
  });
});

describe('lintContent', () => {
  const lintOf = (c: ResumeContent) =>
    lintContent(renderResume(c, fullProfile, seedTemplate, seedRules, seedPolicy), seedRules, c, fullProfile);

  it('maps rendered paths back to content order and names the entry', () => {
    // content lists Initrode first; the renderer prints Globex (more recent) first and drops the empty bullet
    const long = `Owned the Airflow deployment for six teams ${'and kept it running well '.repeat(10)}`;
    const c: ResumeContent = {
      ...goodContent,
      experience: [
        goodContent.experience[0] ?? { entry_id: 'exp-initrode', bullets: [] },
        {
          entry_id: 'exp-globex',
          bullets: [
            { text: '', source_ids: [] },
            { text: long, source_ids: [] },
          ],
        },
      ],
    };
    expect(lintOf(c).issues.filter((i) => i.severity === 'error')).toEqual([
      expect.objectContaining({
        rule: 'bullet_length',
        path: 'experience[1].bullets[1]',
        message: expect.stringMatching(/^exp-globex \("Data Engineer — Globex"\): Bullet is/) as string,
      }),
    ]);
  });

  it('warns about an entry selected twice or both selected and omitted', () => {
    const c: ResumeContent = {
      ...goodContent,
      experience: [...goodContent.experience, { entry_id: 'exp-globex', bullets: [airflowBullet] }],
      omitted: [{ id: 'proj-ledger', reason: 'not relevant' }],
    };
    expect(lintOf(c).issues.filter((i) => i.severity === 'warning')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rule: 'duplicate_entry', path: 'experience[2]' }),
        expect.objectContaining({ rule: 'omitted_but_used', path: 'omitted[0]' }),
      ]),
    );
  });
});
