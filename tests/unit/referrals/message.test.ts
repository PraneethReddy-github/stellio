import { describe, expect, it } from 'vitest';
import {
  checkMessage,
  checkMessageTruth,
  detectLanguage,
  lintMessage,
  sharedGroundFrom,
  type MessageContext,
  type MessageOutput,
} from '../../../src/shared/referrals';
import { lintRules } from '../../../src/shared/rules';
import { readFileSync } from 'node:fs';
import { fullProfile, seedPolicy } from '../../fixtures/resume';
import { JOB_URL, goodMessage, jane, referralRules } from '../../fixtures/referrals';

const facts = jane().facts.map((f) => f.text);
const ctx: MessageContext = {
  roleTitle: 'Data Engineer',
  company: 'Nimbus Analytics GmbH',
  jobRefs: [JOB_URL, 'JOB123'],
  personFacts: ['Senior Data Engineer', 'Berlin, Germany', ...facts],
  ground: sharedGroundFrom(fullProfile),
  expectedLanguage: 'en',
};
const good = goodMessage(JOB_URL);
const rulesOf = (over: string): typeof referralRules => {
  const md = readFileSync('seed/rules/referral-message.md', 'utf8');
  return lintRules('referral-message', md.replace('first_person: true', over)).config as typeof referralRules;
};
const lint = (m: Partial<MessageOutput> = {}, c: Partial<MessageContext> = {}, rules = referralRules) =>
  lintMessage({ ...good, ...m }, rules, { ...ctx, ...c });
const rulesHit = (m: Partial<MessageOutput> = {}, c: Partial<MessageContext> = {}) =>
  lint(m, c).map((i) => i.rule);

describe('referral-message rules file', () => {
  it('parses the seed with the documented limits', () => {
    expect(referralRules).toMatchObject({
      version: 1,
      connection_note: { max_chars: 300 },
      message: { words: { min: 60, max: 140 }, subject_max_chars: 70 },
      match_language: true,
      first_person: true,
    });
    expect(referralRules.must_include).toEqual(['role_title', 'job_reference', 'shared_ground', 'small_ask']);
    expect(referralRules.banned_phrases).toContain('pick your brain');
  });
  it('reports a bad limit and an unknown must_include entry', () => {
    const md = readFileSync('seed/rules/referral-message.md', 'utf8')
      .replace('max_chars: 300', 'max_chars: 5')
      .replace('  - small_ask', '  - flattery');
    const r = lintRules('referral-message', md);
    expect(r.config).toBeNull();
    expect(r.diagnostics.map((d) => d.severity)).toEqual(['error', 'error']);
  });
});

describe('lintMessage', () => {
  it('passes the good message', () => {
    expect(lint()).toEqual([]);
  });

  it('connection note over the limit, and empty', () => {
    expect(rulesHit({ connection_note: 'x'.repeat(301) })).toEqual(['connection_note']);
    expect(rulesHit({ connection_note: 'x'.repeat(300) })).toEqual([]);
    expect(rulesHit({ connection_note: ' ' })).toEqual(['connection_note']);
  });

  it('body word range', () => {
    expect(rulesHit({ body: 'Hi Jane, I am applying for the Data Engineer role (JOB123).' })).toContain(
      'message_words',
    );
    expect(rulesHit({ body: `${good.body}\n\n${'word '.repeat(80)}` })).toContain('message_words');
  });

  it('subject length and empty subject', () => {
    expect(rulesHit({ subject: 'S'.repeat(71) })).toEqual(['subject']);
    expect(rulesHit({ subject: '' })).toEqual(['subject']);
  });

  it('banned phrases in note, subject and body, with curly apostrophes', () => {
    expect(
      rulesHit({ body: good.body.replace('Hi Jane,', 'Hi Jane, I hope this message finds you well.') }),
    ).toContain('banned_phrases');
    expect(
      rulesHit({ connection_note: 'Hi Jane, I’m reaching out because of the Data Engineer role.' }),
    ).toContain('banned_phrases');
    expect(rulesHit({ subject: 'Quick question about Data Engineer' })).toContain('banned_phrases');
    expect(rulesHit({ body: good.body.replace('team', 'passionate team') })).toContain('banned_phrases');
  });

  it('attachments are not mentioned in the first message', () => {
    expect(rulesHit({ body: `${good.body} My CV is attached.` })).toContain('attachments');
  });

  it('first person, when required', () => {
    const body = good.body.replace(/\bI\b/g, 'The applicant').replace(/\bmy\b/gi, 'the');
    expect(rulesHit({ body })).toContain('first_person');
    expect(lint({ body }, {}, rulesOf('first_person: false'))).not.toContainEqual(
      expect.objectContaining({ rule: 'first_person' }),
    );
  });

  it('must include: role title, job reference (link or id), shared ground, small ask', () => {
    expect(rulesHit({ body: good.body.replace(/Data Engineer/g, 'data role') })).toContain('role_title');
    expect(rulesHit({ body: good.body.replace(JOB_URL, '') })).toContain('job_reference');
    expect(
      rulesHit({ body: good.body.replace(JOB_URL, 'https://jobs.nimbusanalytics.test/other') }),
    ).toContain('job_reference');
    // the id also counts, and a link without scheme or www
    expect(rulesHit({ body: good.body.replace(JOB_URL, 'job id JOB123') })).toEqual([]);
    expect(
      rulesHit({ body: good.body.replace(JOB_URL, 'jobs.nimbusanalytics.test/data-engineer-42') }),
    ).toEqual([]);
    expect(
      rulesHit({
        body: good.body
          .replace(
            'Would you be open to referring me, or telling me whether my background fits the team?',
            'Thanks for reading this.',
          )
          .replace('I am happy to send my resume, and a no is completely fine.', 'Have a nice week.'),
      }),
    ).toContain('small_ask');
    const noGround = good.body
      .replace(
        'Your talk on columnar storage at the Berlin Data Meetup caught my attention, because my bachelor thesis at Example University was on exactly that topic.',
        'I like data work.',
      )
      .replace('Globex', 'my last employer');
    expect(rulesHit({ body: noGround })).toContain('shared_ground');
  });

  it('shared ground may be a cited fact instead of a profile item', () => {
    const body = good.body.replace(
      'my bachelor thesis at Example University was on exactly that topic',
      'I have been reading about that area for years',
    );
    // "columnar storage at the Berlin Data Meetup" overlaps the cited fact on 3+ content words
    expect(rulesHit({ body })).not.toContain('shared_ground');
  });

  it('rules can switch checks off', () => {
    const md = readFileSync('seed/rules/referral-message.md', 'utf8').replace(
      /must_include:[\s\S]*?\nbanned_phrases:/,
      'must_include: []\nbanned_phrases:',
    );
    const rules = lintRules('referral-message', md).config as typeof referralRules;
    expect(lint({ body: good.body.replace(JOB_URL, '') }, {}, rules)).toEqual([]);
  });

  it('language: German profile pages need a German message when match_language is on', () => {
    const de = 'Ich arbeite gerne mit dem Team und die Entwicklung ist für uns wichtig.';
    expect(detectLanguage(de)).toBe('de');
    expect(detectLanguage('We are looking for a team that has the right skills for you.')).toBe('en');
    expect(detectLanguage('Hi')).toBeNull();
    expect(rulesHit({}, { expectedLanguage: 'de' })).toContain('language');
    expect(rulesHit({ language: 'de' }, { expectedLanguage: 'de' })).toContain('language'); // the text decides, not the label
    expect(rulesHit({}, { expectedLanguage: null })).toEqual([]);
  });
});

describe('checkMessageTruth', () => {
  const input = {
    policy: seedPolicy,
    jobTitle: 'Data Engineer',
    jobCompany: 'Nimbus Analytics GmbH',
    jobLocation: 'Berlin, Germany',
    person: { name: 'Jane Doe', title: 'Senior Data Engineer', location: 'Berlin, Germany', facts },
  };
  const truth = (m: Partial<MessageOutput>) => checkMessageTruth({ ...good, ...m }, fullProfile, input);

  it('passes claims backed by the profile and the cited facts', () => {
    expect(truth({})).toEqual([]);
  });

  it('flags a number about the user that the profile does not have', () => {
    const t = truth({ body: good.body.replace('2 h to 10 min', '2 h to 2 min') });
    expect(t.map((v) => v.kind)).toContain('number_not_in_source');
    expect(t[0]?.detail).toMatch(/body\[2\]/);
  });

  it('flags a skill the profile does not allow', () => {
    const t = truth({ connection_note: `${good.connection_note} I also write Rust and Kubernetes.` });
    expect(t.map((v) => v.kind)).toContain('skill_not_allowed');
  });

  it('flags an employer or school the profile does not mention', () => {
    const t = truth({ body: good.body.replace('At Globex', 'At Hooli') });
    expect(t.map((v) => v.kind)).toContain('unknown_organisation');
  });

  it('flags claims about the person that no cited fact backs (organisation, number)', () => {
    const org = truth({
      body: good.body.replace('Your talk on columnar storage', 'Your keynote at Stripe Sessions'),
    });
    expect(org.map((v) => v.kind)).toContain('unknown_organisation');
    const num = truth({ body: good.body.replace('Your talk', 'Your 300-person talk') });
    expect(num.map((v) => v.kind)).toContain('number_not_in_source');
  });

  it('accepts a number or skill that is in the person facts', () => {
    const f = [...facts, 'Maintains a Rust library used by 300 teams'];
    const t = checkMessageTruth(
      {
        ...good,
        connection_note: `${good.connection_note} Your Rust library used by 300 teams looks great.`,
      },
      fullProfile,
      { ...input, person: { ...input.person, facts: f } },
    );
    expect(t).toEqual([]);
  });
});

describe('checkMessage', () => {
  it('is ok for the good message and collects lint and truth issues otherwise', () => {
    const t = {
      policy: seedPolicy,
      jobTitle: 'Data Engineer',
      jobCompany: 'Nimbus Analytics GmbH',
      jobLocation: 'Berlin, Germany',
      person: { name: 'Jane Doe', title: 'Senior Data Engineer', location: 'Berlin, Germany', facts },
    };
    expect(checkMessage(good, referralRules, fullProfile, ctx, t)).toMatchObject({
      ok: true,
      lint: [],
      truth: [],
    });
    const bad = checkMessage(
      { ...good, subject: 'S'.repeat(80), body: good.body.replace('At Globex', 'At Hooli') },
      referralRules,
      fullProfile,
      ctx,
      t,
    );
    expect(bad.ok).toBe(false);
    expect(bad.lint).toHaveLength(1);
    expect(bad.truth.length).toBeGreaterThan(0);
  });
});
