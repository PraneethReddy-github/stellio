import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { sampleAnalysis, sampleJd } from '../fixtures/jobs';
import { goodContent } from '../fixtures/resume';
import { invoke, launchApp, type Launched } from './helpers';

const FAKE_CLAUDE = resolve('tests/fixtures/fake-claude/claude.mjs');
const TECTONIC = process.env.STELLIO_TECTONIC_BIN || resolve('spikes/latex/bin/tectonic');
const POSTING = `Data Engineer (m/w/d) at Nimbus Analytics GmbH in Berlin. ${'Build pipelines in Python and SQL. '.repeat(5)}`;

type Res<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };
interface Row {
  skill: string;
  recommendation: string;
  decision: string;
  rationale: string | null;
  learnEstimateHours: number | null;
}
interface View {
  content: { skills: { skills: string[] }[]; change_log: string[] };
  checks: { truth: { ok: boolean; violations: unknown[] } | null };
  meta: { version: number; parentVersion: number | null };
}
interface Preview {
  before: string;
  after: string;
  expectedHash: string;
}

const jd = {
  ...sampleJd,
  requirements: [
    ...sampleJd.requirements,
    { text: 'dbt is a plus', kind: 'preferred' as const, skills: ['dbt'] },
  ],
};
const wording = {
  rows: [
    { skill: 'PostgreSQL', rationale: 'The posting never mentions it.', learn_estimate_hours: null },
    { skill: 'Airflow', rationale: 'Not asked for.', learn_estimate_hours: null },
    { skill: 'dbt', rationale: 'Preferred and not in your profile.', learn_estimate_hours: 24 },
  ],
};

async function launch(generate: unknown): Promise<{ l: Launched; jobId: string; call: Call; ok: Ok }> {
  const l = await launchApp({
    STELLIO_CLAUDE_BIN: FAKE_CLAUDE,
    ...(existsSync(TECTONIC) ? { STELLIO_TECTONIC_BIN: TECTONIC } : {}),
    FAKE_CLAUDE_MODE: 'ok',
    FAKE_CLAUDE_OUTPUT_JD_PARSE: JSON.stringify(jd),
    FAKE_CLAUDE_OUTPUT_JOB_ANALYZE: JSON.stringify(sampleAnalysis),
    FAKE_CLAUDE_OUTPUT_RESUME_GENERATE: JSON.stringify(generate),
    FAKE_CLAUDE_OUTPUT_SKILLS_AUDIT: JSON.stringify(wording),
  });
  const call: Call = (channel, input) => invoke(l.page, channel, input) as Promise<Res<never>>;
  const ok: Ok = async (channel, input) => {
    const r = await call(channel, input);
    if (!r.ok) throw new Error(`${channel}: ${r.error.message}`);
    return r.data;
  };
  await ok('profile:save', {
    markdown: readFileSync(resolve('tests/fixtures/profiles/full.md'), 'utf8'),
    expectedHash: null,
  });
  const intake = await ok<{ jobId: string }>('jobs:intakeText', { text: POSTING, requestId: randomUUID() });
  return { l, jobId: intake.jobId, call, ok };
}
type Call = (channel: string, input?: unknown) => Promise<Res<never>>;
type Ok = <T = unknown>(channel: string, input?: unknown) => Promise<T>;

test.describe('skill audit and decisions over IPC (fake CLI)', () => {
  let l: Launched;
  let jobId = '';
  let call: Call;
  let ok: Ok;
  test.beforeAll(async () => {
    ({ l, jobId, call, ok } = await launch(goodContent));
    await ok('resume:generate', { jobId, requestId: randomUUID() });
  });
  test.afterAll(async () => {
    await l.close();
  });

  test('audit → remove → v2 without the skill, truth still clean', async () => {
    const audit = await ok<{ rows: Row[]; aiWarning: string | null }>('skills:audit', {
      jobId,
      version: 1,
      requestId: randomUUID(),
    });
    expect(audit.aiWarning).toBeNull();
    const pg = audit.rows.find((r) => r.skill === 'PostgreSQL');
    expect(pg).toMatchObject({ recommendation: 'remove', rationale: 'The posting never mentions it.' });
    expect(audit.rows.find((r) => r.skill === 'dbt')).toMatchObject({
      recommendation: 'learn',
      learnEstimateHours: 24,
    });

    const decided = await ok<{ audit: Row[]; newVersion?: number }>('skills:decide', {
      jobId,
      version: 1,
      skill: 'PostgreSQL',
      decision: 'remove',
    });
    expect(decided.newVersion).toBe(2);
    expect(decided.audit.some((r) => r.skill === 'PostgreSQL')).toBe(false);
    const v2 = await ok<View>('resume:get', { jobId, version: 2 });
    expect(v2.meta).toMatchObject({ version: 2, parentVersion: 1 });
    expect(v2.content.skills.flatMap((g) => g.skills)).not.toContain('PostgreSQL');
    expect(v2.content.change_log).toEqual(['Removed PostgreSQL (your decision)']);
    expect(v2.checks.truth).toMatchObject({ ok: true, violations: [] });
    const list = await ok<{ meta: { version: number } }[]>('resume:list', { jobId });
    expect(list.map((s) => s.meta.version)).toEqual([1, 2]);
  });

  test('learn → learning item that can be updated', async () => {
    expect(await ok('learning:list')).toEqual([]);
    await ok('skills:decide', { jobId, version: 1, skill: 'dbt', decision: 'learn' });
    const [item, ...rest] =
      await ok<{ id: string; skill: string; estHours: number; status: string }[]>('learning:list');
    expect(rest).toEqual([]);
    expect(item).toMatchObject({ skill: 'dbt', estHours: 24, status: 'todo' });
    const done = await ok<{ status: string; completedAt: string | null }>('learning:update', {
      id: item?.id,
      status: 'done',
    });
    expect(done).toMatchObject({ status: 'done', completedAt: expect.any(String) });
    const gaps = await ok<{ skill: string; learning: { status: string } | null }[]>('skills:gaps', {});
    expect(gaps.map((g) => [g.skill, g.learning?.status])).toEqual([['dbt', 'done']]);
    const ledger = await ok<{ skill: string; demand: { share: number } | null }[]>('skills:ledger');
    expect(ledger.find((r) => r.skill === 'Python')?.demand?.share).toBe(1);
  });

  test('inputs are validated and failures are readable', async () => {
    expect(await call('skills:decide', { jobId, version: 1, skill: 'x', decision: 'maybe' })).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    });
    expect(await call('skills:audit', { jobId, version: 0, requestId: randomUUID() })).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    });
    expect(await call('learning:update', { id: 'nope', priority: 9 })).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    });
    expect(
      await call('skills:decide', { jobId, version: 1, skill: 'Rust', decision: 'learn' }),
    ).toMatchObject({
      ok: false,
      error: { code: 'failed', message: expect.stringContaining('not in this audit') },
    });
  });

  test('learning:add (Learn on a gap) creates an item once and reopens a dropped one', async () => {
    const a = await ok<{ id: string; skill: string; status: string }>('learning:add', { skill: 'dbt' });
    const again = await ok<{ id: string }>('learning:add', { skill: 'dbt' });
    expect(a).toMatchObject({ skill: 'dbt', status: expect.any(String) });
    expect(again.id).toBe(a.id);
    await ok('learning:update', { id: a.id, status: 'dropped' });
    expect(await ok('learning:add', { skill: 'DBT' })).toMatchObject({ id: a.id, status: 'todo' });
    expect(await call('learning:add', { skill: '  ' })).toMatchObject({ ok: false });
  });
});

test.describe('add to profile over IPC (fake CLI)', () => {
  test('preview → profile:save → recordApproval → regenerate allows the skill', async () => {
    // The draft always names dbt; the level-1 profile row stays below min_level_to_list without an approval.
    const withDbt = {
      ...goodContent,
      skills: [{ category_label: 'Tools', skills: ['Python', 'SQL', 'dbt'] }],
    };
    const { l, jobId, call, ok } = await launch(withDbt);
    try {
      const v1 = await ok<View>('resume:generate', { jobId, requestId: randomUUID() });
      expect(v1.checks.truth?.ok).toBe(false); // dbt is not in the profile

      const before = (await ok<{ markdown: string; hash: string }>('profile:get')).markdown;
      const d = await ok<{ profilePreview: Preview }>('skills:decide', {
        jobId,
        version: 1,
        skill: 'dbt',
        decision: 'add_to_profile',
        profileRow: {
          skill: 'dbt',
          category: 'tool',
          level: 1,
          years: 0,
          last_used: 'now',
          evidence: [],
          status: 'have',
          aliases: [],
        },
      });
      expect((await ok<{ markdown: string }>('profile:get')).markdown).toBe(before); // preview wrote nothing
      expect(d.profilePreview.after).toContain('| dbt |');

      // approval before the profile holds the skill is refused
      expect(await call('skills:recordApproval', { jobId, skill: 'dbt' })).toMatchObject({
        ok: false,
        error: { code: 'failed' },
      });
      await ok('profile:save', {
        markdown: d.profilePreview.after,
        expectedHash: d.profilePreview.expectedHash,
        message: 'profile: add dbt',
      });
      expect(await ok('skills:recordApproval', { jobId, skill: 'dbt' })).toEqual({ approved: ['dbt'] });

      const v2 = await ok<View>('resume:generate', { jobId, requestId: randomUUID() });
      expect(v2.meta.version).toBe(2);
      expect(v2.checks.truth).toMatchObject({ ok: true, violations: [] });
      expect(v2.content.skills.flatMap((g) => g.skills)).toContain('dbt');
    } finally {
      await l.close();
    }
  });
});
