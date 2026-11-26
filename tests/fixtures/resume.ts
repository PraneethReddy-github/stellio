import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import { resolve } from 'node:path';
import type { ResumeContent } from '../../src/shared/documents';
import { parseProfile } from '../../src/shared/profile';
import { lintRules, type ResumeRules, type SkillsPolicy } from '../../src/shared/rules';

const read = (p: string): string => readFileSync(resolve(p), 'utf8');

/** The fictional full profile, seed rules, policy and template. */
export const fullProfile = parseProfile(read('tests/fixtures/profiles/full.md')).model;
export const seedTemplate = read('seed/templates/resume.tex');
export const seedRules = lintRules('resume', read('seed/rules/resume.md')).config as ResumeRules;
export const seedPolicy = lintRules('skills-policy', read('seed/rules/skills-policy.md'))
  .config as SkillsPolicy;

export const airflowBullet = {
  text: 'Owned the Airflow deployment for 6 teams, keeping nightly pipelines running on schedule.',
  source_ids: [],
};

/** Truthful content for the full profile: passes truth and lint. */
export const goodContent: ResumeContent = {
  summary: 'Data engineer with five years of experience building batch pipelines in Python, SQL and Airflow.',
  experience: [
    {
      entry_id: 'exp-initrode',
      bullets: [
        {
          text: 'Built weekly dashboards for the finance team, turning raw ledger data into SQL reports.',
          source_ids: [],
        },
      ],
    },
    {
      entry_id: 'exp-globex',
      bullets: [
        {
          text: 'Cut nightly report runtime from 2 h to 10 min by rewriting the SQL pipelines in PostgreSQL.',
          source_ids: ['exp-globex'],
        },
        airflowBullet,
      ],
    },
  ],
  projects: [
    {
      entry_id: 'proj-ledger',
      bullets: [
        {
          text: 'Built a personal finance tracker in Python and Docker that imports bank CSV files.',
          source_ids: [],
        },
      ],
    },
  ],
  education: [{ entry_id: 'edu-eu', bullets: [] }],
  certifications: [{ entry_id: 'cert-cp' }],
  skills: [
    { category_label: 'Languages', skills: ['Python', 'SQL'] },
    { category_label: 'Data', skills: ['PostgreSQL', 'Airflow'] },
  ],
  publications: [],
  patents: [],
  awards: [],
  omitted: [],
  change_log: ['Led with pipeline work'],
};

/** `goodContent` with the template format 2 sections filled. */
export const fullContent: ResumeContent = {
  ...goodContent,
  publications: [{ entry_id: 'pub-col', bullets: [] }],
  patents: [{ entry_id: 'patent-join', bullets: [] }],
  awards: [{ entry_id: 'award-hack' }],
};

/** The template format 1 seed and rules (v1.0.4 and earlier), kept to prove older templates still work. */
export const v1Template = read('tests/fixtures/latex/resume-v1.tex');
export const v1Rules = lintRules('resume', read('tests/fixtures/latex/rules-resume-v1.md'))
  .config as ResumeRules;

/** `goodContent` with an invented number: the truth check flags the 73 (no source says so). */
export const badContent: ResumeContent = {
  ...goodContent,
  experience: goodContent.experience.map((e) =>
    e.entry_id === 'exp-globex'
      ? {
          ...e,
          bullets: [
            { text: 'Cut cloud costs by 73% across 14 pipelines.', source_ids: ['exp-globex'] },
            airflowBullet,
          ],
        }
      : e,
  ),
};

// Arbitrary content from the model, any unicode, any ids: render must stay valid and pass the pre-check.
const ids = [
  ...fullProfile.experience,
  ...fullProfile.projects,
  ...fullProfile.education,
  ...fullProfile.publications,
  ...fullProfile.patents,
  ...fullProfile.awards,
].map((e) => e.id);
const anyText = fc.oneof(
  fc.string({ unit: 'binary', maxLength: 120 }),
  fc.constantFrom('input', 'write', '\\input{x}', '^^5c', '%', '#', '}{', '\\', '{read}', '\\csname'),
  fc.string({ maxLength: 60 }),
);
const id = fc.oneof(fc.constantFrom(...ids), fc.string({ maxLength: 10 }));
const bullet = fc.record({ text: anyText, source_ids: fc.array(id, { maxLength: 2 }) });
const entry = fc.record({ entry_id: id, bullets: fc.array(bullet, { maxLength: 4 }) });
export const arbContent: fc.Arbitrary<ResumeContent> = fc.record({
  summary: fc.option(anyText),
  experience: fc.array(entry, { maxLength: 4 }),
  projects: fc.array(entry, { maxLength: 3 }),
  education: fc.array(entry, { maxLength: 2 }),
  certifications: fc.array(fc.record({ entry_id: id }), { maxLength: 2 }),
  publications: fc.array(entry, { maxLength: 2 }),
  patents: fc.array(entry, { maxLength: 2 }),
  awards: fc.array(fc.record({ entry_id: id }), { maxLength: 2 }),
  skills: fc.array(fc.record({ category_label: anyText, skills: fc.array(anyText, { maxLength: 6 }) }), {
    maxLength: 4,
  }),
  omitted: fc.constant([]),
  change_log: fc.constant([]),
});
