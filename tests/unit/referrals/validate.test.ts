import { describe, expect, it } from 'vitest';
import {
  classifyProfileUrl,
  stripPhones,
  validateCandidates,
  type RawCandidate,
} from '../../../src/shared/referrals';
import { COMPANY, GITHUB, LINKEDIN, MEETUP_PAGE, TEAM_PAGE, jane, john } from '../../fixtures/referrals';

const now = new Date('2026-11-21T10:00:00Z');
const run = (raw: RawCandidate[], extra: { companyDomains?: string[]; max?: number } = {}) =>
  validateCandidates(raw, { company: COMPANY, now, ...extra });
const reasons = (raw: RawCandidate[]) => run(raw).dropped.map((d) => d.reason);

describe('exclude ("search more")', () => {
  it('drops people already found, by name or by profile URL', () => {
    const exclude = (names: string[], profileUrls: string[]) =>
      validateCandidates([jane(), john()], { company: COMPANY, now, exclude: { names, profileUrls } });
    expect(exclude(['jane doe'], []).people.map((p) => p.fullName)).toEqual(['John Roe']);
    const byUrl = exclude([], [LINKEDIN]);
    expect(byUrl.people.map((p) => p.fullName)).toEqual(['John Roe']);
    expect(byUrl.dropped).toEqual([{ reason: 'duplicate', count: 1 }]);
    expect(exclude([], []).people).toHaveLength(2);
  });
});

describe('classifyProfileUrl (host allow-list and denylist)', () => {
  const kind = (u: string, domains: string[] = []) => classifyProfileUrl(u, COMPANY, domains)?.kind ?? null;
  it('accepts linkedin /in/, a github user, the company domain and personal sites', () => {
    expect(kind(LINKEDIN)).toBe('linkedin');
    expect(kind('https://de.linkedin.com/in/jane-doe-0a1b2c/?trk=x#y')).toBe('linkedin');
    expect(classifyProfileUrl('https://de.linkedin.com/in/jane-doe-0a1b2c/?trk=x', COMPANY)?.url).toBe(
      'https://www.linkedin.com/in/jane-doe-0a1b2c',
    );
    expect(kind(GITHUB)).toBe('github');
    expect(kind('https://gitlab.com/jane')).toBe('other');
    expect(kind('https://www.nimbusanalytics.test/people/jane')).toBe('company');
    expect(kind('https://team.corp-site.test/jane', ['corp-site.test'])).toBe('company');
    expect(kind('https://jane-doe.test/about')).toBe('personal');
  });

  it('rejects linkedin pages that are not public profiles and github orgs/paths', () => {
    expect(kind('https://www.linkedin.com/company/nimbus')).toBeNull();
    expect(kind('https://www.linkedin.com/pub/jane/1/2/3')).toBeNull();
    expect(kind('https://www.linkedin.com/search/results/people/?keywords=jane')).toBeNull();
    expect(kind('https://github.com/orgs/nimbus/people')).toBeNull();
    expect(kind('https://github.com/jane/repo')).toBeNull();
    expect(kind('https://github.com/login')).toBeNull();
  });

  it.each([
    'https://www.rocketreach.co/jane-doe-email_1',
    'https://app.apollo.io/#/people/1',
    'https://hunter.io/find',
    'https://www.zoominfo.com/p/Jane-Doe/1',
    'https://www.spokeo.com/Jane-Doe',
    'https://theorg.com/org/nimbus/teams',
    'https://www.facebook.com/jane.doe',
    'https://xing.com/profile/Jane_Doe',
    'https://www.google.com/search?q=jane',
    'https://web.archive.org/web/2020/https://www.linkedin.com/in/jane',
  ])('rejects data-broker, people-search and private-social host %s', (u) => {
    expect(kind(u)).toBeNull();
  });

  it('rejects non-web, credentialed, IP and single-label URLs', () => {
    for (const u of [
      'ftp://jane.test/x',
      'javascript:alert(1)',
      'https://user:pw@jane.test/',
      'http://127.0.0.1/jane',
      'https://localhost/jane',
      'not a url',
    ])
      expect(kind(u), u).toBeNull();
  });
});

describe('validateCandidates', () => {
  it('keeps a fully sourced candidate and groups facts per source with the date seen', () => {
    const r = run([jane()]);
    expect(r.returned).toBe(1);
    expect(r.dropped).toEqual([]);
    const p = r.people[0];
    expect(p).toMatchObject({
      fullName: 'Jane Doe',
      title: 'Senior Data Engineer',
      country: 'Germany',
      profileUrls: [
        { url: LINKEDIN, kind: 'linkedin' },
        { url: GITHUB, kind: 'github' },
      ],
    });
    expect(p?.sources.map((s) => s.url)).toEqual([TEAM_PAGE, LINKEDIN, MEETUP_PAGE]);
    expect(p?.sources.every((s) => s.seen_at === now.toISOString() && s.facts.length > 0)).toBe(true);
  });

  it('drops a contact without a source_url, or whose source is not one of the candidate sources', () => {
    const r = run([
      jane({
        public_contact: [
          { kind: 'email', value: 'jane@janedoe.test', source_url: '' },
          { kind: 'email', value: 'jane@janedoe.test', source_url: 'https://elsewhere.test/page' },
        ],
        facts: [...jane().facts, { text: 'Email: jane@janedoe.test', source_url: TEAM_PAGE }],
      }),
    ]);
    expect(r.people[0]?.publicContact).toEqual([]);
  });

  it('keeps a published email only when its text is in a fact from the same cited page', () => {
    const withFact = run([
      jane({
        public_contact: [{ kind: 'email', value: 'jane@janedoe.test', source_url: TEAM_PAGE }],
        facts: [...jane().facts, { text: 'Contact: jane@janedoe.test', source_url: TEAM_PAGE }],
      }),
    ]);
    expect(withFact.people[0]?.publicContact).toEqual([
      { kind: 'email', value: 'jane@janedoe.test', source_url: TEAM_PAGE },
    ]);
  });

  it('drops a guessed-looking email that no cited fact shows', () => {
    const r = run([
      jane({
        public_contact: [{ kind: 'email', value: 'jane.doe@nimbusanalytics.test', source_url: TEAM_PAGE }],
      }),
    ]);
    expect(r.people).toHaveLength(1);
    expect(r.people[0]?.publicContact).toEqual([]);
    // shown on another page than the one cited is not enough either
    const other = run([
      jane({
        public_contact: [{ kind: 'email', value: 'jane@janedoe.test', source_url: TEAM_PAGE }],
        facts: [...jane().facts, { text: 'jane@janedoe.test', source_url: MEETUP_PAGE }],
      }),
    ]);
    expect(other.people[0]?.publicContact).toEqual([]);
  });

  it('never stores phone numbers: contact values and fact text are stripped', () => {
    const r = run([
      jane({
        public_contact: [
          { kind: 'phone', value: '+49 6227 7 12345', source_url: TEAM_PAGE },
          { kind: 'other', value: 'tel:+4962277123456', source_url: TEAM_PAGE },
          { kind: 'other', value: '0171 1234567', source_url: TEAM_PAGE },
        ],
        facts: [
          { text: 'Senior Data Engineer at Nimbus Analytics. Phone: +49 6227 712345', source_url: TEAM_PAGE },
          { text: 'Reachable at (030) 123 456 78 in Berlin', source_url: TEAM_PAGE },
        ],
      }),
    ]);
    const p = r.people[0];
    expect(p?.publicContact).toEqual([]);
    const text = JSON.stringify(p?.sources);
    expect(text).not.toMatch(/\d{5,}/);
    expect(text).toContain('Senior Data Engineer at Nimbus Analytics');
  });

  it('keeps a published contact form on a cited host, drops one on a broker or unrelated host', () => {
    const r = run([
      jane({
        public_contact: [
          { kind: 'contact_form', value: 'https://janedoe.test/contact', source_url: MEETUP_PAGE },
          { kind: 'contact_form', value: 'https://www.rocketreach.co/jane', source_url: TEAM_PAGE },
          { kind: 'contact_form', value: 'https://unrelated.test/contact', source_url: TEAM_PAGE },
        ],
        profile_urls: [LINKEDIN, 'https://janedoe.test/'],
        facts: [
          ...jane().facts,
          { text: 'Personal site and contact form', source_url: 'https://janedoe.test/' },
        ],
      }),
    ]);
    expect(r.people[0]?.publicContact).toEqual([
      { kind: 'contact_form', value: 'https://janedoe.test/contact', source_url: MEETUP_PAGE },
    ]);
  });

  it('drops a candidate whose only profile URL is a broker or whose personal site was never read', () => {
    expect(reasons([jane({ profile_urls: ['https://www.rocketreach.co/jane-doe'] })])).toEqual([
      'no_profile_url',
    ]);
    expect(reasons([jane({ profile_urls: ['https://invented-site.test/jane'] })])).toEqual([
      'no_profile_url',
    ]);
    expect(
      run([jane({ profile_urls: [LINKEDIN, 'https://www.rocketreach.co/jane'] })]).people[0]?.profileUrls,
    ).toEqual([{ url: LINKEDIN, kind: 'linkedin' }]);
  });

  it('drops facts from broker pages and candidates left with no sourced fact', () => {
    expect(
      reasons([
        jane({
          facts: [{ text: 'Works at Nimbus Analytics', source_url: 'https://www.zoominfo.com/p/jane' }],
        }),
      ]),
    ).toEqual(['no_sourced_fact']);
    expect(reasons([jane({ facts: [{ text: 'Works at Nimbus Analytics', source_url: '' }] })])).toEqual([
      'no_sourced_fact',
    ]);
  });

  it('requires the company in a fact, and the candidate to work at that company', () => {
    expect(
      reasons([jane({ facts: [{ text: 'Senior Data Engineer in Berlin', source_url: TEAM_PAGE }] })]),
    ).toEqual(['company_not_in_facts']);
    expect(reasons([jane({ company: 'Initech' })])).toEqual(['wrong_company']);
    expect(reasons([jane({ company: '' })])).toEqual(['wrong_company']);
    // legal suffixes and extra words are fine: "SAP SE" = "SAP", "SAP Labs" belongs to SAP
    const sap = validateCandidates(
      [
        jane({
          company: 'SAP Labs',
          facts: [{ text: 'Engineer at SAP SE in Walldorf', source_url: TEAM_PAGE }],
        }),
      ],
      { company: 'SAP SE', now },
    );
    expect(sap.people).toHaveLength(1);
  });

  it('drops candidates without a usable name', () => {
    const r = run([jane({ full_name: '' }), jane({ full_name: 'JD' }), jane({ full_name: 'a@b.test' })]);
    expect(r.dropped).toEqual([{ reason: 'no_name', count: 3 }]);
  });

  it('dedupes by normalised name + company and by profile URL', () => {
    const r = run([
      jane(),
      jane({ full_name: 'JANE  DOE', profile_urls: ['https://github.com/other'] }),
      jane({ full_name: 'Dr. Jane Doe', profile_urls: ['https://github.com/third'] }),
      john({ profile_urls: ['https://de.linkedin.com/in/jane-doe-0a1b2c?x=1'] }),
      john(),
    ]);
    expect(r.people.map((p) => p.fullName)).toEqual(['Jane Doe', 'John Roe']);
    expect(r.dropped).toEqual([{ reason: 'duplicate', count: 3 }]);
  });

  it('caps at 25 people', () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      john({
        full_name: `Person Number${String.fromCharCode(97 + (i % 26))}${String(i)}`,
        profile_urls: [`https://github.com/user-${String(i)}`],
      }),
    );
    const r = run(many);
    expect(r.people).toHaveLength(25);
    expect(r.dropped).toEqual([{ reason: 'over_limit', count: 15 }]);
    expect(run(many, { max: 99 }).people).toHaveLength(25);
    expect(run(many, { max: 3 }).people).toHaveLength(3);
  });

  it('classifies the company domain as company, using known domains', () => {
    const r = run(
      [
        jane({
          profile_urls: ['https://people.nimbus-corp.test/jane'],
          facts: [
            { text: 'Engineer at Nimbus Analytics', source_url: 'https://people.nimbus-corp.test/jane' },
          ],
        }),
      ],
      {
        companyDomains: ['nimbus-corp.test'],
      },
    );
    expect(r.people[0]?.profileUrls[0]?.kind).toBe('company');
  });
});

describe('stripPhones', () => {
  it.each([
    ['Call +49 30 1234567 now', 'Call now'],
    ['Phone: 0171 1234567', ''],
    ['Tel +44 (0)20 7946 0958', ''],
    ['(030) 123 456 78', ''],
    ['030-123-4567', ''],
  ])('removes %j', (input, out) => {
    expect(stripPhones(input)).toBe(out);
  });
  it('keeps years, ranges and ordinary numbers', () => {
    for (const t of [
      'Joined in 2019-2024',
      'Team of 12 engineers in 2026',
      'Version 3.14.159 shipped',
      'a@b.test',
    ])
      expect(stripPhones(t)).toBe(t);
  });
});
