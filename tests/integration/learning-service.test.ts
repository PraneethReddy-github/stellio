import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createClaudeRunner } from '../../src/main/ai/runner';
import { createJob, insertAnalysis } from '../../src/main/db/repos/jobs';
import { insertLearningItem, recomputeSkillDemand } from '../../src/main/db/repos/skills';
import { applications, documents } from '../../src/main/db/schema';
import { createDbRecorder } from '../../src/main/services/ai/recorder';
import { createProfileService } from '../../src/main/services/profile/service';
import { createLearningService } from '../../src/main/services/skills/learning';
import { createAiSettings } from '../../src/main/services/settings/ai';
import type { Jd } from '../../src/shared/jobs/schemas';
import { sampleJd } from '../fixtures/jobs';
import { freshDb, tempDir } from '../unit/db/helpers';

const FAKE = resolve('tests/fixtures/fake-claude/claude.mjs');
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

type Db = ReturnType<typeof freshDb>;
let n = 0;
/** An open job asking for `required` / `preferred` skills, analysed with `fit`. */
function openJob(db: Db, required: string[], preferred: string[], fit: number | null) {
  const requirements: Jd['requirements'] = [
    ...(required.length ? [{ text: 'must', kind: 'required' as const, skills: required }] : []),
    ...(preferred.length ? [{ text: 'nice', kind: 'preferred' as const, skills: preferred }] : []),
  ];
  const job = createJob(db, `Co${String(n)}`, {
    title: `Role ${String(n)}`,
    dedupeKey: `k${String(n++)}`,
    state: 'new',
    structuredJson: { ...sampleJd, requirements },
  });
  if (fit !== null)
    insertAnalysis(db, {
      jobId: job.id,
      profileHash: 'h',
      model: 'm',
      promptVersion: '1',
      fitScore: fit,
      verdict: fit >= 70 ? 'apply' : fit >= 45 ? 'stretch' : 'skip',
    });
  return job;
}

function setup(env: Record<string, string> = {}, now = new Date('2027-06-01T12:00:00Z')) {
  const db = freshDb();
  const dir = tempDir();
  mkdirSync(join(dir, 'profile'), { recursive: true });
  const profileFile = join(dir, 'profile/profile.md');
  writeFileSync(profileFile, readFileSync('tests/fixtures/profiles/full.md'));
  const cap = join(dir, 'capture.ndjson');
  const settings = createAiSettings(db);
  const runner = createClaudeRunner({
    bin: FAKE,
    cwd: join(dir, 'cwd'),
    logger,
    recorder: createDbRecorder(db, vi.fn()),
    retryDelayMs: 1,
    env: { FAKE_CLAUDE_MODE: 'ok', FAKE_CLAUDE_CAPTURE: cap, ...env },
  });
  const profile = createProfileService({
    dataDir: dir,
    gitAvailable: false,
    runner,
    importConfig: () => settings.forTask('profile.import'),
  });
  const learning = createLearningService({ db, runner, settings, profile, now: () => now });
  const calls = (): number =>
    existsSync(cap)
      ? readFileSync(cap, 'utf8')
          .split('\n')
          .filter((l) => l.includes('"kind":"call"')).length
      : 0;
  return { db, profile, profileFile, learning, calls };
}

/** Python is `have`; Kubernetes is `want`; dbt, Tableau and Terraform are not in the profile. */
function seedRoadmap(db: Db) {
  const j1 = openJob(db, ['Python', 'Kubernetes'], [], 62);
  const j2 = openJob(db, ['Python', 'dbt'], ['Tableau'], 66);
  const j3 = openJob(db, ['Kubernetes'], [], 50);
  openJob(db, ['Python'], [], 90); // nothing missing
  recomputeSkillDemand(db);
  insertLearningItem(db, 'Kubernetes', { estHours: 25, status: 'todo' });
  insertLearningItem(db, 'dbt', { estHours: 20, status: 'doing' });
  insertLearningItem(db, 'Terraform', { estHours: 10, status: 'done' });
  return { j1, j2, j3 };
}

describe('learning roadmap', () => {
  it('ranks by demand x fit-uplift / hours and counts the jobs a skill unlocks', async () => {
    const { db, learning, calls } = setup();
    const { j1, j3, j2 } = seedRoadmap(db);
    const r = await learning.roadmap();
    expect(r.openJobs).toBe(4);
    // Kubernetes: required in 2 of 4 jobs -> weight 1; uplift 1 + 2/4; 25 h -> 0.06.
    // dbt: required in 1 of 4 -> weight 0.5; uplift 1 + 1/4; 20 h -> 0.03125 -> 1 + 4 x 0.52 = 3.
    expect(r.items.map((i) => [i.skill, i.priority, i.unlocks, i.status])).toEqual([
      ['Kubernetes', 5, 2, 'todo'],
      ['dbt', 3, 1, 'doing'],
      ['Terraform', 3, 0, 'done'], // finished items keep their stored priority,
    ]);
    expect(r.items[0]?.unlockJobs.map((j) => j.jobId).sort()).toEqual([j1.id, j3.id].sort());
    expect(r.items[1]?.unlockJobs.map((j) => j.jobId)).toEqual([j2.id]);
    expect(r.items[0]?.summary).toBe(
      'Kubernetes: required in 50% of your jobs, ~25 h (estimate) to working level, unlocks 2 jobs in your inbox.',
    );
    expect(calls()).toBe(0); // the roadmap is code only
  });

  it('no learning items gives an empty roadmap', async () => {
    const { learning } = setup();
    expect(await learning.roadmap()).toEqual({ items: [], openJobs: 0 });
  });
});

describe('what-if', () => {
  it('counts the stretch jobs that would reach apply, and never calls the model', async () => {
    const { db, learning, calls } = setup();
    const { j2 } = seedRoadmap(db);
    const none = await learning.whatIf(['Kubernetes']);
    expect(none.stretchJobs).toBe(3);
    expect(none.moved).toEqual([]); // 62 + 6 = 68, 50 + 6 = 56
    const some = await learning.whatIf(['dbt', 'Tableau']);
    expect(some.moved).toMatchObject([{ jobId: j2.id, before: 66, after: 75 }]);
    expect(calls()).toBe(0);
  });
});

describe('resources', () => {
  const output = {
    resources: [
      { title: 'A blog [post]', url: 'http://insecure.test/x', kind: 'tutorial', why: 'Not https.' },
      { title: 'A course', url: 'https://example.com/course', kind: 'course', why: 'Hands on.' },
      {
        title: 'Kubernetes docs',
        url: 'https://kubernetes.io/docs/home/',
        kind: 'official_docs',
        why: 'The reference.',
      },
    ],
  };

  it('asks the model only when called, stores 2 clean links with the official docs first', async () => {
    const { db, learning, calls } = setup({ FAKE_CLAUDE_OUTPUT_LEARNING_RESOURCES: JSON.stringify(output) });
    seedRoadmap(db);
    const item = (await learning.roadmap()).items[0];
    if (!item) throw new Error('no item');
    expect(item.resourcesMd).toBeNull();
    expect(calls()).toBe(0);
    const updated = await learning.resources(item.id);
    expect(calls()).toBe(1);
    expect(updated.resourcesMd).toBe(
      '- [Kubernetes docs](https://kubernetes.io/docs/home/) (official docs): The reference.\n- [A course](https://example.com/course) (course): Hands on.',
    );
    expect((await learning.roadmap()).items[0]?.resourcesMd).toBe(updated.resourcesMd);
  });

  it('no usable link is a readable error and stores nothing', async () => {
    const bad = { resources: [{ title: 'x', url: 'javascript:alert(1)', kind: 'other', why: '' }] };
    const { db, learning } = setup({ FAKE_CLAUDE_OUTPUT_LEARNING_RESOURCES: JSON.stringify(bad) });
    seedRoadmap(db);
    const item = (await learning.roadmap()).items[0];
    await expect(learning.resources(item?.id ?? '')).rejects.toThrow(/no usable links/);
    expect((await learning.roadmap()).items[0]?.resourcesMd).toBeNull();
  });
});

describe('nudges', () => {
  it('stale skill on a resume, high-demand learning stuck in doing, profile not reviewed', async () => {
    const { db, profile, profileFile, learning } = setup();
    const md = readFileSync(profileFile, 'utf8').replace(
      '| Airflow | tool | 3 | 2 | 2025 | exp-globex | have | |',
      '| Airflow | tool | 3 | 2 | 2025 | exp-globex | have | |\n| Perl | language | 2 | 3 | 2020 | exp-globex | have | |',
    );
    writeFileSync(profileFile, md);
    const { j1 } = seedRoadmap(db);
    db.orm
      .insert(documents)
      .values({
        jobId: j1.id,
        kind: 'resume',
        version: 1,
        tex: '\\section{Skills}\n\\skillLine{Languages}{Perl, Python}',
      })
      .run();
    expect((await profile.get()).model.skills.map((s) => s.skill)).toContain('Perl');
    const kinds = (await learning.nudges()).map((x) => [x.kind, x.skill]);
    expect(kinds).toEqual([
      ['stale_skill', 'Perl'],
      ['stuck_learning', 'dbt'],
      ['profile_review', null],
    ]);
  });

  it('a fresh install has none', async () => {
    const { learning } = setup({}, new Date('2026-11-05T12:00:00Z'));
    expect(await learning.nudges()).toEqual([]);
  });
});

describe('profile.suggest', () => {
  const output = {
    summary: 'Based on the finished dbt item and your notes.',
    skill_updates: [
      {
        skill: 'dbt',
        level: 2,
        years: 0,
        last_used: '2027',
        status: 'have',
        evidence: ['exp-globex', 'exp-nope'],
        reason: 'You finished the dbt learning item.',
      },
      {
        skill: 'Rust',
        level: 3,
        years: 1,
        last_used: '2027',
        status: 'have',
        evidence: [],
        reason: 'Notes.',
      },
      {
        skill: 'Python',
        level: 5,
        years: null,
        last_used: 'now',
        status: null,
        evidence: [],
        reason: 'Notes.',
      },
      {
        skill: 'SQL',
        level: 1,
        years: null,
        last_used: null,
        status: null,
        evidence: [],
        reason: 'Invented.',
      },
    ],
  };

  it('with nothing to base it on: no model call, only the review date changes', async () => {
    const { profile, profileFile, learning, calls } = setup();
    const before = readFileSync(profileFile, 'utf8');
    const s = await learning.suggest();
    expect(calls()).toBe(0);
    expect(s.items).toEqual([]);
    expect(s.summary).toMatch(/Nothing new/);
    expect(s.after).toContain('last_reviewed: 2027-06-01');
    expect(s.expectedHash).toBe((await profile.get()).hash);
    expect(readFileSync(profileFile, 'utf8')).toBe(before);
  });

  it('applies only sourced edits, drops the rest, and never writes the file', async () => {
    const { db, profile, profileFile, learning, calls } = setup({
      FAKE_CLAUDE_OUTPUT_PROFILE_SUGGEST: JSON.stringify(output),
    });
    const { j1 } = seedRoadmap(db);
    const app = db.orm
      .insert(applications)
      .values({ jobId: j1.id, status: 'saved', notesMd: 'Led the Python migration. Tried Rust once.' })
      .returning()
      .get();
    expect(app.id).toBeTruthy();
    const dbt = (await learning.roadmap()).items.find((i) => i.skill === 'dbt');
    // dbt is a finished learning item
    db.sqlite.prepare("update learning_items set status = 'done' where id = ?").run(dbt?.id);
    const before = readFileSync(profileFile, 'utf8');

    const s = await learning.suggest();
    expect(calls()).toBe(1);
    expect(s.before).toBe(before);
    expect(readFileSync(profileFile, 'utf8')).toBe(before); // a preview, never a write
    expect(s.expectedHash).toBe((await profile.get()).hash);

    expect(s.items.map((i) => i.skill)).toEqual(['dbt', 'Python']);
    expect(s.after).toMatch(/\| dbt \| .*\| 2 \| 0 \| 2027 \| exp-globex \| have \|/);
    expect(s.after).not.toContain('exp-nope');
    expect(s.after).toMatch(/\| Python \| language \| 5 \| 5 \| now \|/);
    expect(s.after).not.toContain('Rust');
    expect(s.after).toContain('last_reviewed: 2027-06-01');
    expect(s.dropped.map((d) => [d.skill, d.why.slice(0, 14)])).toEqual([
      ['Rust', 'not in the pro'],
      ['SQL', 'no decision, f'],
    ]);
  });
});
