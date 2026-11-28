import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect } from 'vitest';
import type { ClaudeRunner, RunRequest, RunResult } from '../../src/main/ai/runner';
import { openDatabase } from '../../src/main/db/database';
import { migrate } from '../../src/main/db/migrate';
import { createDocumentsService } from '../../src/main/services/documents/service';
import { createJobsService } from '../../src/main/services/jobs/service';
import { createLatexService } from '../../src/main/services/latex/service';
import { createProfileService } from '../../src/main/services/profile/service';
import { createRulesService } from '../../src/main/services/rules/service';
import { createAiSettings } from '../../src/main/services/settings/ai';
import { DEFAULT_AI_SETTINGS } from '../../src/shared/settings/ai';

/** The default fixtures for resume.generate (override with --only). */
export const RESUME_JDS = [
  '01-data-engineer-berlin.md',
  '02-analytics-engineer-remote-eu.md',
  '15-data-engineer-recruiter.md',
];

export interface ResumeEvalEnv {
  runner: ClaudeRunner;
  dir: string;
  modelOverride: string;
  load: (file: string) => string;
  line: (s: string) => void;
  pct: (n: number, d: number) => string;
}

const avg = (xs: number[]): number => Math.round(xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length));

/**
 * Services over a throwaway data folder (fictional full profile, seed rules and templates) with the real CLI.
 * `runs` collects task and cost per CLI run; a repair round's issues are printed.
 */
export function evalServices(env: ResumeEvalEnv, tasks: string[]) {
  const { line } = env;
  const data = join(env.dir, 'data');
  for (const d of ['profile', 'rules', 'templates', '.stellio'])
    mkdirSync(join(data, d), { recursive: true });
  writeFileSync(join(data, 'profile/profile.md'), readFileSync(resolve('tests/fixtures/profiles/full.md')));
  for (const f of [
    'rules/resume.md',
    'rules/skills-policy.md',
    'rules/cover-letter.md',
    'rules/referral-message.md',
    'templates/resume.tex',
    'templates/cover-letter.tex',
  ])
    writeFileSync(join(data, f), readFileSync(resolve('seed', f)));
  const db = openDatabase(join(data, '.stellio/stellio.db'));
  migrate(db.sqlite);
  const settings = createAiSettings(db);
  if (env.modelOverride)
    settings.set({
      ...DEFAULT_AI_SETTINGS,
      models: {
        ...DEFAULT_AI_SETTINGS.models,
        ...Object.fromEntries(tasks.map((t) => [t, { model: env.modelOverride, effort: 'high' }])),
      },
    });
  // Cost and latency per task, from each run's envelope.
  const runs: { task: string; costUsd: number }[] = [];
  const runner: ClaudeRunner = {
    async run<T>(req: RunRequest<T>): Promise<RunResult<T>> {
      // The first draft's failed checks, verbatim, so false positives of the truth check are visible.
      const issues = /<repair_issues>\n([\s\S]*?)\n<\/repair_issues>/.exec(req.input)?.[1];
      if (issues) line(`    first draft issues sent to repair:\n${issues.replace(/^/gm, '      ')}`);
      const r = await env.runner.run(req);
      runs.push({ task: req.task, costUsd: r.costUsd ?? 0 });
      return r;
    },
    pump: () => {
      env.runner.pump();
    },
  };
  const profile = createProfileService({
    dataDir: data,
    gitAvailable: false,
    runner,
    importConfig: () => settings.forTask('profile.import'),
  });
  const rules = createRulesService({ dataDir: data, seedDir: resolve('seed'), gitAvailable: false });
  const tectonic = process.env.STELLIO_TECTONIC_BIN || resolve('spikes/latex/bin/tectonic');
  const latex = createLatexService({
    userDataDir: join(env.dir, 'userData'),
    dataDir: data,
    seedDir: resolve('seed'),
    override: () => tectonic,
  });
  const jobs = createJobsService({ db, runner, settings, profile });
  return { data, db, settings, runner, profile, rules, latex, jobs, runs };
}

/** Summed CLI cost of one task, formatted. */
export const costOf = (runs: { task: string; costUsd: number }[], task: string): string =>
  runs
    .filter((r) => r.task === task)
    .reduce((a, r) => a + r.costUsd, 0)
    .toFixed(4);

/**
 * The full B1 pipeline per job with the real CLI: jd.parse → resume.generate → checks → sandboxed compile →
 * repair round → stored version, on the fictional full profile with the seed rules and template.
 */
export async function evalResume(list: string[], env: ResumeEvalEnv): Promise<void> {
  const { line, pct } = env;
  const { data, db, settings, runner, profile, rules, latex, jobs, runs } = evalServices(env, [
    'resume.generate',
  ]);
  const docs = createDocumentsService({ db, runner, settings, profile, rules, latex, dataDir: data });
  const pageLimit = 1; // seed rules
  const outDir = process.env.EVAL_OUT_DIR || join(tmpdir(), 'stellio-eval-resume');
  mkdirSync(outDir, { recursive: true });

  line(`\nresume.generate  model=${settings.forTask('resume.generate').model}  files=${String(list.length)}`);
  let truthClean = 0;
  let compiled = 0;
  let withinLimit = 0;
  let lintErrors = 0;
  let repaired = 0;
  const ats: number[] = [];
  const lat: number[] = [];
  for (const f of list) {
    const intake = await jobs.intakeText(env.load(f));
    if (intake.status !== 'ok') {
      line(`  FAIL ${f}: intake ${intake.status}`);
      continue;
    }
    const before = runs.length;
    const t0 = Date.now();
    let v;
    try {
      v = await docs.generate(intake.jobId);
    } catch (err) {
      line(`  FAIL ${f}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    lat.push(Date.now() - t0);
    const calls = runs.slice(before).filter((r) => r.task === 'resume.generate').length;
    if (calls > 1) repaired++;
    const truth = v.checks.truth;
    if (truth?.ok) truthClean++;
    if (v.checks.compile?.ok) compiled++;
    const pages = v.checks.compile?.pages ?? null;
    if (pages !== null && pages <= pageLimit) withinLimit++;
    const errs = v.checks.lint.issues.filter((i) => i.severity === 'error').length;
    lintErrors += errs;
    ats.push(v.checks.ats.score);
    const out = join(outDir, f.replace(/\.(md|html)$/, '.tex'));
    writeFileSync(out, v.tex);
    if (v.pdfBase64) writeFileSync(out.replace(/\.tex$/, '.pdf'), Buffer.from(v.pdfBase64, 'base64'));
    line(
      `  ${f}: calls ${String(calls)}  truth ${truth?.ok ? 'ok' : `${String(truth?.violations.length)} violations`}  pages ${String(pages)}  ats ${String(v.checks.ats.score)}  lint errors ${String(errs)}  ${String(lat.at(-1))} ms`,
    );
    for (const x of truth?.violations ?? []) line(`    truth: ${x.kind} ${x.path} "${x.text}" ${x.detail}`);
    for (const x of truth?.warnings ?? []) line(`    truth warning: ${x.kind} ${x.path} "${x.text}"`);
    for (const i of v.checks.lint.issues)
      line(`    lint ${i.severity}: ${i.rule} ${i.path ?? ''} ${i.message}`);
    const missing = [...v.checks.ats.required, ...v.checks.ats.preferred].filter((h) => !h.found);
    line(
      `    ats missing: ${missing.map((h) => `${h.term}${h.youHave ? ' (you have it)' : ''}`).join(', ') || 'none'}`,
    );
    for (const c of v.content?.change_log ?? []) line(`    change: ${c}`);
    line(`    tex: ${out}`);
  }
  const cost = (t: string): string => costOf(runs, t);
  line('\nSCORECARD resume.generate');
  line(`  truth clean after repair ${pct(truthClean, list.length)}`);
  line(`  jobs needing repair      ${String(repaired)}`);
  line(`  compile ok               ${pct(compiled, list.length)}`);
  line(`  pages <= ${String(pageLimit)}               ${pct(withinLimit, list.length)}`);
  line(`  ATS score                ${ats.map(String).join(', ')} (avg ${String(avg(ats))})`);
  line(`  lint errors              ${String(lintErrors)}`);
  line(`  latency per resume       avg ${String(avg(lat))} ms, max ${String(Math.max(0, ...lat))} ms`);
  line(
    `  cost                     resume.generate $${cost('resume.generate')}, jd.parse $${cost('jd.parse')}`,
  );
  db.sqlite.close();
  expect(truthClean).toBe(list.length);
  expect(compiled).toBe(list.length);
  expect(withinLimit).toBe(list.length);
}
