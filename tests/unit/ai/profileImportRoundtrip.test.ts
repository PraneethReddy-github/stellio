import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseProfile, profileToMarkdown } from '../../../src/shared/profile';
import { importToProfile } from '../../../src/main/services/profile/importMapper';
import { ProfileImportOutput } from '../../../src/main/ai/tasks/profileImport';

// Strings the way a model emits them: one line, trimmed, but free to contain markdown/YAML/table syntax.
const nasty = fc.constantFrom(
  '#',
  '##',
  '<!--',
  '-->',
  '```',
  '~~~',
  '{#x}',
  '\\',
  '|',
  '"',
  ':',
  "'",
  '- ',
  '* ',
  '[x](y)',
  '---',
  'é',
  '日本',
  '&amp;',
);
const piece = fc.oneof(fc.stringMatching(/^[A-Za-z0-9.,;()/+-]{1,8}$/), nasty);
const line = fc
  .array(piece, { minLength: 1, maxLength: 5 })
  .map((p) => p.join(' ').trim())
  .filter((s) => s !== '');
const maybeLine = fc.oneof(line, fc.constant(''));
const block = fc.array(maybeLine, { maxLength: 4 }).map((l) => l.join('\n').trim());
const slug = fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,10}$/);
// Cell text must survive trim and the comma-separated aliases column.
const alias = line.filter((s) => !s.includes(','));

const skill = fc.record({
  skill: line,
  category: fc.constantFrom('language', 'framework', 'tool', 'cloud', 'data', 'practice', 'domain', 'soft'),
  level: fc.integer({ min: 1, max: 5 }),
  years: fc.integer({ min: 0, max: 80 }).map((n) => n / 2),
  last_used: fc.constantFrom('', 'now', '2019', '2024'),
  evidence: fc.array(slug, { maxLength: 3 }),
  status: fc.constantFrom('have', 'learning', 'want'),
  aliases: fc.array(alias, { maxLength: 3 }),
});
const entry = fc.record({
  id: slug,
  title: line,
  meta: fc.dictionary(fc.stringMatching(/^[a-z_]{1,8}$/), maybeLine, { maxKeys: 4 }),
  bullets: fc.array(line, { maxLength: 4 }),
});
const entries = fc.array(entry, { maxLength: 3 });

const importOutput: fc.Arbitrary<ProfileImportOutput> = fc.record({
  front: fc.record({
    name: maybeLine,
    headline: maybeLine,
    email: maybeLine,
    phone: maybeLine,
    location: maybeLine,
    links: fc.record({ linkedin: maybeLine, github: maybeLine, portfolio: maybeLine }),
    work_authorization: maybeLine,
    notice_period: maybeLine,
    languages_spoken: fc.array(fc.record({ language: line, level: maybeLine }), { maxLength: 3 }),
  }),
  summary: block,
  skills: fc.array(skill, { maxLength: 5 }),
  experience: entries,
  projects: entries,
  education: entries,
  certifications: entries,
  awards: entries,
  publications: entries,
  notes: block,
});

describe('profile import -> markdown -> parse', () => {
  it('generated outputs are valid against the import schema', () => {
    fc.assert(
      fc.property(importOutput, (x) => {
        expect(ProfileImportOutput.safeParse(x).success).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('round-trips to the same model with no parse errors', () => {
    fc.assert(
      fc.property(importOutput, (x) => {
        const model = importToProfile(x, '2026-11-19');
        const r = parseProfile(profileToMarkdown(model));
        expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
        expect(r.model).toEqual(model);
      }),
      { numRuns: 500 },
    );
  }, 60_000); // 500 fast-check runs; slow under a parallel suite
});
