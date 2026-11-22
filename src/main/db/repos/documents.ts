import { and, asc, eq, inArray, max } from 'drizzle-orm';
import type { Db } from '../database';
import { markPreparing } from './applications';
import { applications, documents, jobs, skillAudits } from '../schema';

export type DocumentRow = typeof documents.$inferSelect;
export type NewDocument = Omit<typeof documents.$inferInsert, 'id' | 'version' | 'createdAt' | 'updatedAt'>;
type Kind = DocumentRow['kind'];

/** Inserts the next version (per job + kind) in one transaction. */
export function insertDocumentVersion(db: Db, doc: NewDocument): DocumentRow {
  return db.sqlite.transaction(() => {
    const top = db.orm
      .select({ v: max(documents.version) })
      .from(documents)
      .where(and(eq(documents.jobId, doc.jobId), eq(documents.kind, doc.kind)))
      .get();
    // A draft starts the application (`preparing`), docs/08 §1.
    const app = markPreparing(db, doc.jobId);
    return db.orm
      .insert(documents)
      .values({ ...doc, applicationId: app.id, version: (top?.v ?? 0) + 1 })
      .returning()
      .get();
  })();
}

export function listDocumentVersions(db: Db, jobId: string, kind: Kind): DocumentRow[] {
  return db.orm
    .select()
    .from(documents)
    .where(and(eq(documents.jobId, jobId), eq(documents.kind, kind)))
    .orderBy(asc(documents.version))
    .all();
}

export function getDocumentVersion(
  db: Db,
  jobId: string,
  kind: Kind,
  version: number,
): DocumentRow | undefined {
  return db.orm
    .select()
    .from(documents)
    .where(and(eq(documents.jobId, jobId), eq(documents.kind, kind), eq(documents.version, version)))
    .get();
}

export function updateDocument(
  db: Db,
  id: string,
  patch: Partial<Pick<DocumentRow, 'pdfPath' | 'truthReportJson' | 'atsReportJson'>>,
): void {
  db.orm.update(documents).set(patch).where(eq(documents.id, id)).run();
}

/** Makes `version` the only final one for this job + kind. False when the version does not exist. */
export function setFinalVersion(db: Db, jobId: string, kind: Kind, version: number): boolean {
  return db.sqlite.transaction(() => {
    const row = getDocumentVersion(db, jobId, kind, version);
    if (!row) return false;
    db.orm
      .update(documents)
      .set({ isFinal: false })
      .where(and(eq(documents.jobId, jobId), eq(documents.kind, kind)))
      .run();
    db.orm.update(documents).set({ isFinal: true }).where(eq(documents.id, row.id)).run();
    return true;
  })();
}

/** The user's latest keep/add/remove decision per skill for this job (later decisions win), docs/07 §3. */
function latestSkillDecisions(db: Db, jobId: string): Map<string, { skill: string; decision: string }> {
  const rows = db.orm
    .select({ skill: skillAudits.skill, decision: skillAudits.decision, at: skillAudits.decidedAt })
    .from(skillAudits)
    .innerJoin(documents, eq(skillAudits.documentId, documents.id))
    .where(and(eq(documents.jobId, jobId), inArray(skillAudits.decision, ['kept', 'added', 'removed'])))
    .all()
    .sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''));
  const latest = new Map<string, { skill: string; decision: string }>();
  for (const r of rows) latest.set(r.skill.toLowerCase(), { skill: r.skill, decision: r.decision });
  return latest;
}

/** Skills the user approved for this job in a skill audit (kept or added, and not removed since). */
export function approvedSkillsForJob(db: Db, jobId: string): string[] {
  return [...latestSkillDecisions(db, jobId).values()]
    .filter((d) => d.decision !== 'removed')
    .map((d) => d.skill);
}

/** Skills the user removed for this job; regenerating must not bring them back. */
export function removedSkillsForJob(db: Db, jobId: string): string[] {
  return [...latestSkillDecisions(db, jobId).values()]
    .filter((d) => d.decision === 'removed')
    .map((d) => d.skill);
}

/** Skills decided in an audit since `sinceIso`, with the job they were decided for. */
export function recentSkillDecisions(
  db: Db,
  sinceIso: string,
): { skill: string; decision: string; job: string; at: string }[] {
  return db.orm
    .select({
      skill: skillAudits.skill,
      decision: skillAudits.decision,
      job: jobs.title,
      at: skillAudits.decidedAt,
    })
    .from(skillAudits)
    .innerJoin(documents, eq(skillAudits.documentId, documents.id))
    .innerJoin(jobs, eq(jobs.id, documents.jobId))
    .where(inArray(skillAudits.decision, ['kept', 'removed', 'learning', 'added']))
    .all()
    .flatMap((r) => (r.at !== null && r.at >= sinceIso ? [{ ...r, at: r.at }] : []))
    .sort((a, b) => a.at.localeCompare(b.at));
}

/** The latest resume version of every job whose application is not closed (or that has none), with its source. */
export function openResumes(db: Db): { jobId: string; tex: string }[] {
  const closed = ['accepted', 'declined', 'rejected', 'withdrawn', 'ghosted', 'not_applying'];
  const latest = new Map<string, { version: number; tex: string }>();
  const appStatus = new Map(
    db.orm
      .select({ jobId: applications.jobId, status: applications.status })
      .from(applications)
      .all()
      .map((a) => [a.jobId, a.status]),
  );
  for (const d of db.orm
    .select({ jobId: documents.jobId, version: documents.version, tex: documents.tex })
    .from(documents)
    .where(eq(documents.kind, 'resume'))
    .all()) {
    const status = appStatus.get(d.jobId);
    if (status !== undefined && closed.includes(status)) continue;
    const prev = latest.get(d.jobId);
    if (!prev || d.version > prev.version) latest.set(d.jobId, { version: d.version, tex: d.tex });
  }
  return [...latest.entries()].map(([jobId, v]) => ({ jobId, tex: v.tex }));
}
