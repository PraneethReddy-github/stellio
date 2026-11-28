import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { extractResumeText } from '../../../src/main/ai/extract';
import { createClaudeRunner, type ClaudeRunner } from '../../../src/main/ai/runner';
import { importProfile } from '../../../src/main/ai/tasks/profileImport';
import { runResumeTask } from '../../../src/main/ai/tasks/resume';
import { sampleJd } from '../../fixtures/jobs';
import { fullProfile, goodContent } from '../../fixtures/resume';

// Opt-in: uses the real `claude` CLI and the logged-in subscription. Run with STELLIO_LIVE_AI=1.
describe.skipIf(process.env.STELLIO_LIVE_AI !== '1')('live claude', () => {
  let dir: string;
  let runner: ClaudeRunner;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'stellio-live-'));
    runner = createClaudeRunner({
      cwd: join(dir, 'ai-cwd'),
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('two revises in a row: the second reads the rules and profile from the prompt cache', async () => {
    const revise = (instruction: string) =>
      runResumeTask(runner, {
        task: 'resume.revise',
        profile: fullProfile,
        jd: sampleJd,
        descriptionMd: 'Data Engineer at Nimbus Analytics GmbH in Berlin. Build pipelines in Python and SQL.',
        analysis: null,
        resumeRules: readFileSync(resolve('seed/rules/resume.md'), 'utf8'),
        skillsPolicy: readFileSync(resolve('seed/rules/skills-policy.md'), 'utf8'),
        allowedSkills: ['Python (aliases: py)', 'SQL', 'Airflow'],
        previous: goodContent,
        instruction,
        config: { model: 'haiku', effort: 'low', timeoutMs: 180_000 },
      });
    const first = await revise('shorten the summary');
    const second = await revise('lead with Airflow');
    console.warn(
      `[live] revise tokens: first ${JSON.stringify(first.tokens)}, second ${JSON.stringify(second.tokens)}`,
    );
    expect(first.tokens?.cacheWrite).toBeGreaterThan(0);
    // the second run reuses at least what the first stored: the prompt, rules and profile
    expect(second.tokens?.cacheRead ?? 0).toBeGreaterThanOrEqual(first.tokens?.cacheWrite ?? Infinity);
  }, 400_000);

  it('haiku: tiny schema, ok and isolated from user hooks/plugins/memory', async () => {
    const schema = z.object({ answer: z.string() });
    const res = await runner.run({
      task: 'live.tiny',
      model: 'haiku',
      effort: 'low',
      systemPrompt: 'Answer briefly in plain prose.',
      input: 'Explain in two full sentences what a database index is.',
      schema,
      jsonSchema: z.toJSONSchema(schema),
      timeoutMs: 120_000,
    });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    if (!res.ok) return;
    console.warn(
      `[live] haiku ${res.durationMs} ms, cost ${res.costUsd}, tokens ${JSON.stringify(res.tokens)}`,
    );
    expect(res.data.answer.length).toBeGreaterThan(20);
    expect(res.data.answer).not.toMatch(/skipped:|risk:|caveman|ponytail|stellio/i);
    expect(res.tokens?.input ?? 0).toBeLessThan(4000); // user context would add thousands of tokens
  }, 130_000);

  it('sonnet: profile.import on the fictional .txt resume is schema-valid and invents no employers', async () => {
    const resumeText = await extractResumeText(resolve('tests/fixtures/resumes/jordan-vale.txt'));
    const res = await importProfile(runner, {
      resumeText,
      config: { model: 'sonnet', effort: 'high', timeoutMs: 300_000 },
    });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    if (!res.ok) return;
    console.warn(`[live] profile.import ${res.durationMs} ms, cost ${res.costUsd}, attempts ${res.attempts}`);
    const p = res.data;
    expect(p.front.name).toBe('Jordan Vale');
    expect(p.front.email).toBe('jordan.vale@example.com');
    const employers = p.experience.map((e) => e.title);
    expect(employers).toHaveLength(2);
    expect(employers.filter((t) => /Brightwater Analytics/.test(t))).toHaveLength(1);
    expect(employers.filter((t) => /Nimbus Logistics/.test(t))).toHaveLength(1);
    const ids = new Set(
      [...p.experience, ...p.projects, ...p.education, ...p.certifications].map((e) => e.id),
    );
    for (const s of p.skills)
      for (const ev of s.evidence) expect(ids.has(ev), `${s.skill} -> ${ev}`).toBe(true);
    expect(p.skills.map((s) => s.skill.toLowerCase())).toEqual(expect.arrayContaining(['python', 'sql']));
    expect(p.skills.every((s) => s.level <= 4 && s.status === 'have')).toBe(true);
    // no numbers invented: every digit run in the bullets must appear in the source text
    const nums = (t: string) => t.match(/\d+/g) ?? [];
    const src = new Set(nums(resumeText));
    for (const b of p.experience.flatMap((e) => e.bullets))
      for (const n of nums(b)) expect(src.has(n), b).toBe(true);
  }, 330_000);
});
