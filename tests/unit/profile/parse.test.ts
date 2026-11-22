import { describe, expect, it } from 'vitest';
import { parseProfile, ProfileSchema } from '../../../src/shared/profile';
import { fixture, fixtureNames, seedTemplate } from './helpers';

const codes = (name: string): string[] => parseProfile(fixture(name)).diagnostics.map((d) => d.code);

describe('parseProfile', () => {
  it('parses the full fixture into the model', () => {
    const { model, diagnostics } = parseProfile(fixture('full'));
    expect(diagnostics).toEqual([]);
    expect(model.frontMatter).toMatchObject({
      name: 'Alex Example',
      headline: 'Data Engineer',
      links: { github: 'https://github.example.test/alex', portfolio: '' },
      languages_spoken: [
        { language: 'English', level: 'C1' },
        { language: 'German', level: 'B2' },
      ],
      preferences: { roles: ['Data Engineer', 'Analytics Engineer'], remote: 'hybrid', salary_floor: 60000 },
      last_reviewed: '2026-11-01',
    });
    expect(model.summary).toBe(
      'Data engineer with five years of experience in batch pipelines.\nPrefers small teams.',
    );
    expect(model.skills).toHaveLength(6);
    expect(model.skills[1]).toEqual({
      skill: 'PostgreSQL',
      category: 'data',
      level: 4,
      years: 4,
      last_used: 'now',
      evidence: ['exp-globex'],
      status: 'have',
      aliases: ['Postgres', 'psql'],
    });
    expect(model.skills[4]).toMatchObject({
      skill: 'Kubernetes',
      last_used: '',
      evidence: [],
      status: 'want',
    });
    expect(model.experience.map((e) => e.id)).toEqual(['exp-globex', 'exp-initrode']);
    expect(model.experience[0]).toEqual({
      id: 'exp-globex',
      title: 'Data Engineer — Globex',
      meta: { start: '2022-03', end: 'present', location: 'Berlin, Germany', type: 'full-time' },
      bullets: [
        'Cut nightly report runtime from 2 h to 10 min by rewriting SQL pipelines.',
        'Owned the Airflow deployment for six teams.',
      ],
    });
    expect(model.certifications[0]?.meta).toEqual({ date: '2024-05', credential_url: '' });
    expect(model.languages[0]?.id).toBe('lang-en');
    expect(model.notes).toBe(
      'Do not mention the 2019 internship.\nPrefer framing as data engineer, not analyst.',
    );
    expect(ProfileSchema.safeParse(model).success).toBe(true);
  });

  it('parses the real seed template without diagnostics; commented-out entries are ignored', () => {
    const { model, diagnostics } = parseProfile(seedTemplate());
    expect(diagnostics).toEqual([]);
    expect(model.skills.map((s) => s.skill)).toEqual(['Python', 'SQL', 'Docker']);
    expect(model.certifications).toEqual([]);
    expect(model.summary).toBe('');
    expect(model.notes).toBe('');
    expect(model.experience[0]?.meta['location']).toBe('City, Country');
    expect(model.projects[0]?.meta['link']).toBe('');
    expect(model.frontMatter.preferences.remote).toBe('hybrid');
  });

  it('matches section headings case-insensitively and keeps unknown sections out of the model', () => {
    const { model } = parseProfile(
      '---\nname: A\n---\n## SKILLS\n\n| skill | level |\n|---|---|\n| Go | 3 |\n\n## Hobbies\n\n### X {#x}\n',
    );
    expect(model.skills[0]).toMatchObject({ skill: 'Go', level: 3, category: '' });
    expect(model.experience).toEqual([]);
  });

  it('ignores headings inside code fences and comments', () => {
    const { model } = parseProfile(fixture('unknown-sections'));
    expect(model.experience).toEqual([]);
    expect(model.skills.map((s) => s.skill)).toEqual(['Rust']);
    expect(model.summary).toBe('Short.');
  });

  it('reads CRLF files the same as LF files', () => {
    const lf = parseProfile(fixture('crlf').replace(/\r\n/g, '\n')).model;
    expect(parseProfile(fixture('crlf')).model).toEqual(lf);
    expect(lf.skills[0]?.skill).toBe('Go');
    expect(lf.notes).toBe('Windows line endings everywhere.');
  });

  it('handles unicode', () => {
    const { model } = parseProfile(fixture('unicode'));
    expect(model.frontMatter.name).toBe('Zoë Ångström');
    expect(model.skills[0]?.aliases).toEqual(['Größe', '大きさ']);
    expect(model.experience[0]?.id).toBe('exp-ü');
  });

  it('reports a missing front matter and an unterminated one', () => {
    expect(codes('missing-front-matter')).toContain('frontmatter_missing');
    expect(parseProfile(fixture('missing-front-matter')).model.skills).toHaveLength(1);
    expect(codes('unterminated-front-matter')).toEqual(['frontmatter_unterminated']);
  });

  it('reports YAML errors with a line and falls back to default front matter', () => {
    const { model, diagnostics } = parseProfile(fixture('bad-yaml'));
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics.every((d) => d.code === 'frontmatter_yaml' && d.severity === 'error')).toBe(true);
    expect(diagnostics[0]?.line).toBeGreaterThanOrEqual(2);
    expect(model.frontMatter.name).toBe('');
    expect(model.summary).toBe('Front matter does not parse.');
  });

  it('drops only the invalid front matter field', () => {
    const { model, diagnostics } = parseProfile(
      '---\nname: A\nemail: a@b.test\npreferences:\n  salary_floor: lots\n  remote: remote\n---\n',
    );
    expect(diagnostics.map((d) => d.code)).toEqual(['frontmatter_invalid']);
    expect(model.frontMatter.name).toBe('A');
    expect(model.frontMatter.preferences).toMatchObject({ salary_floor: null, remote: 'remote' });
  });

  it('reports a malformed skills table row by row', () => {
    const { model, diagnostics } = parseProfile(fixture('malformed-table'));
    expect(model.skills.map((s) => s.skill)).toEqual(['Python', 'Java', 'Short', 'Extra', '', 'Pipe | Name']);
    expect(model.skills[0]).toMatchObject({ level: null, years: null });
    expect(model.skills[5]?.aliases).toEqual(['a|b']);
    expect(diagnostics.filter((d) => d.code === 'skill_number_invalid')).toHaveLength(2);
    expect(diagnostics.filter((d) => d.code === 'skill_row_columns').map((d) => d.line)).toEqual([12, 13]);
  });

  it('reports a table without separator and a table without a skill column', () => {
    expect(
      parseProfile('## Skills\n\n| skill | level |\n| Go | 3 |\n').diagnostics.map((d) => d.code),
    ).toContain('skills_table_malformed');
    const r = parseProfile('## Skills\n\n| name | level |\n|---|---|\n| Go | 3 |\n');
    expect(r.model.skills).toEqual([]);
    expect(r.diagnostics.map((d) => d.code)).toContain('skills_table_malformed');
  });

  it('keeps duplicate ids and id-less entries for the validator; first duplicate section wins', () => {
    const { model, diagnostics } = parseProfile(fixture('duplicate-ids'));
    expect(model.experience.map((e) => e.id)).toEqual(['exp-a', 'exp-a']);
    expect(model.projects[0]).toMatchObject({ id: '', title: 'Thing without id' });
    expect(diagnostics).toEqual([]);
    const dup = parseProfile('## Notes\n\nfirst\n\n## notes\n\nsecond\n');
    expect(dup.model.notes).toBe('first');
    expect(dup.diagnostics.map((d) => d.code)).toContain('section_duplicate');
  });

  it('separates meta from bullets: key: value lines directly under the heading are meta', () => {
    const e = parseProfile(
      '## Experience\n\n### T {#exp-t}\n- start: 2020-01\n- note: "  padded "\n\n- Result: 3x faster\n- plain\n  wrapped\n',
    ).model.experience[0];
    expect(e?.meta).toEqual({ start: '2020-01', note: '  padded ' });
    expect(e?.bullets).toEqual(['Result: 3x faster', 'plain wrapped']);
  });

  it('warns about stray text inside an entry', () => {
    const { diagnostics } = parseProfile('## Experience\n\n### T {#exp-t}\nsome loose text\n- a\n');
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ code: 'entry_stray_text', severity: 'warning', line: 4 }),
    );
  });

  it('accepts a byte order mark before the front matter', () => {
    expect(parseProfile('﻿---\nname: A\n---\n').model.frontMatter.name).toBe('A');
  });

  describe('comments and fences', () => {
    const doc = (body: string): string => `---\nname: A\n---\n\n${body}`;
    const skillsAfter =
      '\n## Skills\n\n| skill | category | level | years | last_used | evidence | status | aliases |\n|---|---|---|---|---|---|---|---|\n| Go | language | 3 | 1 | now | | have | |\n';

    it('does not start a comment from an inline <!-- inside a bullet', () => {
      const r = parseProfile(doc(`## Experience\n\n### T {#exp-t}\n\n- uses <!-- tags\n${skillsAfter}`));
      expect(r.model.skills).toHaveLength(1);
      expect(r.model.experience[0]?.bullets).toEqual(['uses <!-- tags']);
      expect(r.diagnostics).toEqual([]);
    });

    it('reports an unclosed block comment with the line where it opened', () => {
      const r = parseProfile(doc(`## Summary\n\n<!-- never closed\n${skillsAfter}`));
      expect(r.model.skills).toHaveLength(0);
      expect(r.diagnostics).toContainEqual(
        expect.objectContaining({ severity: 'error', code: 'comment_unclosed', line: 7 }),
      );
    });

    it('reports an unclosed code fence with the line where it opened', () => {
      const r = parseProfile(doc(`## Summary\n\n\`\`\`\nx\n${skillsAfter}`));
      expect(r.model.skills).toHaveLength(0);
      expect(r.diagnostics).toContainEqual(
        expect.objectContaining({ severity: 'error', code: 'fence_unclosed', line: 7 }),
      );
    });

    it('stays lossless and quiet for closed comments and fences', () => {
      const text = doc(`## Summary\n\n<!-- ok -->\n\`\`\`\nx\n\`\`\`\n${skillsAfter}`);
      const r = parseProfile(text);
      expect(r.model.skills).toHaveLength(1);
      expect(r.diagnostics).toEqual([]);
      expect(r.doc.lines.join('')).toBe(text);
    });
  });

  it('never throws and always returns a schema-valid model', () => {
    for (const name of fixtureNames) {
      expect(ProfileSchema.safeParse(parseProfile(fixture(name)).model).success).toBe(true);
    }
    expect(parseProfile('').model).toEqual(ProfileSchema.parse({}));
  });
});
