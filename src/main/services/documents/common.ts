import { rmSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isExcluded, skillBlocker, type CompileSummary, type ResumeStage } from '@shared/documents';
import type { Jd } from '@shared/jobs/schemas';
import { ENTRY_SECTIONS, matchesSkill, type Profile } from '@shared/profile';
import type { SkillsPolicy } from '@shared/rules';
import type { TemplateFile } from '@shared/rules/files';
import { aiFailureMessage } from '../../ai/failure';
import type { RunResult } from '../../ai/runner';
import type { Db } from '../../db/database';
import { setAiRunRelated } from '../../db/repos/aiRuns';
import { updateDocument, type DocumentRow } from '../../db/repos/documents';
import { getJobSummary } from '../../db/repos/jobs';
import { UserError } from '../../ipc/dispatch';
import type { LatexService } from '../latex/service';
import type { ProfileService } from '../profile/service';

// Pieces the resume and cover letter services share: compile, PDF files, export, Overleaf, the repair round.

export type StageListener = (stage: ResumeStage, issues?: number) => void;
/** Shows a save dialog; null = cancelled. */
export type PickSavePath = (defaultName: string, ext: 'tex' | 'pdf') => Promise<string | null>;

/** A repaired draft replaces the first only if it is no worse: never more truth violations (review item 7). */
export const noWorse = (next: [number, number], best: [number, number]): boolean =>
  next[0] < best[0] || (next[0] === best[0] && next[1] <= best[1]);

const OVERLEAF_FORM_TTL_MS = 60_000;
const OVERLEAF_PREFIX = 'stellio-overleaf-';

/**
 * Deletes `stellio-overleaf-*` dirs in `root` older than `maxAgeMs` (left behind by a crash or kill). Run at
 * startup. Returns how many were removed.
 */
export async function sweepOverleafForms(root = tmpdir(), maxAgeMs = OVERLEAF_FORM_TTL_MS, now = Date.now()) {
  let removed = 0;
  for (const name of await readdir(root).catch(() => [])) {
    if (!name.startsWith(OVERLEAF_PREFIX)) continue;
    const dir = join(root, name);
    const st = await stat(dir).catch(() => null);
    if (!st?.isDirectory() || now - st.mtimeMs < maxAgeMs) continue;
    if (
      await rm(dir, { recursive: true, force: true }).then(
        () => true,
        () => false,
      )
    )
      removed++;
  }
  return removed;
}

/** `Firstname_Lastname_<Label>_<Company>` (no extension): letters and digits only, joined with underscores. */
export function exportFileName(name: string, company: string, label = 'Resume'): string {
  const part = (s: string): string =>
    s
      .normalize('NFKC')
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean)
      .join('_');
  return [part(name), label, part(company)].filter(Boolean).join('_');
}

/** Auto-submitting form for overleaf.com/docs (docs/06 §7). encodeURIComponent output is safe inside an attribute. */
export function overleafForm(tex: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Opening in Overleaf…</title></head>
<body>
<form id="f" method="post" action="https://www.overleaf.com/docs">
<input type="hidden" name="encoded_snip" value="${encodeURIComponent(tex)}">
<input type="hidden" name="engine" value="pdflatex">
<noscript><button type="submit">Open in Overleaf</button></noscript>
</form>
<script>document.getElementById('f').submit();</script>
</body></html>
`;
}

export interface DocFilesDeps {
  db: Db;
  latex: LatexService;
  profile: ProfileService;
  dataDir: string;
}

/** Compile, stored PDFs, export and the Overleaf hand-off for one document kind's service. */
export function createDocFiles(deps: DocFilesDeps) {
  const { db, latex } = deps;
  const pdfDir = join(deps.dataDir, '.stellio', 'documents');
  /** Overleaf form dirs not yet deleted; removed on quit if the 60 s timer has not run. */
  const overleafDirs = new Set<string>();

  /** Compiles through the sandboxed LaTeX service. Null when there is no engine (compile is optional). */
  async function compile(
    tex: string,
    template: TemplateFile,
  ): Promise<{ summary: CompileSummary; pdf: Buffer | null } | null> {
    let r;
    try {
      r = await latex.compileTemplate(template, tex);
    } catch (err) {
      if (err instanceof UserError) return null; // no engine installed
      throw err;
    }
    return {
      summary: {
        ok: r.ok,
        pages: r.pages,
        errors: r.errors,
        overfull: r.warnings.filter((w) => w.kind === 'overfull').length,
        ...(r.cacheMissing ? { cacheMissing: true } : {}),
      },
      pdf: r.pdfBase64 === undefined ? null : Buffer.from(r.pdfBase64, 'base64'),
    };
  }

  async function storePdf(row: DocumentRow, pdf: Buffer | null): Promise<void> {
    if (!pdf) {
      if (row.pdfPath) {
        await rm(join(deps.dataDir, row.pdfPath), { force: true });
        updateDocument(db, row.id, { pdfPath: null });
      }
      return;
    }
    await mkdir(pdfDir, { recursive: true });
    const rel = join('.stellio', 'documents', `${row.id}.pdf`);
    await writeFile(join(deps.dataDir, rel), pdf);
    updateDocument(db, row.id, { pdfPath: rel });
  }

  async function readPdf(row: DocumentRow): Promise<Buffer | null> {
    if (!row.pdfPath) return null;
    return readFile(join(deps.dataDir, row.pdfPath)).catch(() => null);
  }

  return {
    compile,
    storePdf,
    readPdf,

    /** Writes the .tex or the compiled PDF where the user picks. File name: Firstname_Lastname_<label>_<Company>. */
    async export(
      row: DocumentRow,
      label: string,
      format: 'tex' | 'pdf',
      pick: PickSavePath,
    ): Promise<{ status: 'saved'; path: string } | { status: 'cancelled' }> {
      const pdf = format === 'pdf' ? await readPdf(row) : null;
      if (format === 'pdf' && !pdf) throw new UserError('This version has no PDF yet. Compile it first.');
      const snap = await deps.profile.get();
      const company = getJobSummary(db, row.jobId)?.company ?? '';
      const path = await pick(exportFileName(snap.model.frontMatter.name, company, label), format);
      if (!path) return { status: 'cancelled' };
      await writeFile(path, pdf ?? row.tex);
      return { status: 'saved', path };
    },

    /**
     * Opens Overleaf with this version: a private temp HTML page that POSTs the source to overleaf.com/docs
     * (GET with a data: URI fails with 414 above ~13 KB). Only on an explicit user action; the file is deleted after 60 s.
     */
    async openOverleaf(row: DocumentRow, open: (url: string) => Promise<void>): Promise<{ url: string }> {
      const dir = await mkdtemp(join(tmpdir(), OVERLEAF_PREFIX));
      overleafDirs.add(dir);
      const file = join(dir, 'open-in-overleaf.html');
      await writeFile(file, overleafForm(row.tex), { mode: 0o600 });
      setTimeout(() => {
        overleafDirs.delete(dir);
        void rm(dir, { recursive: true, force: true });
      }, OVERLEAF_FORM_TTL_MS).unref();
      const url = pathToFileURL(file).href;
      await open(url);
      return { url };
    },

    /** On quit: deletes Overleaf form dirs whose timer has not run yet (synchronous, the app is exiting). */
    dispose(): void {
      for (const dir of overleafDirs) rmSync(dir, { recursive: true, force: true });
      overleafDirs.clear();
    },
  };
}
export type DocFiles = ReturnType<typeof createDocFiles>;

/**
 * One draft plus at most one repair round: the repair gets the exact blocking issues and replaces the first
 * draft only when it is no worse (ranked [truth violations, lint errors + overflow]).
 */
export async function draftWithRepair<
  C,
  E extends { content: C; issues: string[]; rank: [number, number] },
>(o: {
  db: Db;
  jobId: string;
  /** Model name recorded when the CLI does not report one. */
  model: string;
  run: (repair?: { previous: C; issues: string[] }) => Promise<RunResult<C>>;
  evaluate: (content: C) => Promise<E>;
  onStage: StageListener;
}): Promise<{ best: E; model: string }> {
  const first = await o.run();
  if (!first.ok) throw new UserError(aiFailureMessage(first.status, first.error));
  setAiRunRelated(o.db, first.runId, 'job', o.jobId);
  let model = first.model ?? o.model;
  let best = await o.evaluate(first.data);
  if (best.issues.length > 0) {
    o.onStage('fixing', best.issues.length);
    const repair = await o.run({ previous: best.content, issues: best.issues });
    if (repair.ok) {
      setAiRunRelated(o.db, repair.runId, 'job', o.jobId);
      const next = await o.evaluate(repair.data);
      if (noWorse(next.rank, best.rank)) {
        best = next;
        model = repair.model ?? model;
      }
    } else if (repair.status === 'cancelled')
      throw new UserError(aiFailureMessage(repair.status, repair.error));
  }
  return { best, model };
}

/** Allowed skills as prompt lines: the policy plus this job's approved skill decisions. */
export function allowedSkills(
  profile: Profile,
  policy: SkillsPolicy,
  jd: Jd | null,
  approved: string[],
  /** Skills the user removed for this job: never offered to the model. */
  removed: string[] = [],
): string[] {
  const jdSkills = jd?.requirements.flatMap((r) => r.skills) ?? [];
  const rows = profile.skills.filter(
    (r) =>
      !removed.some((x) => matchesSkill(r, x)) &&
      (skillBlocker(r, policy, jdSkills) === null || approved.some((a) => matchesSkill(r, a))),
  );
  const extra = approved.filter((a) => !profile.skills.some((r) => matchesSkill(r, a)));
  return [
    ...rows.map((r) =>
      [
        r.skill,
        r.status === 'learning' ? ' [learning]' : '',
        r.aliases.length ? ` (aliases: ${r.aliases.join(', ')})` : '',
      ].join(''),
    ),
    ...extra.map((a) => `${a} [approved for this job]`),
  ];
}

export const withoutExcluded = (p: Profile): Profile => ({
  ...p,
  ...Object.fromEntries(ENTRY_SECTIONS.map((s) => [s, p[s].filter((e) => !isExcluded(e))])),
});
