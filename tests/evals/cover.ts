import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'vitest';
import { createCoverService } from '../../src/main/services/documents/cover';
import { readCover } from '../../src/shared/documents';
import { lintRules } from '../../src/shared/rules';
import { costOf, evalServices, type ResumeEvalEnv } from './resume';

/** The default fixtures for cover.generate (override with --only). */
export const COVER_JDS = ['01-data-engineer-berlin.md', '02-analytics-engineer-remote-eu.md'];

const avg = (xs: number[]): number => Math.round(xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length));

/**
 * The C1 pipeline per job with the real CLI: jd.parse → cover.generate → truth/lint → sandboxed compile →
 * repair round → stored version, on the fictional full profile with the seed rules and template.
 */
export async function evalCover(list: string[], env: ResumeEvalEnv): Promise<void> {
  const { line, pct } = env;
  const { data, db, settings, runner, profile, rules, latex, jobs, runs } = evalServices(env, [
    'cover.generate',
  ]);
  const cover = createCoverService({ db, runner, settings, profile, rules, latex, dataDir: data });
  const cfg = lintRules('cover-letter', (await rules.get('rules/cover-letter.md')).content).config;
  if (!cfg) throw new Error('seed cover-letter rules are invalid');
  const outDir = process.env.EVAL_OUT_DIR || join(tmpdir(), 'stellio-eval-cover');
  mkdirSync(outDir, { recursive: true });

  line(`\ncover.generate  model=${settings.forTask('cover.generate').model}  files=${String(list.length)}`);
  let truthClean = 0;
  let wordsOk = 0;
  let bannedFree = 0;
  let onePage = 0;
  let repaired = 0;
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
      v = await cover.generate(intake.jobId);
    } catch (err) {
      line(`  FAIL ${f}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    lat.push(Date.now() - t0);
    const calls = runs.slice(before).filter((r) => r.task === 'cover.generate').length;
    if (calls > 1) repaired++;
    const truth = v.checks.truth;
    if (truth?.ok) truthClean++;
    const doc = readCover(v.tex);
    const inRange = doc.words >= cfg.words.min && doc.words <= cfg.words.max;
    if (inRange) wordsOk++;
    // independent of the lint: scan the printed text for every banned phrase
    const text = doc.paragraphs.join(' ').toLowerCase().replace(/’/g, "'");
    const banned = cfg.banned_phrases.filter((b) => text.includes(b.toLowerCase().replace(/’/g, "'")));
    if (banned.length === 0) bannedFree++;
    const pages = v.checks.compile?.pages ?? null;
    if (pages === 1) onePage++;
    const out = join(outDir, f.replace(/\.(md|html)$/, '.tex'));
    writeFileSync(out, v.tex);
    if (v.pdfBase64) writeFileSync(out.replace(/\.tex$/, '.pdf'), Buffer.from(v.pdfBase64, 'base64'));
    line(
      `  ${f}: calls ${String(calls)}  truth ${truth?.ok ? 'ok' : `${String(truth?.violations.length)} violations`}  words ${String(doc.words)} (${inRange ? 'ok' : 'OUT'})  paragraphs ${String(doc.paragraphs.length)}  banned ${banned.join(', ') || 'none'}  pages ${String(pages)}  lint issues ${String(v.checks.lint.issues.length)}  ${String(lat.at(-1))} ms`,
    );
    for (const x of truth?.violations ?? []) line(`    truth: ${x.kind} ${x.path} "${x.text}" ${x.detail}`);
    for (const x of truth?.warnings ?? []) line(`    truth warning: ${x.kind} ${x.path} "${x.text}"`);
    for (const i of v.checks.lint.issues) line(`    lint: ${i.rule} ${i.path ?? ''} ${i.message}`);
    line(`    salutation: ${doc.salutation ?? '(none)'}`);
    doc.paragraphs.forEach((p, i) => {
      line(`    [${String(i + 1)}] ${p}`);
    });
    line(`    tex: ${out}`);
  }
  line('\nSCORECARD cover.generate');
  line(`  truth clean after repair ${pct(truthClean, list.length)}`);
  line(`  jobs needing repair      ${String(repaired)}`);
  line(`  words in range           ${pct(wordsOk, list.length)}`);
  line(`  no banned phrases        ${pct(bannedFree, list.length)}`);
  line(`  1 page                   ${pct(onePage, list.length)}`);
  line(`  latency per letter       avg ${String(avg(lat))} ms, max ${String(Math.max(0, ...lat))} ms`);
  line(
    `  cost                     cover.generate $${costOf(runs, 'cover.generate')}, jd.parse $${costOf(runs, 'jd.parse')}`,
  );
  db.sqlite.close();
  expect(truthClean).toBe(list.length);
  expect(wordsOk).toBe(list.length);
  expect(bannedFree).toBe(list.length);
  expect(onePage).toBe(list.length);
}
