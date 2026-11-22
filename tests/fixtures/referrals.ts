import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { MessageOutput, RawCandidate } from '../../src/shared/referrals';
import { lintRules, type ReferralMessageRules } from '../../src/shared/rules';

export const referralRules = lintRules(
  'referral-message',
  readFileSync(resolve('seed/rules/referral-message.md'), 'utf8'),
).config as ReferralMessageRules;

/** Fictional company and people: nothing here is a real person (docs/12 §3). */
export const COMPANY = 'Nimbus Analytics GmbH';
export const JOB_URL = 'https://jobs.nimbusanalytics.test/data-engineer-42';

export const TEAM_PAGE = 'https://www.nimbusanalytics.test/team';
export const MEETUP_PAGE = 'https://meetup-berlin.test/events/columnar-storage';
export const GITHUB = 'https://github.com/jane-doe';
export const LINKEDIN = 'https://www.linkedin.com/in/jane-doe-0a1b2c';

/** A candidate that passes every check; tests override single fields. */
export const jane = (over: Partial<RawCandidate> = {}): RawCandidate => ({
  full_name: 'Jane Doe',
  title: 'Senior Data Engineer',
  company: 'Nimbus Analytics',
  location: 'Berlin, Germany',
  profile_urls: [LINKEDIN, GITHUB],
  public_contact: [],
  facts: [
    { text: 'Senior Data Engineer at Nimbus Analytics in Berlin', source_url: TEAM_PAGE },
    { text: 'Studied computer science at Example University', source_url: LINKEDIN },
    { text: 'Spoke at the Berlin Data Meetup about columnar storage in 2026', source_url: MEETUP_PAGE },
  ],
  why: 'Senior data engineer on the same kind of pipelines, and an Example University alumna.',
  ...over,
});

export const john = (over: Partial<RawCandidate> = {}): RawCandidate =>
  jane({
    full_name: 'John Roe',
    title: 'Data Engineer',
    profile_urls: ['https://www.linkedin.com/in/john-roe-77'],
    facts: [{ text: 'Data Engineer at Nimbus Analytics', source_url: TEAM_PAGE }],
    why: 'Peer data engineer.',
    ...over,
  });

/** Passes lint and truth for the full fixture profile and Jane's facts (60-140 words in the body). */
export const goodMessage = (jobRef: string): MessageOutput => ({
  connection_note:
    "Hi Jane, I'm a data engineer in Berlin applying for the Data Engineer role at Nimbus Analytics, and I studied at Example University too. May I message you about the team?",
  subject: 'Data Engineer role at Nimbus Analytics',
  body: `Hi Jane,

I am applying for the Data Engineer position at Nimbus Analytics (${jobRef}). Your talk on columnar storage at the Berlin Data Meetup caught my attention, because my bachelor thesis at Example University was on exactly that topic.

At Globex I cut nightly report runtime from 2 h to 10 min by rewriting SQL pipelines, and I own the Airflow deployment for six teams. Both seem close to the work of your team.

Would you be open to referring me, or telling me whether my background fits the team? I am happy to send my resume, and a no is completely fine.

Thank you for reading,
Alex`,
  language: 'en',
});
