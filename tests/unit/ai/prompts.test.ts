import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createClaudeRunner } from '../../../src/main/ai/runner';
import { loadPrompt } from '../../../src/main/ai/prompts';
import { ProfileImportOutput, importProfile } from '../../../src/main/ai/tasks/profileImport';

describe('loadPrompt', () => {
  it('loads the latest version of profile.import with its schema', () => {
    const p = loadPrompt('profile.import');
    expect(p.version).toBe(1);
    expect(p.system).toMatch(/never invent/i);
    expect(p.jsonSchema).toMatchObject({ type: 'object' });
  });

  it('loads an explicit version and rejects unknown tasks/versions', () => {
    expect(loadPrompt('profile.import', 1).version).toBe(1);
    expect(() => loadPrompt('profile.import', 99)).toThrow(/not found/i);
    expect(() => loadPrompt('nope.task')).toThrow(/not found/i);
  });

  it('schema.json stays in sync with the zod schema', () => {
    const onDisk = JSON.parse(readFileSync(resolve('prompts/profile.import/schema.json'), 'utf8')) as object;
    const generated: Record<string, unknown> = { ...z.toJSONSchema(ProfileImportOutput) };
    delete generated.$schema;
    expect(onDisk).toEqual(generated);
  });
});

const sample: ProfileImportOutput = {
  front: {
    name: 'Jordan Vale',
    headline: 'Data Engineer',
    email: 'jordan.vale@example.com',
    phone: '',
    location: 'Berlin, Germany',
    links: { linkedin: '', github: '', portfolio: '' },
    work_authorization: '',
    notice_period: '',
    languages_spoken: [{ language: 'English', level: 'fluent' }],
  },
  summary: '',
  skills: [
    {
      skill: 'Python',
      category: 'language',
      level: 3,
      years: 5,
      last_used: 'now',
      evidence: ['exp-brightwater-analytics'],
      status: 'have',
      aliases: ['py'],
    },
  ],
  experience: [
    {
      id: 'exp-brightwater-analytics',
      title: 'Senior Data Engineer — Brightwater Analytics GmbH',
      meta: { start: '2022-03', end: 'present' },
      bullets: ['Rebuilt the nightly sales ETL.'],
    },
  ],
  projects: [],
  education: [],
  certifications: [],
  awards: [],
  publications: [],
  notes: '',
};

describe('ProfileImportOutput', () => {
  it('accepts a well-formed draft', () => {
    expect(ProfileImportOutput.safeParse(sample).success).toBe(true);
  });
  it('rejects out-of-range levels, unknown categories and missing sections', () => {
    const bad = (s: object) => ProfileImportOutput.safeParse(s).success;
    expect(bad({ ...sample, skills: [{ ...sample.skills[0], level: 7 }] })).toBe(false);
    expect(bad({ ...sample, skills: [{ ...sample.skills[0], category: 'magic' }] })).toBe(false);
    expect(bad({ ...sample, experience: undefined })).toBe(false);
  });
});

describe('importProfile', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'stellio-import-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('runs profile.import through the runner with prompt v1, high effort and wrapped input', async () => {
    const runner = createClaudeRunner({
      bin: resolve('tests/fixtures/fake-claude/claude.mjs'),
      cwd: join(dir, 'cwd'),
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      env: {
        FAKE_CLAUDE_MODE: 'ok',
        FAKE_CLAUDE_OUTPUT: JSON.stringify(sample),
        FAKE_CLAUDE_CAPTURE: join(dir, 'cap.ndjson'),
      },
    });
    const res = await importProfile(runner, {
      resumeText: 'Jordan Vale\nData Engineer',
      config: { model: 'sonnet', effort: 'high', timeoutMs: 300_000 },
    });
    expect(res).toMatchObject({ ok: true, data: { front: { name: 'Jordan Vale' } } });
    const call = JSON.parse(readFileSync(join(dir, 'cap.ndjson'), 'utf8').split('\n')[0] ?? '') as {
      argv: string[];
      stdin: string;
    };
    expect(call.stdin).toBe('<resume_text>\nJordan Vale\nData Engineer\n</resume_text>');
    expect(call.argv).toContain('high');
    expect(call.argv[call.argv.indexOf('--system-prompt') + 1]).toBe(loadPrompt('profile.import').system);
  });
});
