import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  parseProfile,
  removeSkill,
  serializeProfile,
  setFrontMatterField,
  upsertEntry,
  upsertSkill,
  validateProfile,
} from '../../../src/shared/profile';
import { fixture, fixtureNames, seedTemplate } from './helpers';

const roundTrip = (x: string): string => serializeProfile(parseProfile(x).doc);

describe('lossless round trip', () => {
  it.each(fixtureNames)('fixture %s', (name) => {
    const text = fixture(name);
    expect(roundTrip(text)).toBe(text);
  });

  it('the real seed template', () => {
    expect(roundTrip(seedTemplate())).toBe(seedTemplate());
  });

  it('arbitrary unicode strings', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (x) => roundTrip(x) === x),
      { numRuns: 500 },
    );
  });

  it('arbitrary strings built from markdown-ish characters', () => {
    const unit = fc.constantFrom(
      'a',
      'Z',
      ' ',
      '\t',
      '\n',
      '\r',
      '\r\n',
      '#',
      '|',
      '-',
      ':',
      '<!--',
      '-->',
      '`',
      '{#x}',
      '---',
      '\\',
    );
    fc.assert(
      fc.property(
        fc.array(unit, { maxLength: 80 }).map((p) => p.join('')),
        (x) => roundTrip(x) === x,
      ),
      {
        numRuns: 500,
      },
    );
  });

  const structural = [
    '---',
    '...',
    '# Title',
    '## Summary',
    '## Skills',
    '## Experience',
    '## Projects',
    '## Notes',
    '## Hobbies',
    '### Entry {#exp-a}',
    '### Other {#exp-b}',
    '### No id',
    '- start: 2020-01',
    '- end: present',
    '- A bullet with a fact',
    '  continuation of it',
    '| skill | category | level | years | last_used | evidence | status | aliases |',
    '|---|---|---|---|---|---|---|---|',
    '| Python | language | 4 | 3 | now | exp-a | have | py |',
    '| broken | row',
    '<!--',
    '-->',
    '```',
    'name: Someone',
    'email: a@b.test',
    '',
    '',
    'free text',
  ];
  const profileLike = fc
    .tuple(
      fc.array(fc.oneof(fc.constantFrom(...structural), fc.string({ maxLength: 12 })), { maxLength: 40 }),
      fc.constantFrom('\n', '\r\n'),
      fc.boolean(),
    )
    .map(([lines, eol, trailing]) => lines.join(eol) + (trailing ? eol : ''));

  it('profile-like markdown (lossless, never throws, edits never throw)', () => {
    fc.assert(
      fc.property(profileLike, (x) => {
        const { doc, model } = parseProfile(x);
        expect(serializeProfile(doc)).toBe(x);
        validateProfile(model);
        const row = {
          skill: 'Zig',
          category: 'language',
          level: 2,
          years: 1,
          last_used: 'now',
          evidence: [],
          status: 'learning',
          aliases: [],
        };
        for (const edited of [
          upsertSkill(doc, row),
          removeSkill(doc, 'Python'),
          setFrontMatterField(doc, 'name', 'New Name'),
          setFrontMatterField(doc, ['preferences', 'roles'], ['a', 'b']),
          upsertEntry(doc, 'experience', {
            id: 'exp-a',
            title: 'T',
            meta: { start: '2020-01' },
            bullets: ['x'],
          }),
        ]) {
          parseProfile(serializeProfile(edited));
        }
        // Edits are pure: the input doc is untouched.
        expect(serializeProfile(doc)).toBe(x);
      }),
      { numRuns: 400 },
    );
  });

  it('upsertSkill makes the skill visible to the parser on profile-like input', () => {
    const row = {
      skill: 'Zig',
      category: 'language',
      level: 2,
      years: 1,
      last_used: 'now',
      evidence: [],
      status: 'learning',
      aliases: [],
    };
    // Restrict to documents whose own skills table (if any) is well formed.
    const wellFormed = fc
      .tuple(
        fc.array(fc.constantFrom(...structural.filter((l) => !l.startsWith('| broken'))), { maxLength: 30 }),
        fc.constantFrom('\n', '\r\n'),
      )
      .map(([lines, eol]) => lines.join(eol) + eol);
    fc.assert(
      fc.property(wellFormed, (x) => {
        const { diagnostics } = parseProfile(x);
        fc.pre(!diagnostics.some((d) => d.code === 'skills_table_malformed'));
        const after = parseProfile(serializeProfile(upsertSkill(parseProfile(x).doc, row)));
        expect(after.model.skills.find((s) => s.skill === 'Zig')).toEqual(row);
      }),
      { numRuns: 300 },
    );
  });
});
