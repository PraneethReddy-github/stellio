import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  extractPage,
  fragmentToMarkdown,
  looksLikeLoginWall,
  MIN_JD_CHARS,
} from '../../../src/main/services/jobs/html';

const read = (rel: string): string => readFileSync(resolve('tests', rel), 'utf8');

describe('extractPage', () => {
  it('keeps the posting and drops cookie banner, nav, related jobs, footer, scripts', () => {
    const r = extractPage(read('evals/jds/20-senior-data-engineer-remote-us.html'));
    expect(r.loginWall).toBe(false);
    expect(r.markdown.length).toBeGreaterThan(MIN_JD_CHARS);
    expect(r.markdown).toContain('# Senior Data Engineer');
    expect(r.markdown).toContain('$140,000 - $165,000 USD');
    expect(r.markdown).toContain('Kafka, Spark and Snowflake');
    for (const junk of [
      'Accept all',
      'Similar jobs',
      'Other opening',
      'All rights reserved',
      'dataLayer',
      'Cookie settings',
    ])
      expect(r.markdown, junk).not.toContain(junk);
  });

  it('reads a German page wrapped in one big <form> (the form is unwrapped, not dropped)', () => {
    const r = extractPage(read('evals/jds/21-senior-devops-koeln.html'));
    expect(r.markdown).toContain('Ihre Aufgaben');
    expect(r.markdown).toContain('Verhandlungssichere Deutschkenntnisse');
    expect(r.markdown).not.toContain('Cookie');
  });

  it('flags a login wall', () => {
    const r = extractPage(read('fixtures/pages/login-wall.html'));
    expect(r.loginWall).toBe(true);
    expect(r.markdown.length).toBeLessThan(MIN_JD_CHARS);
  });

  it('never reads text that only exists inside scripts (no JS is executed)', () => {
    const r = extractPage(read('fixtures/pages/js-shell.html'));
    expect(r.markdown).toBe('');
    expect(r.markdown).not.toContain('Hidden Engineer');
  });

  it('strips scripts, handlers, frames, forms and unsafe links from hostile pages', () => {
    const r = extractPage(read('fixtures/pages/hostile.html'));
    expect(r.markdown).toContain('Platform Engineer');
    expect(r.markdown).toContain('90,000 - 110,000 USD');
    expect(r.markdown).toContain('(https://jobs.example.test/apply?id=7)');
    for (const bad of [
      'steal',
      'javascript:',
      'data:text',
      'evil.example',
      'ssn',
      'Social security',
      '<script',
      'onerror',
    ])
      expect(r.markdown, bad).not.toContain(bad);
  });

  it('output is Markdown, never HTML tags', () => {
    for (const f of ['evals/jds/20-senior-data-engineer-remote-us.html', 'fixtures/pages/hostile.html'])
      expect(extractPage(read(f)).markdown).not.toMatch(/<\/?(div|p|ul|li|a|span|script|iframe)\b/i);
  });
});

describe('looksLikeLoginWall', () => {
  it('needs a password field or two wall phrases, and short text', () => {
    expect(looksLikeLoginWall('Sign in or create an account', false)).toBe(true);
    expect(looksLikeLoginWall('Please sign in', false)).toBe(false);
    expect(looksLikeLoginWall('Anything', true)).toBe(true);
    expect(looksLikeLoginWall('sign in log in '.repeat(400), false)).toBe(false);
  });
});

describe('fragmentToMarkdown', () => {
  it('converts lists and headings, removes scripts and handlers', () => {
    const md = fragmentToMarkdown(
      '<h2>Req</h2><ul><li onclick="x()">SQL</li></ul><script>alert(1)</script><a href="javascript:x()">bad</a>',
    );
    expect(md).toContain('## Req');
    expect(md).toContain('-   SQL');
    expect(md).not.toMatch(/alert|onclick|javascript:/);
  });
});
