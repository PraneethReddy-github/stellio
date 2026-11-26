import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  ENTRY_SECTIONS,
  parseProfile,
  profileToMarkdown,
  ProfileSchema,
  serializeProfile,
  type Entry,
  type Profile,
  type SkillRow,
} from '../../../src/shared/profile';
import { fixture, fixtureNames } from './helpers';

const back = (m: Profile): ReturnType<typeof parseProfile> => parseProfile(profileToMarkdown(m));

describe('profileToMarkdown', () => {
  it('renders an empty model as a valid template that parses back to it', () => {
    const empty = ProfileSchema.parse({});
    const r = back(empty);
    expect(r.model).toEqual(empty);
    expect(r.diagnostics).toEqual([]);
  });

  it.each(fixtureNames)('fixture %s: model -> markdown -> model is stable', (name) => {
    const model = parseProfile(fixture(name)).model;
    // Rows the parser kept but a file cannot express (pipes are escaped, so these do round-trip).
    expect(back(model).model).toEqual(model);
  });

  it('output is lossless under parse/serialize and uses LF', () => {
    const md = profileToMarkdown(parseProfile(fixture('full')).model);
    expect(serializeProfile(parseProfile(md).doc)).toBe(md);
    expect(md).not.toContain('\r');
    expect(md.endsWith('\n')).toBe(true);
    expect(md).toContain('| skill | category | level | years | last_used | evidence | status | aliases |');
  });

  it('escapes free text and titles that would be read as structure', () => {
    const m = ProfileSchema.parse({
      summary: '## Skills\n<!-- hidden\n```\n~~~\n  <!-- x\n\\# already escaped\nplain # fine',
      notes: '# Heading\n### three\n<!-- c -->\ntext',
      skills: [
        {
          skill: 'Go',
          category: 'language',
          level: 3,
          years: 1,
          last_used: 'now',
          evidence: [],
          status: 'have',
          aliases: [],
        },
      ],
      experience: [
        { id: '', title: 'Role {#fake}', meta: {}, bullets: ['uses <!-- tags', '# not a heading', '```js'] },
        { id: 'exp-x', title: 'A \\{#b} {#c}', meta: {}, bullets: [] },
      ],
    });
    const r = back(m);
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(r.model).toEqual(m);
  });

  const word = fc.stringMatching(/^[A-Za-z0-9é日][A-Za-z0-9é日.,'-]{0,8}$/);
  const text = fc.array(word, { minLength: 1, maxLength: 4 }).map((w) => w.join(' '));
  const listItem = fc.stringMatching(/^[A-Za-z0-9é日][A-Za-z0-9é日.'-]{0,8}$/);
  const slug = fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,8}$/);
  const entry: fc.Arbitrary<Entry> = fc.record({
    id: slug,
    title: text,
    meta: fc.dictionary(fc.stringMatching(/^[a-z_][a-z_-]{0,6}$/), fc.oneof(text, fc.constant('')), {
      maxKeys: 4,
    }),
    bullets: fc.array(text, { maxLength: 4 }),
  });
  const skill: fc.Arbitrary<SkillRow> = fc.record({
    skill: text,
    category: fc.constantFrom('language', 'tool', 'data', 'weird'),
    level: fc.option(fc.integer({ min: 1, max: 5 }), { nil: null }),
    years: fc.option(fc.constantFrom(0, 1, 2.5, 10), { nil: null }),
    last_used: fc.constantFrom('', 'now', '2024'),
    evidence: fc.array(slug, { maxLength: 3 }),
    status: fc.constantFrom('have', 'learning', 'want'),
    aliases: fc.array(listItem, { maxLength: 3 }),
  });
  const multiline = fc.array(text, { maxLength: 3 }).map((l) => l.join('\n'));
  const model: fc.Arbitrary<Profile> = fc
    .record({
      frontMatter: fc.record({
        name: text,
        headline: fc.oneof(text, fc.constant('')),
        email: text,
        phone: fc.oneof(text, fc.constant('')),
        location: fc.oneof(text, fc.constant('')),
        address: fc.oneof(text, fc.constant('')),
        links: fc.record({
          linkedin: fc.oneof(text, fc.constant('')),
          github: fc.constant(''),
          portfolio: fc.constant(''),
        }),
        work_authorization: fc.oneof(text, fc.constant('')),
        notice_period: fc.constant(''),
        languages_spoken: fc.array(fc.record({ language: text, level: fc.constantFrom('', 'C1') }), {
          maxLength: 2,
        }),
        preferences: fc.record({
          roles: fc.array(text, { maxLength: 3 }),
          seniority: fc.array(fc.constantFrom('junior', 'mid'), { maxLength: 2 }),
          locations: fc.array(text, { maxLength: 2 }),
          remote: fc.constantFrom('onsite', 'hybrid', 'remote', 'any'),
          salary_floor: fc.option(fc.integer({ min: 0, max: 400000 }), { nil: null }),
          currency: fc.constantFrom('', 'EUR'),
          industries_prefer: fc.array(text, { maxLength: 2 }),
          industries_avoid: fc.array(text, { maxLength: 2 }),
          companies_avoid: fc.array(text, { maxLength: 2 }),
        }),
        last_reviewed: fc.constantFrom('', '2026-11-19'),
      }),
      summary: multiline,
      skills: fc.array(skill, { maxLength: 5 }),
      experience: fc.array(entry, { maxLength: 3 }),
      projects: fc.array(entry, { maxLength: 2 }),
      education: fc.array(entry, { maxLength: 2 }),
      certifications: fc.array(entry, { maxLength: 2 }),
      awards: fc.array(entry, { maxLength: 2 }),
      publications: fc.array(entry, { maxLength: 2 }),
      patents: fc.array(entry, { maxLength: 2 }),
      languages: fc.array(entry, { maxLength: 2 }),
      notes: multiline,
    })
    .map((m) => ProfileSchema.parse(m));

  it('generated models round-trip through markdown', () => {
    fc.assert(
      fc.property(model, (m) => {
        const r = back(m);
        expect(r.model).toEqual(m);
        expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
      }),
      { numRuns: 300 },
    );
    expect(ENTRY_SECTIONS).toHaveLength(8);
  });
});
