import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CoverContent, CoverJob } from '../../src/shared/documents';
import { lintRules, type CoverLetterRules } from '../../src/shared/rules';

const read = (p: string): string => readFileSync(resolve(p), 'utf8');

export const coverTemplate = read('seed/templates/cover-letter.tex');
export const coverRules = lintRules('cover-letter', read('seed/rules/cover-letter.md'))
  .config as CoverLetterRules;
/** The template format 1 seed and rules (v1.0.4 and earlier). */
export const coverTemplateV1 = read('tests/fixtures/latex/cover-letter-v1.tex');
export const coverRulesV1 = lintRules('cover-letter', read('tests/fixtures/latex/rules-cover-letter-v1.md'))
  .config as CoverLetterRules;

/** The job the fake CLI's `sampleJd` describes. */
export const coverJob: CoverJob = {
  company: 'Nimbus Analytics GmbH',
  title: 'Data Engineer',
  location: 'Berlin, Germany',
};
/** The posting text the integration tests intake (and the company facts the truth check may use). */
export const coverPosting =
  'Data Engineer (m/w/d) at Nimbus Analytics GmbH in Berlin. Build pipelines in Python and SQL.';

/** Truthful letter for the full fixture profile: passes truth and lint (230-350 words, 4 paragraphs). */
export const goodCover: CoverContent = {
  salutation: null,
  paragraphs: [
    {
      text: 'I am applying for the Data Engineer role at Nimbus Analytics, where batch pipelines in Python and SQL sit at the centre of the work. The posting describes pipelines that analysts and retailers depend on every day, and that is the kind of reliability work I have spent the last five years doing, so the role reads like a direct continuation of my path rather than a change of direction.',
      source_ids: [],
    },
    {
      text: 'At Globex I cut nightly report runtime from 2 h to 10 min by rewriting SQL pipelines in PostgreSQL, which gave analysts their numbers before the working day began. I also own the Airflow deployment that six teams rely on, so I know what it takes to keep schedules dependable when many people expect fresh data every morning. Both pieces of work are close to what the posting asks of this role, and I would bring the same habits to your team.',
      source_ids: ['exp-globex'],
    },
    {
      text: 'Before Globex I worked at Initrode, where I built weekly dashboards for the finance team. That work taught me to start from what the reader of a report needs, and I still design tables and schedules with that reader in mind. Outside of work I built a personal finance tracker in Python that imports bank CSV files, which taught me to handle messy input without losing a single row.',
      source_ids: ['exp-initrode', 'proj-ledger'],
    },
    {
      text: 'I live in Berlin, so the hybrid arrangement is no obstacle. I would welcome a conversation about how I can help Nimbus Analytics keep its forecasting pipelines dependable, and I am glad to share more detail on any of the work above. Thank you for your time and consideration.',
      source_ids: [],
    },
  ],
  closing: null,
};

/** `goodCover` with an invented number and a foreign company: two truth violations. */
export const badCover: CoverContent = {
  ...goodCover,
  paragraphs: goodCover.paragraphs.map((p, i) =>
    i === 1 ? { ...p, text: p.text.replace('six teams', '40 teams').replace('At Globex', 'At Quokka') } : p,
  ),
};
