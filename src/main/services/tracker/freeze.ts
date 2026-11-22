import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { applicationFolder, type AnalysisSnapshot } from '@shared/tracker';
import type { Db } from '../../db/database';
import { listAuditRows } from '../../db/repos/skills';
import { getJob, latestAnalysis } from '../../db/repos/jobs';
import { listDocumentVersions, type DocumentRow } from '../../db/repos/documents';
import { UserError } from '../../ipc/dispatch';
import { hashText, writeFileAtomic } from '../datafolder/files';
import { GitError, commitFiles } from '../datafolder/git';
import type { Ctx } from './context';
import { AnalysisResultSchema } from '@shared/jobs/schemas';

/** `target` as an absolute path, which must lie inside `root` (lexically; the freeze never follows links out). */
export function insideFolder(root: string, target: string): string {
  const abs = resolve(root, target);
  const rel = relative(resolve(root), abs);
  if (!rel || rel.startsWith('..') || isAbsolute(rel))
    throw new UserError('That path is outside the data folder.');
  return abs;
}

export const finalDocument = (db: Db, jobId: string, kind: DocumentRow['kind']): DocumentRow | undefined =>
  listDocumentVersions(db, jobId, kind).find((d) => d.isFinal);

/** Latest analysis plus the skill audit of the given resume version, in the shape stored as analysis.json. */
export function analysisSnapshot(db: Db, jobId: string, resumeDocId: string | null): AnalysisSnapshot | null {
  const a = latestAnalysis(db, jobId);
  if (!a) return null;
  return {
    fitScore: a.fitScore,
    verdict: a.verdict,
    model: a.model,
    promptVersion: a.promptVersion,
    profileHash: a.profileHash,
    createdAt: a.createdAt,
    result: AnalysisResultSchema.safeParse(a.resultJson).data ?? null,
    skillAudit: resumeDocId
      ? listAuditRows(db, resumeDocId).map((r) => ({
          skill: r.skill,
          origin: r.origin,
          jdImportance: r.jdImportance,
          recommendation: r.recommendation,
          decision: r.decision,
        }))
      : [],
  };
}

export interface FreezeResult {
  folder: string;
  files: string[];
  commit: string | null;
  resumeDocId: string | null;
  coverDocId: string | null;
}

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

/**
 * Copies the final documents and the job snapshot into a fresh `applications/<date>_<company>_<role>[-n]/` folder
 * and commits them (docs/08 §1, plan T1.3). The folder is claimed with a non-recursive mkdir, so an existing folder
 * is never reused or overwritten: a re-apply gets `-2`, `-3`, ...
 */
export async function freezeApplication(o: {
  db: Db;
  dataDir: string;
  gitAvailable: boolean;
  ctx: Ctx;
  now: Date;
  force: { reason: string } | null;
}): Promise<FreezeResult> {
  const { db, dataDir, ctx, now } = o;
  const job = getJob(db, ctx.app.jobId);
  if (!job) throw new UserError('That job no longer exists.');
  const resume = finalDocument(db, job.id, 'resume');
  const cover = finalDocument(db, job.id, 'cover_letter');
  if (!resume && !o.force)
    throw new UserError('Mark a final resume version first, or apply without one and give a reason.');

  const base = applicationFolder(now, ctx.company, job.title);
  await mkdir(insideFolder(dataDir, 'applications'), { recursive: true });
  let rel = base;
  for (let n = 2; ; n++) {
    try {
      await mkdir(insideFolder(dataDir, rel));
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      rel = `${base}-${String(n)}`;
    }
  }
  const dir = insideFolder(dataDir, rel);
  const files: string[] = [];
  const put = async (name: string, content: string | Buffer): Promise<void> => {
    const path = join(dir, name);
    if (existsSync(path)) throw new Error(`refusing to overwrite ${path}`);
    await writeFileAtomic(path, content);
    files.push(name);
  };
  const pdfOf = async (d: DocumentRow): Promise<Buffer | null> =>
    d.pdfPath ? readFile(insideFolder(dataDir, d.pdfPath)).catch(() => null) : null;

  try {
    const docMeta = async (d: DocumentRow, texName: string, pdfName: string) => {
      await put(texName, d.tex);
      const pdf = await pdfOf(d);
      if (pdf) await put(pdfName, pdf);
      return {
        version: d.version,
        documentId: d.id,
        texSha256: hashText(d.tex),
        pdfSha256: pdf ? sha(pdf) : null,
        profileHash: d.profileHash,
        rulesHash: d.rulesHash,
        templateHash: d.templateHash,
        model: d.model,
        promptVersion: d.promptVersion,
        userEdited: d.userEdited,
      };
    };
    const resumeMeta = resume ? await docMeta(resume, 'resume.tex', 'resume.pdf') : null;
    const coverMeta = cover ? await docMeta(cover, 'cover-letter.tex', 'cover-letter.pdf') : null;
    const header = [
      `# ${job.title} — ${ctx.company}`,
      '',
      job.url ? `Posting: ${job.url}` : null,
      `Captured: ${now.toISOString()}`,
    ]
      .filter((l) => l !== null)
      .join('\n');
    await put('jd.md', `${header}\n\n---\n\n${job.descriptionMd}\n`);
    await put(
      'analysis.json',
      `${JSON.stringify({ job: { title: job.title, company: ctx.company, url: job.url }, ...analysisSnapshot(db, job.id, resume?.id ?? null) }, null, 2)}\n`,
    );
    await put(
      'meta.json',
      `${JSON.stringify(
        {
          applicationId: ctx.app.id,
          jobId: job.id,
          company: ctx.company,
          role: job.title,
          frozenAt: now.toISOString(),
          forced: o.force ? { reason: o.force.reason } : null,
          resume: resumeMeta,
          coverLetter: coverMeta,
        },
        null,
        2,
      )}\n`,
    );
  } catch (e) {
    // The folder is ours (just created), so removing it leaves nothing half-frozen behind.
    await rm(dir, { recursive: true, force: true });
    throw e;
  }

  let commit: string | null = null;
  if (o.gitAvailable) {
    try {
      commit = await commitFiles(dataDir, [rel], `apply: ${ctx.company} — ${job.title}`);
    } catch (e) {
      // The files are saved; history is a bonus. The event records that no commit was made.
      if (!(e instanceof GitError)) throw e;
    }
  }
  return {
    folder: rel,
    files: files.sort(),
    commit,
    resumeDocId: resume?.id ?? null,
    coverDocId: cover?.id ?? null,
  };
}
