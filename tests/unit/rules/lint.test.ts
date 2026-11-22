import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RULE_FILES, RULE_KIND, lintRules } from '../../../src/shared/rules';

const seed = (p: string): string => readFileSync(new URL(`../../../seed/${p}`, import.meta.url), 'utf8');

describe('lintRules', () => {
  it.each(RULE_FILES)('seed %s lints clean', (path) => {
    const r = lintRules(RULE_KIND[path], seed(path));
    expect(r.diagnostics).toEqual([]);
    expect(r.config?.version).toBe(1);
  });

  it('returns the seed values as typed config', () => {
    const r = lintRules('resume', seed('rules/resume.md'));
    expect(r.config?.bullet).toMatchObject({ min_chars: 60, max_chars: 190 });
    expect(r.config?.banned_words).toContain('spearheaded');
    expect(r.config?.sections_order[0]).toBe('header');
  });

  it('fills defaults for missing optional keys', () => {
    const r = lintRules('skills-policy', '---\nversion: 1\n---\nbody');
    expect(r.diagnostics).toEqual([]);
    expect(r.config).toMatchObject({ min_level_to_list: 2, ghost_skill_policy: 'block' });
  });

  it('reports missing and unterminated front matter with line 1', () => {
    expect(lintRules('resume', '# no front matter').diagnostics).toEqual([
      expect.objectContaining({ code: 'frontmatter_missing', severity: 'error', line: 1 }),
    ]);
    const r = lintRules('resume', '---\nversion: 1\nno end');
    expect(r.diagnostics[0]).toMatchObject({ code: 'frontmatter_unterminated', line: 1 });
    expect(r.config).toBeNull();
  });

  it('reports YAML syntax errors with the file line', () => {
    const r = lintRules('resume', '---\nversion: 1\npage_limit: [1\nphoto: false\n---\n');
    expect(r.config).toBeNull();
    expect(r.diagnostics[0]).toMatchObject({ code: 'frontmatter_yaml', severity: 'error' });
    expect(r.diagnostics[0]?.line).toBeGreaterThanOrEqual(3);
  });

  it('maps schema violations to the key line, including nested keys', () => {
    const md = [
      '---',
      'version: 1',
      'page_limit: 9',
      'bullet:',
      '  min_chars: 60',
      '  max_chars: "x"',
      '---',
    ].join('\n');
    const r = lintRules('resume', md);
    expect(r.config).toBeNull();
    const byLine = new Map(r.diagnostics.map((d) => [d.line, d.message] as const));
    expect(byLine.get(3)).toMatch(/page_limit/);
    expect(byLine.get(6)).toMatch(/bullet\.max_chars/);
  });

  it('requires version and rejects unsupported versions', () => {
    const missing = lintRules('resume', '---\npage_limit: 1\n---\n').diagnostics[0];
    expect(missing?.code).toBe('rules_missing_key');
    expect(missing?.message).toContain('version');
    expect(lintRules('resume', '---\nversion: 2\n---\n').config).toBeNull();
  });

  it('unknown keys are warnings and the config is still returned', () => {
    const r = lintRules(
      'cover-letter',
      '---\nversion: 1\nwords: { min: 100, max: 200, avg: 3 }\nfoo: 1\n---\n',
    );
    expect(r.config?.words).toEqual({ min: 100, max: 200 });
    expect(r.diagnostics.map((d) => [d.severity, d.code, d.line])).toEqual([
      ['warning', 'rules_unknown_key', 3],
      ['warning', 'rules_unknown_key', 4],
    ]);
  });

  it('checks cross-key constraints', () => {
    const range = lintRules('cover-letter', '---\nversion: 1\nwords: { min: 400, max: 100 }\n---\n');
    expect(range.diagnostics[0]).toMatchObject({ severity: 'error', line: 3 });
    const sections = lintRules(
      'resume',
      '---\nversion: 1\nsections_order: [header]\nsections_required: [header, skills]\n---\n',
    );
    expect(sections.diagnostics[0]?.line).toBe(4);
    expect(sections.diagnostics[0]?.message).toContain('skills');
  });

  it('rejects non-mapping front matter and bad enums', () => {
    expect(lintRules('resume', '---\n- a\n- b\n---\n').diagnostics[0]?.code).toBe('frontmatter_not_mapping');
    const r = lintRules('skills-policy', '---\nversion: 1\nghost_skill_policy: allow\n---\n');
    expect(r.diagnostics[0]).toMatchObject({ line: 3 });
  });

  it('never throws on arbitrary text', () => {
    for (const s of [
      '',
      '---',
      '---\n---',
      '---\n:\n---',
      '\uFEFF---\nversion: 1\n---',
      '---\r\nversion: 1\r\n---\r\n',
    ])
      expect(() => lintRules('resume', s)).not.toThrow();
    expect(lintRules('resume', '\uFEFF---\nversion: 1\n---').config).not.toBeNull();
  });
});
