import { existsSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import { createClaudeRunner } from '../../src/main/ai/runner';
import { createDbRecorder } from '../../src/main/services/ai/recorder';
import { lastPageNearlyFull } from '../../src/main/services/documents/pagefill';
import {
  createDocumentsService,
  exportFileName,
  noWorse,
  sweepOverleafForms,
} from '../../src/main/services/documents/service';
import { createJobsService } from '../../src/main/services/jobs/service';
import { compileTex } from '../../src/main/services/latex/compile';
import { detectEngine, type Engine } from '../../src/main/services/latex/engine';
import { createLatexService } from '../../src/main/services/latex/service';
import { createProfileService } from '../../src/main/services/profile/service';
import { createRulesService } from '../../src/main/services/rules/service';
import { createAiSettings } from '../../src/main/services/settings/ai';
import { renderResume, resumeTexts, type ResumeContent } from '../../src/shared/documents';
import { sampleAnalysis, sampleJd } from '../fixtures/jobs';
import {
  airflowBullet,
  arbContent,
  fullProfile,
  goodContent,
  seedPolicy,
  seedRules,
  seedTemplate,
} from '../fixtures/resume';
import { freshDb, tempDir } from '../unit/db/helpers';

const FAKE = resolve('tests/fixtures/fake-claude/claude.mjs');
const BIN = process.env.STELLIO_TECTONIC_BIN || resolve('spikes/latex/bin/tectonic');
const engine: Engine | null = existsSync(BIN)
  ? await detectEngine({ override: BIN, env: { PATH: '' } })
  : null;
const canCompile = engine !== null && (await compileTex({ engine, tex: seedTemplate })).ok;
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const POSTING = `Data Engineer (m/w/d) at Nimbus Analytics GmbH in Berlin. ${'Build pipelines in Python and SQL. '.repeat(5)}`;

const badContent: ResumeContent = {
  ...goodContent,
  experience: [
    {
      entry_id: 'exp-globex',
      bullets: [
        {
          text: 'Cut nightly report runtime by 85% by rewriting the SQL pipelines in PostgreSQL.',
          source_ids: [],
        },
        airflowBullet,
      ],
    },
  ],
};

/** A faithful German translation of `goodContent`'s texts, as the fake CLI returns it. */
const GERMAN: Record<string, string> = {
  summary:
    'Data Engineer mit fünf Jahren Erfahrung im Aufbau von Batch-Pipelines in Python, SQL und Airflow.',
  'experience[0].bullets[0]':
    'Wöchentliche Dashboards für das Finanzteam gebaut, die rohe Buchungsdaten in SQL-Berichte verwandeln.',
  'experience[1].bullets[0]':
    'Laufzeit der nächtlichen Berichte von 2 h auf 10 min gesenkt, durch neu geschriebene SQL-Pipelines in PostgreSQL.',
  'experience[1].bullets[1]':
    'Verantwortlich für das Airflow-Deployment von 6 Teams; nächtliche Pipelines liefen planmäßig.',
  'projects[0].bullets[0]':
    'Persönlichen Finanz-Tracker in Python und Docker gebaut, der CSV-Dateien von Banken importiert.',
};
const translation = (over: Record<string, string> = {}) =>
  JSON.stringify({
    items: resumeTexts(goodContent).map((i) => ({
      key: i.key,
      text: over[i.key] ?? GERMAN[i.key] ?? i.text,
    })),
  });

async function setup(env: Record<string, string> = {}, opts: { photo?: boolean } = {}) {
  const db = freshDb();
  const dir = tempDir();
  for (const d of ['profile', 'rules', 'templates']) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, 'profile/profile.md'), readFileSync('tests/fixtures/profiles/full.md'));
  for (const f of [
    'rules/resume.md',
    'rules/skills-policy.md',
    'rules/cover-letter.md',
    'templates/resume.tex',
  ])
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
      FAKE_CLAUDE_OUTPUT_JD_PARSE: JSON.stringify(sampleJd),
      FAKE_CLAUDE_OUTPUT_JOB_ANALYZE: JSON.stringify(sampleAnalysis),
      FAKE_CLAUDE_OUTPUT_RESUME_GENERATE: JSON.stringify(goodContent),
      FAKE_CLAUDE_OUTPUT_RESUME_REVISE: JSON.stringify({
        ...goodContent,
        projects: [],
        change_log: ['Dropped Ledger'],
      }),
      FAKE_CLAUDE_OUTPUT_RESUME_TRANSLATE: translation(),
      FAKE_CLAUDE_CAPTURE: cap,
      ...env,
    },
  });
  const photoFile = join(dir, 'templates/photo.jpg');
  if (opts.photo) writeFileSync(photoFile, readFileSync('tests/fixtures/latex/photo.jpg'));
  const photo = { read: () => Promise.resolve(existsSync(photoFile) ? readFileSync(photoFile) : null) };
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
    photo: photo.read,
  });
  const jobs = createJobsService({ db, runner, settings, profile });
  const docs = createDocumentsService({ db, runner, settings, profile, rules, latex, dataDir: dir, photo });
  const intake = await jobs.intakeText(POSTING);
  if (intake.status !== 'ok') throw new Error('intake failed');
  await jobs.analyze(intake.jobId);
  const calls = (): { argv: string[]; system: string; stdin: string }[] =>
    readFileSync(cap, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { kind: string; argv: string[]; system: string; stdin: string })
      .filter((r) => r.kind === 'call');
  const resumeCalls = () => calls().filter((c) => c.system.includes('<resume_rules>'));
  const translateCalls = () => calls().filter((c) => c.stdin.includes('<texts>'));
  return { db, dir, docs, jobId: intake.jobId, calls: resumeCalls, translateCalls };
}

describe('resume pipeline (fake CLI)', { timeout: 60_000 }, () => {
  it('refuses a profile that still holds the seed example entries', async () => {
    const { docs, jobId, dir, calls } = await setup();
    const file = join(dir, 'profile/profile.md');
    const md = readFileSync(file, 'utf8').replace(
      '## Awards',
      '### Project Name {#proj-example}\n- x\n\n## Awards',
    );
    writeFileSync(file, md);
    await expect(docs.generate(jobId)).rejects.toThrow(/example entry "Project Name"/);
    expect(calls()).toHaveLength(0);
  });

  it('generate → checks → compile → stored as version 1', async () => {
    const { docs, jobId, calls, db, dir } = await setup();
    const stages: string[] = [];
    const v = await docs.generate(jobId, { onStage: (s) => stages.push(s) });
    expect(v.meta).toMatchObject({ version: 1, parentVersion: null, userEdited: false, isFinal: false });
    expect(v.meta.promptVersion).toBe('resume.generate@v2');
    expect(v.checks.truth).toEqual({ ok: true, violations: [], warnings: [] });
    expect(v.checks.lint.ok).toBe(true);
    expect(v.content).toEqual(goodContent);
    expect(v.tex).toContain('{Globex}');
    expect(stages).toEqual(['drafting', 'checking', 'compiling']);
    if (canCompile) {
      expect(v.checks.compile).toMatchObject({ ok: true, pages: 1 });
      expect(v.pdfBase64).toBeDefined();
      expect(v.checks.ats.format.find((f) => f.check === 'selectable_text')?.ok).toBe(true);
      expect(existsSync(join(dir, '.stellio/documents'))).toBe(true);
    }
    // one call; the prompt embeds the rules files verbatim and the data blocks
    const [call] = calls();
    expect(calls()).toHaveLength(1);
    expect(call?.system).toContain(readFileSync('seed/rules/resume.md', 'utf8'));
    expect(call?.system).toContain('USER RULES — follow exactly');
    expect(call?.system).toMatch(/<allowed_skills>\nPython \(aliases: py, python3\)/);
    expect(call?.system).not.toMatch(/<allowed_skills>[\s\S]*Kubernetes[\s\S]*<\/allowed_skills>/);
    expect(call?.stdin).toContain('<fit_analysis>');
    // the user's own material sits in the system prompt (cached across revises); web text never does
    expect(call?.system).toContain('<profile>');
    expect(call?.stdin).not.toContain('<profile>');
    expect(call?.stdin).toContain('<job_description>');
    expect(call?.system).not.toContain('</job_description>');
    expect(call?.system).not.toContain('</job_structured>');
    expect(call?.system).toContain('[exp-globex]');
    const argv = call?.argv ?? [];
    expect(argv[argv.indexOf('--model') + 1]).toBe('claude-sonnet-5-5');
    expect(argv[argv.indexOf('--effort') + 1]).toBe('high');
    expect(db.sqlite.prepare("select related_id from ai_runs where task = 'resume.generate'").all()).toEqual([
      { related_id: jobId },
    ]);
    const list = await docs.list(jobId);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ truthOk: true, truthViolations: 0, lintErrors: 0, stale: false });
  });

  it('a truth violation triggers one repair round with the exact issues, then stores the clean draft', async () => {
    const { docs, jobId, calls } = await setup({
      FAKE_CLAUDE_OUTPUT_RESUME_GENERATE: JSON.stringify(badContent),
      FAKE_CLAUDE_OUTPUT_RESUME_GENERATE_REPAIR: JSON.stringify(goodContent),
    });
    const stages: string[] = [];
    const v = await docs.generate(jobId, { onStage: (s, n) => stages.push(n ? `${s}:${String(n)}` : s) });
    expect(calls()).toHaveLength(2);
    const repair = calls()[1]?.stdin ?? '';
    expect(repair).toMatch(
      /<repair_issues>\n- Truth \(number_not_in_source\) at experience\[0\]\.bullets\[0\].*85/,
    );
    expect(repair).toContain('<previous_draft>');
    expect(stages).toContain('fixing:1');
    expect(v.checks.truth?.ok).toBe(true);
    expect(v.content).toEqual(goodContent);
  });

  it('the repair never wins with more truth violations, even when it fixes the lint errors', async () => {
    const lintBad: ResumeContent = {
      ...goodContent,
      experience: [
        goodContent.experience[0] ?? { entry_id: 'exp-initrode', bullets: [] },
        {
          entry_id: 'exp-globex',
          bullets: [{ text: `${airflowBullet.text} ${'Kept it running well. '.repeat(8)}`, source_ids: [] }],
        },
      ],
    };
    const { docs, jobId, calls } = await setup({
      FAKE_CLAUDE_OUTPUT_RESUME_GENERATE: JSON.stringify(lintBad),
      FAKE_CLAUDE_OUTPUT_RESUME_GENERATE_REPAIR: JSON.stringify(badContent),
    });
    const v = await docs.generate(jobId);
    expect(calls()).toHaveLength(2);
    // the repair prompt names the entry by id and content position
    expect(calls()[1]?.stdin).toMatch(
      /at experience\[1\]\.bullets\[0\]: exp-globex \("Data Engineer — Globex"\)/,
    );
    expect(v.checks.truth?.ok).toBe(true);
    expect(v.content).toEqual(lintBad);
    expect(noWorse([0, 3], [1, 0])).toBe(true);
    expect(noWorse([1, 0], [0, 3])).toBe(false);
    expect(noWorse([0, 1], [0, 1])).toBe(true);
  });

  it('a draft still failing after the repair is stored with its violations (never silently clean)', async () => {
    const { docs, jobId, calls } = await setup({
      FAKE_CLAUDE_OUTPUT_RESUME_GENERATE: JSON.stringify(badContent),
    });
    const v = await docs.generate(jobId);
    expect(calls()).toHaveLength(2);
    expect(v.checks.truth?.ok).toBe(false);
    expect((await docs.list(jobId))[0]).toMatchObject({ truthOk: false, truthViolations: 1 });
  });

  it('revise, manual edit, mark final, diff, stale', async () => {
    const { docs, jobId, calls, dir } = await setup();
    await docs.generate(jobId);
    const v2 = await docs.revise(jobId, 1, 'drop the Ledger project');
    expect(v2.meta).toMatchObject({ version: 2, parentVersion: 1, instruction: 'drop the Ledger project' });
    expect(v2.tex).not.toContain('\\section{Projects}');
    expect(calls()[1]?.stdin).toContain('<user_instruction>\ndrop the Ledger project\n</user_instruction>');
    expect(calls()[1]?.argv.join(' ')).toContain('You revise');

    const manual = v2.tex.replace('Owned the Airflow', 'Ran the Airflow');
    const v3 = await docs.saveManual(jobId, 2, manual);
    expect(v3.meta).toMatchObject({ version: 3, parentVersion: 2, userEdited: true, model: null });
    expect(v3.checks.truth).toBeNull();
    expect(v3.content).toBeNull();
    expect(v3.checks.lint.ok).toBe(true);
    await expect(docs.revise(jobId, 3, 'shorter')).rejects.toThrow(/manual edit/);

    if (canCompile) {
      const evil = await docs.saveManual(
        jobId,
        3,
        manual.replace('\\begin{document}', '\\begin{document}\\input{/etc/passwd}'),
      );
      expect(evil.checks.compile?.ok).toBe(false);
      expect(evil.checks.compile?.errors[0]?.message).toMatch(/can't read or write files/);
      // an edit that needs a file the offline cache lacks says so, so the Resume tab can offer the download
      const needs = await docs.saveManual(
        jobId,
        3,
        manual.replace('\\begin{document}', '\\usepackage{stellio-not-cached}\n\\begin{document}'),
      );
      expect(needs.checks.compile).toMatchObject({ ok: false, cacheMissing: true });
      expect(needs.checks.compile?.errors[0]?.message).toContain('stellio-not-cached.sty');
    }

    await docs.markFinal(jobId, 2);
    const list = await docs.markFinal(jobId, 3);
    expect(list.filter((s) => s.meta.isFinal).map((s) => s.meta.version)).toEqual([3]);
    await expect(docs.markFinal(jobId, 99)).rejects.toThrow(/does not exist/);

    // a rules edit makes every version stale
    writeFileSync(
      join(dir, 'rules/resume.md'),
      readFileSync('seed/rules/resume.md', 'utf8').replace('max_words: 50', 'max_words: 40'),
    );
    expect((await docs.list(jobId)).every((s) => s.stale)).toBe(true);
  });

  it('German version: translates only the texts, keeps ids and skills, renders German, passes its checks', async () => {
    const { docs, jobId, translateCalls } = await setup();
    await docs.generate(jobId);
    const stages: string[] = [];
    const de = await docs.translate(jobId, 1, { onStage: (s) => stages.push(s) });
    expect(de.meta).toMatchObject({ version: 2, parentVersion: 1, language: 'de', userEdited: false });
    expect(de.meta.promptVersion).toBe('resume.translate@v1');
    expect(de.checks.truth).toEqual({ ok: true, violations: [], warnings: [] });
    expect(de.content?.summary).toBe(GERMAN.summary);
    expect(de.content?.experience.map((e) => e.entry_id)).toEqual(
      goodContent.experience.map((e) => e.entry_id),
    );
    expect(de.content?.skills).toEqual(goodContent.skills);
    expect(de.tex).toContain('\\section{Berufserfahrung}');
    expect(de.tex).toContain('{Mär 2022 -- heute}');
    expect(stages).toEqual(['drafting', 'checking', 'compiling']);
    expect(de.checks.lint.issues.filter((i) => i.severity === 'error')).toEqual([]);
    if (canCompile) expect(de.checks.compile?.ok).toBe(true);
    const [call] = translateCalls();
    expect(call?.stdin).toContain('"key": "experience[1].bullets[0]"');
    expect(call?.stdin).toContain('Data Engineer at Nimbus Analytics GmbH');
    expect((await docs.list(jobId)).map((s) => s.meta.language)).toEqual(['en', 'de']);

    await expect(docs.translate(jobId, 2)).rejects.toThrow(/already German/);
    await expect(docs.revise(jobId, 2, 'shorter')).rejects.toThrow(/German version/);
    const manual = await docs.saveManual(jobId, 2, de.tex.replace('Laufzeit', 'Die Laufzeit'));
    expect(manual.meta.language).toBe('de');
    await expect(docs.translate(jobId, 3)).rejects.toThrow(/manual edit/);
  });

  it('German version: an invented number or term is a violation and gets one repair round', async () => {
    const { docs, jobId, translateCalls } = await setup({
      FAKE_CLAUDE_OUTPUT_RESUME_TRANSLATE: translation({
        'experience[1].bullets[1]': 'Verantwortlich für das Airflow-Deployment von 9 Teams auf Kubernetes.',
      }),
      FAKE_CLAUDE_OUTPUT_RESUME_TRANSLATE_REPAIR: translation(),
    });
    await docs.generate(jobId);
    const de = await docs.translate(jobId, 1);
    const [first, repair] = translateCalls();
    expect(first).toBeDefined();
    expect(repair?.stdin).toContain('<repair_issues>');
    expect(repair?.stdin).toMatch(/number_not_in_source\) at experience\[1\]\.bullets\[1\]: "9"/);
    expect(repair?.stdin).toContain('<previous_translation>');
    expect(de.checks.truth?.ok).toBe(true);
    expect(de.content?.experience[1]?.bullets[1]?.text).toBe(GERMAN['experience[1].bullets[1]']);
  });

  it('photo: on in the header when set, compiled from the work dir, left out for Overleaf', async () => {
    const { docs, jobId } = await setup({}, { photo: true });
    const v = await docs.generate(jobId);
    expect(v.tex).toMatch(/^\\resumephototrue$/m);
    if (canCompile) {
      expect(v.checks.compile).toMatchObject({ ok: true });
      expect(v.checks.ats.format.find((f) => f.check === 'no_images')?.ok).toBe(false);
    }
    const open = vi.fn(() => Promise.resolve());
    const { url } = await docs.openOverleaf(jobId, 1, open);
    const html = readFileSync(fileURLToPath(url), 'utf8');
    expect(html).toContain(encodeURIComponent('\\resumephotofalse\n\\resumeHeader'));
    expect(html).not.toContain(encodeURIComponent('\\resumephototrue\n'));
    docs.dispose();
  });

  it('a version made with the photo still compiles after the photo is removed (review finding)', async () => {
    const { docs, jobId, dir } = await setup({}, { photo: true });
    await docs.generate(jobId);
    rmSync(join(dir, 'templates/photo.jpg'));
    if (canCompile) expect((await docs.compile(jobId, 1)).checks.compile?.ok).toBe(true);
  });

  it('export writes the tex (and the PDF) to the picked path; cancel writes nothing', async () => {
    const { docs, jobId, dir } = await setup();
    await docs.generate(jobId);
    const pick = vi.fn((name: string, ext: string) => Promise.resolve(join(dir, `${name}.${ext}`)));
    const res = await docs.export(jobId, 1, 'tex', pick);
    expect(pick).toHaveBeenCalledWith('Alex_Example_Resume_Nimbus_Analytics_GmbH', 'tex');
    expect(res).toEqual({
      status: 'saved',
      path: join(dir, 'Alex_Example_Resume_Nimbus_Analytics_GmbH.tex'),
    });
    expect(readFileSync(join(dir, 'Alex_Example_Resume_Nimbus_Analytics_GmbH.tex'), 'utf8')).toContain(
      '{Globex}',
    );
    expect(await docs.export(jobId, 1, 'tex', () => Promise.resolve(null))).toEqual({ status: 'cancelled' });
    if (canCompile) {
      await docs.export(jobId, 1, 'pdf', pick);
      expect(
        readFileSync(join(dir, 'Alex_Example_Resume_Nimbus_Analytics_GmbH.pdf')).subarray(0, 5).toString(),
      ).toBe('%PDF-');
    }
  });

  it('openOverleaf writes a private auto-submit form and opens it', async () => {
    const { docs, jobId } = await setup();
    const v = await docs.generate(jobId);
    const open = vi.fn(() => Promise.resolve());
    const { url } = await docs.openOverleaf(jobId, 1, open);
    expect(open).toHaveBeenCalledWith(url);
    const file = fileURLToPath(url);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(file, '..')).mode & 0o777).toBe(0o700);
    const html = readFileSync(file, 'utf8');
    expect(html).toContain('action="https://www.overleaf.com/docs"');
    expect(html).toContain(`name="encoded_snip" value="${encodeURIComponent(v.tex)}"`);
    expect(html).toContain('name="engine" value="pdflatex"');
    // quitting before the 60 s timer deletes the form
    docs.dispose();
    expect(existsSync(join(file, '..'))).toBe(false);
  });

  it('the startup sweep removes old stellio-overleaf-* dirs only', async () => {
    const root = tempDir();
    for (const d of ['stellio-overleaf-old', 'stellio-overleaf-new', 'other-old']) mkdirSync(join(root, d));
    const old = new Date(Date.now() - 120_000);
    for (const d of ['stellio-overleaf-old', 'other-old']) utimesSync(join(root, d), old, old);
    expect(await sweepOverleafForms(root)).toBe(1);
    expect(existsSync(join(root, 'stellio-overleaf-old'))).toBe(false);
    expect(existsSync(join(root, 'stellio-overleaf-new'))).toBe(true);
    expect(existsSync(join(root, 'other-old'))).toBe(true);
  });
});

describe('exportFileName', () => {
  it('builds Firstname_Lastname_Resume_<Company>', () => {
    expect(exportFileName('Zoë  van-Dijk', 'ACME, Inc.')).toBe('Zoë_van_Dijk_Resume_ACME_Inc');
    expect(exportFileName('', '')).toBe('Resume');
  });
});

describe.skipIf(!canCompile)('Overleaf slack: last page nearly full (tectonic)', { timeout: 120_000 }, () => {
  it('a short page is not nearly full; the longest one-page version is', async () => {
    const pdfOf = async (n: number) => {
      const bullets = Array.from({ length: n }, () => airflowBullet);
      const c = { ...goodContent, experience: [{ entry_id: 'exp-globex', bullets }] };
      const r = await compileTex({
        engine: engine as Engine,
        tex: renderResume(c, fullProfile, seedTemplate, seedRules, seedPolicy),
      });
      return { pages: r.pages, pdf: r.pdf ?? Buffer.alloc(0) };
    };
    const short = await pdfOf(1);
    expect(short.pages).toBe(1);
    expect(await lastPageNearlyFull(short.pdf)).toBe(false);
    // binary search the most bullets that still fit on one page
    let lo = 1;
    let hi = 80;
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if ((await pdfOf(mid)).pages === 1) lo = mid;
      else hi = mid;
    }
    expect(await lastPageNearlyFull((await pdfOf(lo)).pdf)).toBe(true);
  });
});

describe.skipIf(!canCompile)('render always compiles (tectonic)', { timeout: 120_000 }, () => {
  it('arbitrary content compiles without errors', async () => {
    const samples = fc.sample(arbContent, { numRuns: 6, seed: 42 });
    for (const c of [goodContent, ...samples]) {
      const tex = renderResume(c, fullProfile, seedTemplate, seedRules, seedPolicy);
      const r = await compileTex({ engine: engine as Engine, tex });
      expect(r.errors).toEqual([]);
      expect(r.ok).toBe(true);
    }
  });
});
