import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { precheckTex } from '../../../src/main/services/latex/precheck';
import {
  checkCoverTruth,
  keptParagraphs,
  lintCover,
  readCover,
  renderCover,
  type CoverContent,
} from '../../../src/shared/documents';
import { cityOf } from '../../../src/shared/documents/cover';
import { parseTemplate } from '../../../src/shared/latex/template';
import type { CoverLetterRules } from '../../../src/shared/rules';
import { sampleJd } from '../../fixtures/jobs';
import {
  badCover,
  coverJob,
  coverPosting,
  coverRules,
  coverRulesV1,
  coverTemplate,
  coverTemplateV1,
  goodCover,
} from '../../fixtures/cover';
import { fullProfile, seedPolicy } from '../../fixtures/resume';

const today = new Date('2026-11-20T12:00:00');
const render = (c: CoverContent = goodCover, rules: CoverLetterRules = coverRules): string =>
  renderCover(c, fullProfile, coverJob, coverTemplate, rules, today);
const para = (text: string, n = 1): CoverContent => ({
  ...goodCover,
  paragraphs: [{ text, source_ids: [] }, ...goodCover.paragraphs.slice(n)],
});

describe('renderCover (template format 1)', () => {
  it('fills header, recipient, date, salutation fallback and closing; the template stays valid', () => {
    const tex = renderCover(goodCover, fullProfile, coverJob, coverTemplateV1, coverRulesV1, today);
    expect(tex).toContain(
      '\\letterHeader{Alex Example}{Berlin, Germany}{alex@example.test}{+49 000 0000000}{https://linkedin.example.test/in/alex}',
    );
    expect(tex).toContain(
      '\\letterRecipient{20 November 2026}{Nimbus Analytics GmbH}{Hiring Team, Data Engineer}{Berlin, Germany}',
    );
    expect(tex).toContain('Dear Hiring Team,\n\nI am applying for the Data Engineer role');
    expect(tex).toContain('Kind regards,\\\\[14pt]\nAlex Example');
    expect(parseTemplate(tex, 'cover-letter').diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(precheckTex(tex)).toEqual([]);
  });

  it('uses the model salutation and closing when given, and ~ for a missing location', () => {
    const tex = renderCover(
      { ...goodCover, salutation: 'Dear Ms Weber,', closing: 'Best regards,' },
      fullProfile,
      { ...coverJob, location: '' },
      coverTemplateV1,
      coverRulesV1,
      today,
    );
    expect(tex).toContain('Dear Ms Weber,\n\n');
    expect(tex).toContain('Best regards,\\\\[14pt]');
    expect(tex).toContain('{Hiring Team, Data Engineer}{~}');
  });
});

describe('renderCover (template format 2)', () => {
  const withAddress = {
    ...fullProfile,
    frontMatter: { ...fullProfile.frontMatter, address: 'Example Street 1, 10115 Berlin, Germany' },
  };

  it('lays the letter out like a German business letter: sender, recipient, place and date, subject', () => {
    const tex = renderCover(goodCover, withAddress, coverJob, coverTemplate, coverRules, today);
    expect(tex).toContain(
      '\\letterSender{Alex Example}{Example Street 1, 10115 Berlin, Germany}{Telephone}{+49 000 0000000}{E-Mail}{alex@example.test}',
    );
    expect(tex).toContain('\\letterTo{Nimbus Analytics GmbH}{Berlin, Germany}');
    expect(tex).toContain('\\letterDateLine{Berlin, 20.11.2026}');
    expect(tex).toContain('\\letterSubject{Application for the position of Data Engineer}');
    expect(tex).toContain('Dear Hiring Team,\n\nI am applying for the Data Engineer role');
    expect(tex).toContain('\\letterClosing{Best regards,}{Alex Example}');
    expect(parseTemplate(tex, 'cover-letter').diagnostics).toEqual([]);
    expect(precheckTex(tex)).toEqual([]);
  });

  it('falls back to the location without an address; uses the rules place, date format and subject', () => {
    const rules = {
      ...coverRules,
      place: 'Potsdam',
      date_format: 'D MMMM YYYY' as const,
      subject: 'Re: {role}',
    };
    const tex = renderCover(
      goodCover,
      fullProfile,
      { ...coverJob, location: '' },
      coverTemplate,
      rules,
      today,
    );
    expect(tex).toContain('{Alex Example}{Berlin, Germany}{Telephone}');
    expect(tex).toContain('\\letterTo{Nimbus Analytics GmbH}{}');
    expect(tex).toContain('\\letterDateLine{Potsdam, 20 November 2026}');
    expect(tex).toContain('\\letterSubject{Re: Data Engineer}');
  });

  it('German: fixed German subject, salutation, closing and labels', () => {
    const tex = renderCover(goodCover, withAddress, coverJob, coverTemplate, coverRules, today, 'de');
    expect(tex).toContain('{Telefon}{+49 000 0000000}{E-Mail}');
    expect(tex).toContain('\\letterSubject{Bewerbung für die Position als Data Engineer}');
    expect(tex).toContain('Sehr geehrte Damen und Herren,\n\n');
    expect(tex).toContain('\\letterClosing{Mit freundlichen Grü\\ss{}en}{Alex Example}');
    expect(tex).toContain('\\letterDateLine{Berlin, 20.11.2026}');
  });

  it('takes the city from a location with a postcode', () => {
    expect(cityOf('10115 Berlin-Mitte, Germany')).toBe('Berlin-Mitte');
    expect(cityOf('Berlin, Germany')).toBe('Berlin');
    expect(cityOf('D-10115 Berlin')).toBe('Berlin');
    expect(cityOf('')).toBe('');
  });

  it('escapes model text, joins lines and drops empty paragraphs', () => {
    const tex = render(para('Cut 50% of costs & saved\n\nmoney_a {b} \\input{x}'));
    expect(tex).toContain('Cut 50\\% of costs \\& saved money\\_a \\{b\\} \\textbackslash{}input\\{x\\}');
    expect(precheckTex(tex)).toEqual([]);
    expect(
      readCover(render({ ...goodCover, paragraphs: [{ text: '  ', source_ids: [] }] })).paragraphs,
    ).toEqual([]);
  });

  it('always passes the pre-check, whatever the model writes', () => {
    const text = fc.oneof(
      fc.string({ unit: 'binary', maxLength: 80 }),
      fc.constantFrom('input', '\\input{x}', '^^5c', '%', '#', '}{', '\\', '{read}', '\\csname', 'write'),
    );
    fc.assert(
      fc.property(
        fc.record({
          salutation: fc.option(text),
          paragraphs: fc.array(fc.record({ text, source_ids: fc.constant<string[]>([]) }), { maxLength: 4 }),
          closing: fc.option(text),
        }),
        (c) => precheckTex(render(c)).length === 0,
      ),
      { numRuns: 150 },
    );
  });
});

describe('readCover + lintCover', () => {
  const lint = (c: CoverContent, rules: CoverLetterRules = coverRules, company = coverJob.company) =>
    lintCover(render(c, rules), rules, company);
  const rulesOf = (c: CoverContent, rules?: CoverLetterRules) => lint(c, rules).issues.map((i) => i.rule);

  it('the good letter is clean and reads back as 4 paragraphs', () => {
    const doc = readCover(render());
    expect(doc.salutation).toBe('Dear Hiring Team,');
    expect(doc.paragraphs).toHaveLength(4);
    expect(doc.words).toBeGreaterThanOrEqual(230);
    expect(doc.words).toBeLessThanOrEqual(350);
    expect(lint(goodCover)).toEqual({ ok: true, issues: [] });
  });

  it('flags too few and too many words', () => {
    expect(rulesOf({ ...goodCover, paragraphs: goodCover.paragraphs.slice(0, 3) })).toContain('words');
    const long = { text: 'More words here. '.repeat(100), source_ids: [] };
    expect(rulesOf({ ...goodCover, paragraphs: [...goodCover.paragraphs.slice(0, 2), long] })).toContain(
      'words',
    );
  });

  it('flags too few and too many paragraphs', () => {
    expect(rulesOf({ ...goodCover, paragraphs: goodCover.paragraphs.slice(0, 2) })).toContain('paragraphs');
    const five = [...goodCover.paragraphs, { text: 'A fifth paragraph.', source_ids: [] }];
    expect(rulesOf({ ...goodCover, paragraphs: five })).toContain('paragraphs');
  });

  it('flags banned phrases, case-insensitive, including inflected forms and curly apostrophes', () => {
    for (const phrase of ['I AM EXCITED TO APPLY', 'passionate', 'we leveraged data', 'In today’s market'])
      expect(lint(para(`${phrase} ${goodCover.paragraphs[0]?.text ?? ''}`)).issues, phrase).toContainEqual(
        expect.objectContaining({ rule: 'banned_phrases', path: 'paragraphs[0]' }),
      );
    expect(rulesOf(goodCover)).not.toContain('banned_phrases');
  });

  it('flags first person only when the rules forbid it', () => {
    const noFirst = { ...coverRules, first_person: false };
    expect(rulesOf(goodCover, noFirst)).toContain('first_person');
    expect(rulesOf(goodCover)).not.toContain('first_person');
  });

  it('flags more than 3 mentions of the company, ignoring the legal suffix and the recipient block', () => {
    const text = 'Nimbus Analytics is great. Nimbus Analytics builds. nimbus analytics GmbH forecasts. ';
    const issues = lint(para(text + (goodCover.paragraphs[0]?.text ?? ''))).issues;
    expect(issues).toContainEqual(expect.objectContaining({ rule: 'company_mentions' }));
    const short = 'Nimbus ships. Nimbus grows. Nimbus hires. Nimbus Analytics wins. ';
    expect(rulesOf(para(short + (goodCover.paragraphs[0]?.text ?? '')))).toContain('company_mentions');
    expect(rulesOf(goodCover)).not.toContain('company_mentions');
  });

  it('maps paragraph paths back to the content when empty paragraphs are dropped', () => {
    const c: CoverContent = {
      ...goodCover,
      paragraphs: [
        { text: '', source_ids: [] },
        { text: `passionate ${goodCover.paragraphs[0]?.text ?? ''}`, source_ids: [] },
        ...goodCover.paragraphs.slice(1),
      ],
    };
    const tex = render(c);
    expect(lintCover(tex, coverRules, coverJob.company, keptParagraphs(c)).issues[0]?.path).toBe(
      'paragraphs[1]',
    );
  });

  it('works on hand-edited tex (no content)', () => {
    const tex = render()
      .replace('Dear Hiring Team,', 'Dear Ms Weber,')
      .replace('I am applying', '% a comment\nI am applying');
    expect(readCover(tex).salutation).toBe('Dear Ms Weber,');
    expect(lintCover(tex, coverRules, coverJob.company).ok).toBe(true);
  });
});

describe('checkCoverTruth', () => {
  const truth = (c: CoverContent, company = coverPosting, jd = sampleJd) =>
    checkCoverTruth(c, fullProfile, { policy: seedPolicy, jd, company, today });
  const kinds = (c: CoverContent) => truth(c).violations.map((v) => `${v.kind}: ${v.detail}`);

  it('passes the good letter', () => {
    expect(truth(goodCover)).toEqual({ ok: true, violations: [], warnings: [] });
  });

  it('flags a foreign company and an invented number, with the paragraph path', () => {
    const t = truth(badCover);
    expect(t.ok).toBe(false);
    expect(t.violations.map((v) => [v.kind, v.path])).toEqual([
      ['number_not_in_source', 'paragraphs[1]'],
      ['unknown_organisation', 'paragraphs[1]'],
    ]);
  });

  it.each([
    'I admire the work done by Quokka on observability.',
    'I would love to join Stripe and build pipelines.',
    'My ideas come from Acme Inc and its customers.',
    'I worked with Spotify data, which taught me a lot.',
  ])('names no organisation outside the posting and the profile: %s', (text) => {
    expect(kinds(para(text)).join()).toMatch(/unknown_organisation/);
  });

  it('allows the target company (also with a possessive), profile employers and posting names', () => {
    expect(truth(para("Nimbus Analytics's team and Globex, at Initrode, in Berlin.")).violations).toEqual([]);
    const posting = `${coverPosting} The company is part of the Kestrel Group.`;
    expect(
      truth(para('I like that Nimbus Analytics is part of the Kestrel Group.'), posting).violations,
    ).toEqual([]);
    expect(
      truth(para('I like that Nimbus Analytics is part of the Kestrel Group.')).violations.length,
    ).toBeGreaterThan(0);
  });

  it('takes company facts only from the posting or the notes, never years or skills', () => {
    const claim = para('Nimbus Analytics has 60 people, and I know it well.');
    expect(kinds(claim).join()).toMatch(/number_not_in_source/);
    expect(truth(claim, `${coverPosting} We are 60 people and growing.`).violations).toEqual([]);
    // a years claim never comes from the posting ("8+ years" are asked of the candidate, not had by them)
    const years = para('I bring eight years of experience.');
    expect(truth(years, `${coverPosting} 8+ years of experience required.`).ok).toBe(false);
    // a skill the posting names but the profile lacks stays a violation
    expect(
      truth(para('I work daily with Kubernetes.'), `${coverPosting} Kubernetes required.`).violations,
    ).toContainEqual(expect.objectContaining({ kind: 'skill_not_allowed' }));
  });

  it('accepts the profile logistics lines (location, work authorisation, notice period)', () => {
    const t = truth(para('I live in Berlin, hold an EU Blue Card and have a notice period of one month.'));
    expect(t).toEqual({ ok: true, violations: [], warnings: [] });
    expect(truth(para('My notice period is two months.')).ok).toBe(false);
  });

  it('checks numbers against the cited entries, and unknown or excluded source ids', () => {
    const c: CoverContent = {
      ...goodCover,
      paragraphs: [{ text: 'At Globex I cut runtime from 2 h to 10 min.', source_ids: ['exp-nope'] }],
    };
    expect(kinds(c).join()).toMatch(/unknown_id[\s\S]*number_not_in_source/);
    expect(
      truth({ ...goodCover, paragraphs: [{ text: 'I cut runtime by 85%.', source_ids: ['exp-globex'] }] }).ok,
    ).toBe(false);
  });

  it('checks the salutation name and the closing', () => {
    const named = (salutation: string) => truth({ ...goodCover, salutation });
    expect(named('Dear Hiring Team,').ok).toBe(true);
    expect(named('Dear Ms Weber,').violations).toEqual([
      expect.objectContaining({ kind: 'name_not_in_source', path: 'salutation' }),
    ]);
    const withName = truth(
      { ...goodCover, salutation: 'Dear Ms Weber,' },
      `${coverPosting} Contact: Ms Weber.`,
    );
    expect(withName.ok).toBe(true);
    expect(truth({ ...goodCover, closing: 'Yours, the CTO of Zephyr Ltd' }).ok).toBe(false);
  });
});
