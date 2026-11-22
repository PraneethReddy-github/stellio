import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { createClaudeRunner } from '../../src/main/ai/runner';
import { createDbRecorder } from '../../src/main/services/ai/recorder';
import { createCoverService } from '../../src/main/services/documents/cover';
import { createJobsService } from '../../src/main/services/jobs/service';
import { compileTex } from '../../src/main/services/latex/compile';
import { detectEngine, type Engine } from '../../src/main/services/latex/engine';
import { createLatexService } from '../../src/main/services/latex/service';
import { createProfileService } from '../../src/main/services/profile/service';
import { createRulesService } from '../../src/main/services/rules/service';
import { createAiSettings } from '../../src/main/services/settings/ai';
import type { CoverContent } from '../../src/shared/documents';
import { badCover, coverPosting, coverTemplate, goodCover } from '../fixtures/cover';
import { sampleAnalysis, sampleJd } from '../fixtures/jobs';
import { freshDb, tempDir } from '../unit/db/helpers';

const FAKE = resolve('tests/fixtures/fake-claude/claude.mjs');
const BIN = process.env.STELLIO_TECTONIC_BIN || resolve('spikes/latex/bin/tectonic');
const engine: Engine | null = existsSync(BIN)
  ? await detectEngine({ override: BIN, env: { PATH: '' } })
  : null;
const canCompile = engine !== null && (await compileTex({ engine, tex: coverTemplate })).ok;
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

async function setup(env: Record<string, string> = {}) {
  const db = freshDb();
  const dir = tempDir();
  for (const d of ['profile', 'rules', 'templates']) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, 'profile/praneethreddy.md'), readFileSync('tests/fixtures/profiles/full.md'));
  for (const f of [
    'rules/resume.md',
    'rules/skills-policy.md',
    'rules/cover-letter.md',
    'templates/resume.tex',
    'templates/cover-letter.tex',
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
      FAKE_CLAUDE_OUTPUT_COVER_GENERATE: JSON.stringify(goodCover),
      FAKE_CLAUDE_OUTPUT_COVER_REVISE: JSON.stringify({
        ...goodCover,
        closing: 'Best regards,',
      } satisfies CoverContent),
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
  const cover = createCoverService({
    db,
    runner,
    settings,
    profile,
    rules,
    latex,
    dataDir: dir,
    now: () => new Date('2026-11-20T12:00:00'),
  });
  const intake = await jobs.intakeText(coverPosting);
  if (intake.status !== 'ok') throw new Error('intake failed');
  await jobs.analyze(intake.jobId);
  const calls = (): { argv: string[]; stdin: string }[] =>
    readFileSync(cap, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { kind: string; argv: string[]; stdin: string })
      .filter((r) => r.kind === 'call' && r.stdin.includes('<cover_rules>'));
  return { db, dir, cover, jobId: intake.jobId, calls };
}

describe('cover letter pipeline (fake CLI)', { timeout: 60_000 }, () => {
  it('generate → checks → compile → stored as a cover_letter version 1', async () => {
    const { cover, jobId, calls, db, dir } = await setup();
    const stages: string[] = [];
    const v = await cover.generate(jobId, { onStage: (s) => stages.push(s) });
    expect(v.meta).toMatchObject({ version: 1, parentVersion: null, userEdited: false, isFinal: false });
    expect(v.meta.promptVersion).toBe('cover.generate@v1');
    expect(v.checks.truth).toEqual({ ok: true, violations: [], warnings: [] });
    expect(v.checks.lint).toEqual({ ok: true, issues: [] });
    expect(v.content).toEqual(goodCover);
    expect(v.tex).toContain(
      '\\letterRecipient{20 November 2026}{Nimbus Analytics GmbH}{Hiring Team, Data Engineer}{Berlin, Germany}',
    );
    expect(v.tex).toContain('Dear Hiring Team,');
    expect(stages).toEqual(['drafting', 'checking', 'compiling']);
    if (canCompile) {
      expect(v.checks.compile).toMatchObject({ ok: true, pages: 1 });
      expect(v.pdfBase64).toBeDefined();
      expect(existsSync(join(dir, '.stellio/documents'))).toBe(true);
    }
    // one call; the prompt embeds the rules files verbatim, the profile notes and the posting
    const [call] = calls();
    expect(calls()).toHaveLength(1);
    expect(call?.stdin).toContain(readFileSync('seed/rules/cover-letter.md', 'utf8'));
    expect(call?.stdin).toContain(readFileSync('seed/rules/skills-policy.md', 'utf8'));
    expect(call?.stdin).toContain('<notes>\nDo not mention the 2019 internship.');
    expect(call?.stdin).toContain('[exp-globex]');
    expect(call?.stdin).toContain('<job_description>');
    const argv = call?.argv ?? [];
    expect(argv[argv.indexOf('--model') + 1]).toBe('claude-sonnet-5-5');
    expect(argv[argv.indexOf('--effort') + 1]).toBe('high');
    expect(db.sqlite.prepare("select related_id from ai_runs where task = 'cover.generate'").all()).toEqual([
      { related_id: jobId },
    ]);
    expect(db.sqlite.prepare('select kind, version from documents').all()).toEqual([
      { kind: 'cover_letter', version: 1 },
    ]);
    const list = await cover.list(jobId);
    expect(list[0]).toMatchObject({ truthOk: true, truthViolations: 0, lintErrors: 0, stale: false });
    expect(list[0]?.words).toBeGreaterThan(230);
  });

  it('a truth violation triggers one repair round with the exact issues, then stores the clean draft', async () => {
    const { cover, jobId, calls } = await setup({
      FAKE_CLAUDE_OUTPUT_COVER_GENERATE: JSON.stringify(badCover),
      FAKE_CLAUDE_OUTPUT_COVER_GENERATE_REPAIR: JSON.stringify(goodCover),
    });
    const stages: string[] = [];
    const v = await cover.generate(jobId, { onStage: (s, n) => stages.push(n ? `${s}:${String(n)}` : s) });
    expect(calls()).toHaveLength(2);
    const repair = calls()[1]?.stdin ?? '';
    expect(repair).toMatch(/<repair_issues>\n- Truth \(number_not_in_source\) at paragraphs\[1\]/);
    expect(repair).toMatch(/Truth \(unknown_organisation\) at paragraphs\[1\].*Quokka/);
    expect(repair).toContain('<previous_draft>');
    expect(stages).toContain('fixing:2');
    expect(v.checks.truth?.ok).toBe(true);
    expect(v.content).toEqual(goodCover);
  });

  it('a lint failure (too short) is repaired; a draft still failing is stored with its issues', async () => {
    const short: CoverContent = { ...goodCover, paragraphs: goodCover.paragraphs.slice(0, 2) };
    const fixed = await setup({
      FAKE_CLAUDE_OUTPUT_COVER_GENERATE: JSON.stringify(short),
      FAKE_CLAUDE_OUTPUT_COVER_GENERATE_REPAIR: JSON.stringify(goodCover),
    });
    expect(await fixed.cover.generate(fixed.jobId)).toMatchObject({ checks: { lint: { ok: true } } });
    expect(fixed.calls()[1]?.stdin).toMatch(
      /Rules \(words\): The letter has \d+ words; it must be 230 to 350/,
    );

    const stuck = await setup({ FAKE_CLAUDE_OUTPUT_COVER_GENERATE: JSON.stringify(badCover) });
    const v = await stuck.cover.generate(stuck.jobId);
    expect(stuck.calls()).toHaveLength(2);
    expect(v.checks.truth?.ok).toBe(false);
    expect((await stuck.cover.list(stuck.jobId))[0]).toMatchObject({ truthOk: false, truthViolations: 2 });
  });

  it('revise, manual edit, mark final, diff, stale', async () => {
    const { cover, jobId, calls, dir } = await setup();
    await cover.generate(jobId);
    const v2 = await cover.revise(jobId, 1, 'sign off differently');
    expect(v2.meta).toMatchObject({ version: 2, parentVersion: 1, instruction: 'sign off differently' });
    expect(v2.meta.promptVersion).toBe('cover.revise@v1');
    expect(v2.tex).toContain('Best regards,');
    expect(calls()[1]?.stdin).toContain('<user_instruction>\nsign off differently\n</user_instruction>');
    expect(calls()[1]?.argv.join(' ')).toContain('You revise');

    const v3 = await cover.saveManual(jobId, 2, v2.tex.replace('I live in Berlin', 'I am based in Berlin'));
    expect(v3.meta).toMatchObject({ version: 3, parentVersion: 2, userEdited: true, model: null });
    expect(v3.checks.truth).toBeNull();
    expect(v3.content).toBeNull();
    expect(v3.checks.lint.ok).toBe(true);
    await expect(cover.revise(jobId, 3, 'shorter')).rejects.toThrow(/manual edit/);

    if (canCompile) {
      const evil = await cover.saveManual(
        jobId,
        3,
        v3.tex.replace('\\begin{document}', '\\begin{document}\\input{/etc/passwd}'),
      );
      expect(evil.checks.compile?.ok).toBe(false);
      expect(evil.checks.compile?.errors[0]?.message).toMatch(/can't read or write files/);
    }

    await cover.markFinal(jobId, 2);
    const list = await cover.markFinal(jobId, 3);
    expect(list.filter((s) => s.meta.isFinal).map((s) => s.meta.version)).toEqual([3]);
    await expect(cover.markFinal(jobId, 99)).rejects.toThrow(/does not exist/);

    // a rules edit makes every version stale
    writeFileSync(
      join(dir, 'rules/cover-letter.md'),
      readFileSync('seed/rules/cover-letter.md', 'utf8').replace('max: 350', 'max: 340'),
    );
    expect((await cover.list(jobId)).every((s) => s.stale)).toBe(true);
  });

  it('export names the file Firstname_Lastname_CoverLetter_<Company>; cancel writes nothing', async () => {
    const { cover, jobId, dir } = await setup();
    await cover.generate(jobId);
    const pick = vi.fn((name: string, ext: string) => Promise.resolve(join(dir, `${name}.${ext}`)));
    const name = 'Alex_Example_CoverLetter_Nimbus_Analytics_GmbH';
    expect(await cover.export(jobId, 1, 'tex', pick)).toEqual({
      status: 'saved',
      path: join(dir, `${name}.tex`),
    });
    expect(pick).toHaveBeenCalledWith(name, 'tex');
    expect(readFileSync(join(dir, `${name}.tex`), 'utf8')).toContain('\\letterHeader{Alex Example}');
    expect(await cover.export(jobId, 1, 'tex', () => Promise.resolve(null))).toEqual({ status: 'cancelled' });
    if (canCompile) {
      await cover.export(jobId, 1, 'pdf', pick);
      expect(
        readFileSync(join(dir, `${name}.pdf`))
          .subarray(0, 5)
          .toString(),
      ).toBe('%PDF-');
    } else await expect(cover.export(jobId, 1, 'pdf', pick)).rejects.toThrow(/no PDF/);
  });

  it('openOverleaf writes a private auto-submit form with the letter source', async () => {
    const { cover, jobId } = await setup();
    const v = await cover.generate(jobId);
    const open = vi.fn(() => Promise.resolve());
    const { url } = await cover.openOverleaf(jobId, 1, open);
    expect(open).toHaveBeenCalledWith(url);
    const file = fileURLToPath(url);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const html = readFileSync(file, 'utf8');
    expect(html).toContain('action="https://www.overleaf.com/docs"');
    expect(html).toContain(`name="encoded_snip" value="${encodeURIComponent(v.tex)}"`);
    cover.dispose();
    expect(existsSync(join(file, '..'))).toBe(false);
  });

  it('refuses an empty profile and unknown versions with a readable error', async () => {
    const { cover, jobId, dir } = await setup();
    await expect(cover.get(jobId, 7)).rejects.toThrow(/Cover letter version 7 does not exist/);
    writeFileSync(join(dir, 'profile/praneethreddy.md'), readFileSync('tests/fixtures/profiles/empty.md'));
    await expect(cover.generate(jobId)).rejects.toThrow(/profile has no skills or experience/);
  });
});
