import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Jd } from '../../src/shared/jobs/schemas';
import { parseProfile, profileEntryIds } from '../../src/shared/profile';
import { DEFAULT_AI_SETTINGS, taskConfig, type TaskConfig } from '../../src/shared/settings/ai';
import { createClaudeRunner, type ClaudeRunner } from '../../src/main/ai/runner';
import { parseJd } from '../../src/main/ai/tasks/jdParse';
import { analyzeJob, validateAnalysis } from '../../src/main/ai/tasks/jobAnalyze';
import { extractPage } from '../../src/main/services/jobs/html';
import { COVER_JDS, evalCover } from './cover';
import { evalInsights } from './insights';
import { evalReferrals } from './referrals';
import { evalResume, RESUME_JDS } from './resume';

const JD_DIR = resolve('tests/evals/jds');
const task = process.env.EVAL_TASK ?? '';
const limit = Number(process.env.EVAL_LIMIT) || Infinity;
const only = process.env.EVAL_ONLY ?? '';
const modelOverride = process.env.EVAL_MODEL ?? '';

interface Expected {
  title: string;
  company: string | null;
  remote: string;
  language: string;
  salary: boolean;
  deadline: string | null;
  seniority?: string;
  employment_type?: string;
  verdict?: string[];
}
const expected = JSON.parse(readFileSync(resolve('tests/evals/expected.json'), 'utf8')) as Record<
  string,
  Expected
>;

let dir: string;
let runner: ClaudeRunner;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'stellio-eval-'));
  runner = createClaudeRunner({
    cwd: join(dir, 'ai-cwd'),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    concurrency: 2,
  });
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const cfg = (t: 'jd.parse' | 'job.analyze'): TaskConfig => {
  const c = taskConfig(DEFAULT_AI_SETTINGS, t);
  return modelOverride ? { ...c, model: modelOverride } : c;
};

/** Plain text of a fixture; HTML goes through the same extraction as URL intake. */
function load(file: string): string {
  const raw = readFileSync(join(JD_DIR, file), 'utf8');
  return file.endsWith('.html') ? extractPage(raw).markdown : raw;
}
const files = (): string[] =>
  readdirSync(JD_DIR)
    .filter((f) => only === '' || only.split(',').some((s) => f.includes(s)))
    .sort()
    .slice(0, limit);

const pct = (n: number, d: number): string =>
  d === 0 ? 'n/a' : `${((100 * n) / d).toFixed(0)}% (${String(n)}/${String(d)})`;
const p = (xs: number[], q: number): number =>
  [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))] ?? 0;
const line = (s: string) => process.stdout.write(`${s}\n`);

function checkJd(jd: Jd, e: Expected): string[] {
  const bad: string[] = [];
  if (!jd.title || !jd.title.toLowerCase().includes(e.title)) bad.push(`title "${String(jd.title)}"`);
  if (e.company === null ? jd.company !== null : !jd.company?.toLowerCase().includes(e.company.toLowerCase()))
    bad.push(`company "${String(jd.company)}" (want ${String(e.company)})`);
  if (jd.location.remote !== e.remote) bad.push(`remote ${jd.location.remote} (want ${e.remote})`);
  if (jd.language !== e.language) bad.push(`language ${String(jd.language)} (want ${e.language})`);
  if (e.salary !== (jd.salary !== null && (jd.salary.min !== null || jd.salary.max !== null)))
    bad.push(`salary ${JSON.stringify(jd.salary)} (want ${e.salary ? 'a figure' : 'null'})`);
  if (jd.deadline !== e.deadline) bad.push(`deadline ${String(jd.deadline)} (want ${String(e.deadline)})`);
  if (e.seniority && jd.seniority !== e.seniority)
    bad.push(`seniority ${String(jd.seniority)} (want ${e.seniority})`);
  if (e.employment_type && jd.employment_type !== e.employment_type)
    bad.push(`employment_type ${String(jd.employment_type)} (want ${e.employment_type})`);
  if (jd.requirements.length === 0) bad.push('no requirements');
  return bad;
}

async function evalParse(list: string[]): Promise<Map<string, Jd>> {
  const out = new Map<string, Jd>();
  const lat: number[] = [];
  let valid = 0;
  let repaired = 0;
  let cost = 0;
  let checks = 0;
  let passed = 0;
  let nullChecks = 0;
  let nullOk = 0;
  const results = await Promise.all(
    list.map(async (f) => ({ f, res: await parseJd(runner, { text: load(f), config: cfg('jd.parse') }) })),
  );
  const model = cfg('jd.parse').model;
  line(`\njd.parse  model=${model}  files=${String(list.length)}`);
  for (const { f, res } of results) {
    const e = expected[f];
    if (!res.ok) {
      line(`  FAIL ${f}: ${res.status} ${res.error.slice(0, 160)}`);
      continue;
    }
    valid++;
    out.set(f, res.data);
    if (res.attempts > 1) repaired++;
    lat.push(res.durationMs);
    cost += res.costUsd ?? 0;
    if (!e) continue;
    const bad = checkJd(res.data, e);
    const n = 8 + (e.seniority ? 1 : 0) + (e.employment_type ? 1 : 0);
    checks += n;
    passed += n - bad.length;
    // fields the posting does not state must come back null
    const nulls = [e.company === null, !e.salary, e.deadline === null];
    nullChecks += nulls.filter(Boolean).length;
    nullOk += [
      e.company === null && res.data.company === null,
      !e.salary &&
        (res.data.salary === null || (res.data.salary.min === null && res.data.salary.max === null)),
      e.deadline === null && res.data.deadline === null,
    ].filter(Boolean).length;
    line(
      `  ${bad.length === 0 ? 'ok  ' : 'diff'} ${f}  ${String(res.durationMs)} ms${bad.length ? `  -> ${bad.join('; ')}` : ''}`,
    );
  }
  line('\nSCORECARD jd.parse');
  line(`  schema-valid        ${pct(valid, list.length)}  (repair retries: ${String(repaired)})`);
  line(`  field checks        ${pct(passed, checks)}`);
  line(`  nulls where expected ${pct(nullOk, nullChecks)}`);
  line(
    `  latency             avg ${String(Math.round(lat.reduce((a, b) => a + b, 0) / Math.max(1, lat.length)))} ms, p95 ${String(p(lat, 0.95))} ms`,
  );
  line(`  cost                $${cost.toFixed(4)}`);
  expect(valid).toBe(list.length);
  return out;
}

async function evalAnalyze(list: string[]): Promise<void> {
  const profile = parseProfile(readFileSync(resolve('tests/fixtures/profiles/full.md'), 'utf8')).model;
  const ids = profileEntryIds(profile);
  const jds = await evalParseQuiet(list);
  const model = cfg('job.analyze').model;
  line(`\njob.analyze  model=${model}  files=${String(list.length)}`);
  let valid = 0;
  let cited = 0;
  let citedOk = 0;
  let verdictChecks = 0;
  let verdictOk = 0;
  let warnings = 0;
  let cost = 0;
  const lat: number[] = [];
  for (const f of list) {
    const res = await analyzeJob(runner, {
      profile,
      jd: jds.get(f) ?? null,
      descriptionMd: load(f),
      config: cfg('job.analyze'),
    });
    if (!res.ok) {
      line(`  FAIL ${f}: ${res.status} ${res.error.slice(0, 160)}`);
      continue;
    }
    valid++;
    lat.push(res.durationMs);
    cost += res.costUsd ?? 0;
    const raw = res.data.matched.flatMap((m) => m.evidence_ids);
    cited += raw.length;
    citedOk += raw.filter((i) => ids.has(i)).length;
    const checked = validateAnalysis(res.data, ids);
    warnings += checked.warnings.length;
    const want = expected[f]?.verdict;
    if (want) {
      verdictChecks++;
      if (want.includes(res.data.verdict)) verdictOk++;
    }
    line(
      `  ${f}: score ${String(res.data.fit_score)} ${res.data.verdict}  matched ${String(res.data.matched.length)}  missing ${String(res.data.missing_skills.length)}  flags ${String(res.data.red_flags.length)}  ${String(res.durationMs)} ms`,
    );
    line(`    summary: ${res.data.summary}`);
    for (const w of checked.warnings) line(`    warning: ${w}`);
  }
  line('\nSCORECARD job.analyze');
  line(`  schema-valid        ${pct(valid, list.length)}`);
  line(`  evidence ids valid  ${pct(citedOk, cited)}`);
  line(`  verdict as expected ${pct(verdictOk, verdictChecks)}`);
  line(`  warnings recorded   ${String(warnings)}`);
  line(
    `  latency             avg ${String(Math.round(lat.reduce((a, b) => a + b, 0) / Math.max(1, lat.length)))} ms`,
  );
  line(`  cost                $${cost.toFixed(4)}`);
  expect(valid).toBe(list.length);
}

/** jd.parse for the analyze eval, without a scorecard of its own. */
async function evalParseQuiet(list: string[]): Promise<Map<string, Jd>> {
  const out = new Map<string, Jd>();
  for (const f of list) {
    const res = await parseJd(runner, { text: load(f), config: taskConfig(DEFAULT_AI_SETTINGS, 'jd.parse') });
    if (res.ok) out.set(f, res.data);
  }
  return out;
}

it(`eval ${task}`, async () => {
  const defaults: Record<string, string[]> = {
    'resume.generate': RESUME_JDS,
    'cover.generate': COVER_JDS,
    referrals: ['-'],
    insights: ['-'],
  };
  const list = only === '' && defaults[task] ? (defaults[task] ?? []).slice(0, limit) : files();
  expect(list.length, 'no fixtures matched').toBeGreaterThan(0);
  if (task === 'jd.parse') await evalParse(list);
  else if (task === 'job.analyze') await evalAnalyze(list);
  else if (task === 'resume.generate')
    await evalResume(list, { runner, dir, modelOverride, load, line, pct });
  else if (task === 'cover.generate') await evalCover(list, { runner, dir, modelOverride, load, line, pct });
  else if (task === 'referrals') await evalReferrals({ runner, dir, modelOverride, load, line, pct });
  else if (task === 'insights') await evalInsights({ runner, dir, modelOverride, load, line, pct });
  else throw new Error(`unknown EVAL_TASK "${task}"`);
});
