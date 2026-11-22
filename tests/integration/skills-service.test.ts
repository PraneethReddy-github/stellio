import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createClaudeRunner } from '../../src/main/ai/runner';
import { approvedSkillsForJob } from '../../src/main/db/repos/documents';
import { demandMap, listAuditRows, listLearningItems } from '../../src/main/db/repos/skills';
import { createDbRecorder } from '../../src/main/services/ai/recorder';
import { createDocumentsService } from '../../src/main/services/documents/service';
import { createJobsService } from '../../src/main/services/jobs/service';
import { compileTex } from '../../src/main/services/latex/compile';
import { detectEngine, type Engine } from '../../src/main/services/latex/engine';
import { createLatexService } from '../../src/main/services/latex/service';
import { createProfileService } from '../../src/main/services/profile/service';
import { createRulesService } from '../../src/main/services/rules/service';
import { createSkillsService } from '../../src/main/services/skills/service';
import { createAiSettings } from '../../src/main/services/settings/ai';
import type { Jd } from '../../src/shared/jobs/schemas';
import { sampleAnalysis, sampleJd } from '../fixtures/jobs';
import { goodContent, seedTemplate } from '../fixtures/resume';
import { freshDb, tempDir } from '../unit/db/helpers';

const FAKE = resolve('tests/fixtures/fake-claude/claude.mjs');
const BIN = process.env.STELLIO_TECTONIC_BIN || resolve('spikes/latex/bin/tectonic');
const engine: Engine | null = existsSync(BIN)
  ? await detectEngine({ override: BIN, env: { PATH: '' } })
  : null;
const canCompile = engine !== null && (await compileTex({ engine, tex: seedTemplate })).ok;
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const POSTING = `Data Engineer (m/w/d) at Nimbus Analytics GmbH in Berlin. ${'Build pipelines in Python and SQL. '.repeat(5)}`;

/** The JD asks for dbt (preferred) and Amazon Redshift (preferred) on top of Python and SQL. */
const jd: Jd = {
  ...sampleJd,
  requirements: [
    ...sampleJd.requirements,
    { text: 'dbt experience is a plus', kind: 'preferred', skills: ['dbt'] },
  ],
};
const wording = {
  rows: [
    { skill: 'PostgreSQL', rationale: 'The posting never mentions it.', learn_estimate_hours: null },
    { skill: 'Airflow', rationale: 'Not asked for; frees space.', learn_estimate_hours: 40 },
    { skill: 'dbt', rationale: 'Preferred and you do not list it.', learn_estimate_hours: 24 },
    // the model trying to change things: both are ignored
    { skill: 'Python', rationale: 'Remove it.', learn_estimate_hours: 1 },
    { skill: 'Rust', rationale: 'Learn Rust.', learn_estimate_hours: 99 },
  ],
};

async function setup(env: Record<string, string> = {}) {
  const db = freshDb();
  const dir = tempDir();
  for (const d of ['profile', 'rules', 'templates']) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, 'profile/praneethreddy.md'), readFileSync('tests/fixtures/profiles/full.md'));
  for (const f of ['rules/resume.md', 'rules/skills-policy.md', 'templates/resume.tex'])
    writeFileSync(join(dir, f), readFileSync(join('seed', f)));
  const cap = join(dir, 'capture.ndjson');
  const settings = createAiSettings(db);
  const runner = createClaudeRunner({
    bin: FAKE,
    cwd: join(dir, 'cwd'),
    logger,
    recorder: createDbRecorder(db, vi.fn()),
    retryDelayMs: 1,
    env: {
      FAKE_CLAUDE_MODE: 'ok',
      FAKE_CLAUDE_OUTPUT_JD_PARSE: JSON.stringify(jd),
      FAKE_CLAUDE_OUTPUT_JOB_ANALYZE: JSON.stringify(sampleAnalysis),
      FAKE_CLAUDE_OUTPUT_RESUME_GENERATE: JSON.stringify(goodContent),
      FAKE_CLAUDE_OUTPUT_SKILLS_AUDIT: JSON.stringify(wording),
      FAKE_CLAUDE_CAPTURE: cap,
      ...env,
    },
  });
  const profile = createProfileService({
    dataDir: dir,
    gitAvailable: false,
    runner,
    importConfig: () => settings.forTask('profile.import'),
  });
  const rules = createRulesService({ dataDir: dir, seedDir: resolve('seed'), gitAvailable: false });
  const latex = createLatexService({
    userDataDir: join(dir, 'userData'),
    dataDir: dir,
    seedDir: resolve('seed'),
    override: () => (engine ? BIN : join(dir, 'no-engine')),
  });
  const jobs = createJobsService({ db, runner, settings, profile });
  const documents = createDocumentsService({ db, runner, settings, profile, rules, latex, dataDir: dir });
  const skills = createSkillsService({ db, runner, settings, profile, rules, documents });
  const intake = await jobs.intakeText(POSTING);
  if (intake.status !== 'ok') throw new Error('intake failed');
  const jobId = intake.jobId;
  await documents.generate(jobId);
  const auditCalls = (): number =>
    existsSync(cap)
      ? readFileSync(cap, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l) as { kind: string; stdin: string })
          .filter((r) => r.kind === 'call' && r.stdin.includes('<audit_rows>')).length
      : 0;
  return {
    db,
    dir,
    jobId,
    profile,
    documents,
    skills,
    auditCalls,
    profileFile: join(dir, 'profile/praneethreddy.md'),
  };
}

describe('skills service (fake CLI)', { timeout: 60_000 }, () => {
  it('recomputes demand after intake', async () => {
    const { db } = await setup();
    expect(demandMap(db, '90d').get('python')).toMatchObject({ jobCount: 1, share: 1, requiredShare: 1 });
    expect(demandMap(db, 'all').get('dbt')).toMatchObject({ jobCount: 1, requiredShare: 0 });
  });

  it('audits a version: code-decided rows, wording from the model only, cached per version', async () => {
    const { skills, jobId, auditCalls, db } = await setup();
    const r = await skills.audit(jobId, 1);
    expect(r.aiWarning).toBeNull();
    const by = (s: string) => r.rows.find((x) => x.skill === s);
    expect(r.rows.map((x) => [x.skill, x.recommendation])).toEqual([
      ['Python', 'emphasize'],
      ['SQL', 'emphasize'],
      ['dbt', 'learn'],
      ['Airflow', 'remove'],
      ['PostgreSQL', 'remove'],
    ]);
    expect(by('PostgreSQL')).toMatchObject({
      rationale: 'The posting never mentions it.',
      learnEstimateHours: null,
    });
    expect(by('Airflow')?.learnEstimateHours).toBeNull(); // remove rows never get hours
    expect(by('dbt')).toMatchObject({ learnEstimateHours: 24, origin: 'jd_only', onResume: false });
    expect(by('Python')?.rationale).toBeNull(); // the model cannot touch rows that need no wording
    expect(by('Python')?.demand).toMatchObject({ share: 1, requiredShare: 1 });
    expect(r.rows.some((x) => x.skill === 'Rust')).toBe(false);
    expect(auditCalls()).toBe(1);
    expect(listAuditRows(db, documentId(db, jobId, 1))).toHaveLength(5);

    await skills.audit(jobId, 1); // cached
    expect(auditCalls()).toBe(1);
    await skills.audit(jobId, 1, { refresh: true });
    expect(auditCalls()).toBe(2);
    expect(db.sqlite.prepare("select related_id from ai_runs where task = 'skills.audit'").all()).toEqual([
      { related_id: jobId },
      { related_id: jobId },
    ]);
  });

  it('still returns the rows when the wording task fails', async () => {
    const { skills, jobId } = await setup({ FAKE_CLAUDE_MODE_SKILLS_AUDIT: 'nonzero_with_json' });
    const r = await skills.audit(jobId, 1);
    expect(r.aiWarning).toMatch(/boom|failed|error/i);
    expect(r.rows.find((x) => x.skill === 'PostgreSQL')).toMatchObject({
      recommendation: 'remove',
      rationale: null,
    });
  });

  it('remove stores a new version without the skill; truth stays clean; the decision is remembered', async () => {
    const { skills, jobId, documents, db } = await setup();
    await skills.audit(jobId, 1);
    const d = await skills.decide(jobId, 1, 'postgres', 'remove'); // alias spelling
    expect(d.newVersion).toBe(2);
    expect(d.audit.some((x) => x.skill === 'PostgreSQL')).toBe(false);
    const v2 = await documents.get(jobId, 2);
    expect(v2.meta).toMatchObject({ version: 2, parentVersion: 1, userEdited: false });
    expect(v2.content?.skills).toEqual([
      { category_label: 'Languages', skills: ['Python', 'SQL'] },
      { category_label: 'Data', skills: ['Airflow'] },
    ]);
    expect(v2.content?.change_log).toEqual(['Removed PostgreSQL (your decision)']);
    expect(v2.checks.truth).toEqual({ ok: true, violations: [], warnings: [] });
    expect(v2.checks.lint.ok).toBe(true);
    if (canCompile) expect(v2.checks.compile).toMatchObject({ ok: true, pages: 1 });
    expect(v2.tex).not.toContain('PostgreSQL}');
    expect(listAuditRows(db, documentId(db, jobId, 1)).find((r) => r.skill === 'PostgreSQL')?.decision).toBe(
      'removed',
    );
    // the original version is untouched
    expect((await documents.get(jobId, 1)).content).toEqual(goodContent);
  });

  it('a removed skill stays out when the resume is regenerated; keeping it later brings it back', async () => {
    const { skills, jobId, documents } = await setup();
    await skills.audit(jobId, 1);
    await skills.decide(jobId, 1, 'PostgreSQL', 'remove');
    // The fake model returns the same content as v1, which still lists PostgreSQL.
    const regenerated = await documents.generate(jobId);
    expect(regenerated.content?.skills.flatMap((g) => g.skills)).not.toContain('PostgreSQL');
    expect(regenerated.checks.truth?.ok).toBe(true);

    await skills.audit(jobId, 1);
    await skills.decide(jobId, 1, 'PostgreSQL', 'keep');
    const again = await documents.generate(jobId);
    expect(again.content?.skills.flatMap((g) => g.skills)).toContain('PostgreSQL');
  });

  it('remove drops a skill line that becomes empty', async () => {
    const { skills, jobId, documents } = await setup();
    await skills.decide(jobId, 1, 'PostgreSQL', 'remove');
    await skills.decide(jobId, 2, 'Airflow', 'remove');
    expect((await documents.get(jobId, 3)).content?.skills).toEqual([
      { category_label: 'Languages', skills: ['Python', 'SQL'] },
    ]);
  });

  it('keep stores a new version, approves the skill for this job and stays clean', async () => {
    const { skills, jobId, documents, db } = await setup();
    const d = await skills.decide(jobId, 1, 'Airflow', 'keep');
    expect(d.newVersion).toBe(2);
    expect(d.audit.find((x) => x.skill === 'Airflow')?.recommendation).toBe('keep'); // approved: no longer "remove"
    const v2 = await documents.get(jobId, 2);
    expect(v2.content?.skills).toEqual(goodContent.skills);
    expect(v2.content?.change_log).toEqual(['Kept Airflow']);
    expect(v2.checks.truth?.ok).toBe(true);
    expect(approvedSkillsForJob(db, jobId)).toEqual(['Airflow']);
  });

  it('refuses decisions on skills that are not on the resume, unknown skills and manual versions', async () => {
    const { skills, jobId, documents } = await setup();
    await expect(skills.decide(jobId, 1, 'dbt', 'remove')).rejects.toThrow(/not on this resume/);
    await expect(skills.decide(jobId, 1, 'dbt', 'keep')).rejects.toThrow(/not on this resume/);
    await expect(skills.decide(jobId, 1, 'Rust', 'learn')).rejects.toThrow(/not in this audit/);
    await expect(skills.decide(jobId, 9, 'dbt', 'learn')).rejects.toThrow(/does not exist/);
    await documents.saveManual(jobId, 1, (await documents.get(jobId, 1)).tex);
    await expect(skills.audit(jobId, 2)).rejects.toThrow(/manual edit/);
    await expect(skills.decide(jobId, 2, 'dbt', 'learn')).rejects.toThrow(/manual edit/);
  });

  it('learn upserts one learning item with priority from demand, the estimate and the linked job', async () => {
    const { skills, jobId, db } = await setup();
    await skills.audit(jobId, 1);
    const d = await skills.decide(jobId, 1, 'dbt', 'learn');
    expect(d.newVersion).toBeUndefined();
    expect(d.audit.find((x) => x.skill === 'dbt')?.decision).toBe('learning');
    const [item, ...rest] = skills.listLearning();
    expect(rest).toEqual([]);
    expect(item).toMatchObject({
      skill: 'dbt',
      priority: 5, // named by every stored job
      estHours: 24,
      status: 'todo',
      linkedJobs: 1,
      targetLevel: 3,
    });
    await skills.decide(jobId, 1, 'DBT', 'learn');
    expect(listLearningItems(db)).toHaveLength(1);
    // "I don't" on an ask_have row is the same call
    expect(skills.updateLearning(item?.id ?? '', { status: 'done' })).toMatchObject({
      status: 'done',
      completedAt: expect.any(String) as string,
    });
    expect(skills.updateLearning(item?.id ?? '', { status: 'doing', priority: 5 })).toMatchObject({
      status: 'doing',
      priority: 5,
      completedAt: null,
    });
    expect(() => skills.updateLearning('nope', { status: 'done' })).toThrow(/no longer exists/);
  });

  it('add_to_profile only previews; recordApproval needs the saved profile; then regenerate allows the skill', async () => {
    const { skills, jobId, profile, profileFile, db, documents } = await setup();
    const before = readFileSync(profileFile, 'utf8');
    const d = await skills.decide(jobId, 1, 'dbt', 'add_to_profile', {
      skill: 'dbt',
      category: 'tool',
      level: 1,
      years: 0,
      last_used: 'now',
      evidence: [],
      status: 'have',
      aliases: [],
    });
    expect(readFileSync(profileFile, 'utf8')).toBe(before); // nothing written
    expect(d.profilePreview?.before).toBe(before);
    expect(d.profilePreview?.after).toMatch(/\| dbt \| tool \| 1 \| 0 \| now \|/);
    expect(d.profilePreview?.expectedHash).toBe((await profile.get()).hash);
    expect(d.newVersion).toBeUndefined();

    await expect(skills.recordApproval(jobId, 'dbt')).rejects.toThrow(/Save dbt to your profile first/);
    expect(approvedSkillsForJob(db, jobId)).toEqual([]);

    await profile.save(d.profilePreview?.after ?? '', d.profilePreview?.expectedHash ?? null, 'add dbt');
    expect(await skills.recordApproval(jobId, 'DBT')).toEqual({ approved: ['dbt'] });
    expect(approvedSkillsForJob(db, jobId)).toEqual(['dbt']);
    const rows = listAuditRows(db, documentId(db, jobId, 1));
    expect(rows.find((r) => r.skill === 'dbt')).toMatchObject({
      decision: 'added',
      jdImportance: 'preferred',
    });
    // the level-1 skill is below min_level_to_list, so only the approval lets it through the truth check
    const content = { ...goodContent, skills: [{ category_label: 'Tools', skills: ['dbt', 'Python'] }] };
    const edited = await documents.editContent(jobId, 1, () => content, 'Added dbt');
    expect(edited.checks.truth?.ok).toBe(true);
  });

  it('add_to_profile defaults to a bare "have" row and keeps the audit spelling resolvable', async () => {
    const { skills, jobId } = await setup();
    const d = await skills.decide(jobId, 1, 'dbt', 'add_to_profile');
    expect(d.profilePreview?.after).toMatch(/\| dbt \| tool \| {2}\| {2}\| now \|/);
    const aliased = await skills.decide(jobId, 1, 'dbt', 'add_to_profile', {
      skill: 'dbt Core',
      category: 'tool',
      level: 2,
      years: 1,
      last_used: 'now',
      evidence: [],
      status: 'learning',
      aliases: [],
    });
    expect(aliased.profilePreview?.after).toMatch(
      /dbt Core \| tool \| 2 \| 1 \| now \| {2}\| learning \| dbt/,
    );
  });

  it('ledger, gaps and learning list reflect profile, demand and learning items', async () => {
    const { skills, jobId } = await setup();
    await skills.decide(jobId, 1, 'dbt', 'learn');
    const ledger = await skills.ledger();
    expect(ledger.find((r) => r.skill === 'Python')).toMatchObject({
      status: 'have',
      demand: { jobCount: 1, share: 1, requiredShare: 1 },
      learning: null,
    });
    expect(ledger.find((r) => r.skill === 'Airflow')?.demand).toBeNull();
    const gaps = await skills.gaps();
    expect(gaps.map((g) => g.skill)).toEqual(['dbt']);
    expect(gaps[0]).toMatchObject({ inProfile: null, learning: { status: 'todo' }, category: 'tool' });
    expect(await skills.gaps('30d')).toHaveLength(1);
  });
});

function documentId(db: ReturnType<typeof freshDb>, jobId: string, version: number): string {
  const row = db.sqlite
    .prepare("select id from documents where job_id = ? and kind = 'resume' and version = ?")
    .get(jobId, version) as { id: string };
  return row.id;
}
