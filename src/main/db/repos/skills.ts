import { desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { JdSchema } from '@shared/jobs/schemas';
import { canonicalSkillKey } from '@shared/profile';
import { computeDemand, demandKey, type DemandWindow } from '@shared/skills/demand';
import type { AuditRecommendation, DemandShare, SkillAuditRow } from '@shared/skills/schemas';
import type { Db } from '../database';
import { documents, jobs, learningItems, skillAudits, skillDemand } from '../schema';
import { getSetting, setSetting } from './settings';

export type LearningRow = typeof learningItems.$inferSelect;
export type AuditDbRow = typeof skillAudits.$inferSelect;
type Decision = AuditDbRow['decision'];

/**
 * Recomputes `skill_demand` from every stored job's structured JD (docs/07 §2). Derived data: always safe to
 * rerun. Called after intake, job deletion and (Phase 8) scans.
 */
export function recomputeSkillDemand(db: Db, now = new Date()): void {
  const stored = db.orm
    .select({ postedAt: jobs.postedAt, firstSeenAt: jobs.firstSeenAt, structured: jobs.structuredJson })
    .from(jobs)
    .all();
  const demand = computeDemand(
    stored.map((j) => ({
      at: j.postedAt ?? j.firstSeenAt,
      jd: JdSchema.safeParse(j.structured).data ?? null,
    })),
    now,
  );
  const computedAt = now.toISOString();
  db.sqlite.transaction(() => {
    db.orm.delete(skillDemand).run();
    for (const [window, entries] of Object.entries(demand) as [DemandWindow, (typeof demand)['all']][])
      for (const e of entries)
        db.orm
          .insert(skillDemand)
          .values({
            skill: e.skill,
            window,
            jobCount: e.jobCount,
            share: e.share,
            requiredShare: e.requiredShare,
            computedAt,
          })
          .run();
  })();
}

/** Stored demand for one window, keyed by `demandKey`. */
export function demandMap(db: Db, window: DemandWindow): Map<string, DemandShare & { skill: string }> {
  return new Map(
    db.orm
      .select()
      .from(skillDemand)
      .where(eq(skillDemand.window, window))
      .all()
      .map((r) => [
        demandKey(r.skill),
        { skill: r.skill, jobCount: r.jobCount, share: r.share, requiredShare: r.requiredShare },
      ]),
  );
}

// ---- skill audits ------------------------------------------------------------------------------------------

/** The DB enum has no `emphasize` / `ask_have`: they are stored as the action they lead to. */
export const storedRecommendation = (r: AuditRecommendation): AuditDbRow['recommendation'] =>
  r === 'emphasize' ? 'keep' : r === 'ask_have' ? 'add_to_profile' : r;

export function listAuditRows(db: Db, documentId: string): AuditDbRow[] {
  return db.orm.select().from(skillAudits).where(eq(skillAudits.documentId, documentId)).all();
}

const sameSkill = (a: string, b: string): boolean => canonicalSkillKey(a) === canonicalSkillKey(b);

/**
 * Writes the audit rows for a document: one row per (document, skill). Existing rows keep their decision;
 * everything else is refreshed. Wording is stored in `rationale`.
 */
export function upsertAuditRows(db: Db, documentId: string, rows: readonly SkillAuditRow[]): AuditDbRow[] {
  return db.sqlite.transaction(() => {
    const existing = listAuditRows(db, documentId);
    for (const r of rows) {
      const values = {
        origin: r.origin,
        jdImportance: r.jdImportance,
        evidenceIds: r.evidenceIds,
        recommendation: storedRecommendation(r.recommendation),
        rationale: r.rationale,
      };
      const hit = existing.find((e) => sameSkill(e.skill, r.skill));
      if (hit) db.orm.update(skillAudits).set(values).where(eq(skillAudits.id, hit.id)).run();
      else
        db.orm
          .insert(skillAudits)
          .values({ documentId, skill: r.skill, ...values })
          .run();
    }
    return listAuditRows(db, documentId);
  })();
}

/** Sets the decision for a skill, inserting the row when the audit never listed it. */
export function setAuditDecision(
  db: Db,
  documentId: string,
  skill: string,
  decision: Decision,
  fallback: Pick<AuditDbRow, 'origin' | 'jdImportance' | 'recommendation'>,
): void {
  const hit = listAuditRows(db, documentId).find((e) => sameSkill(e.skill, skill));
  const decidedAt = new Date().toISOString();
  if (hit) db.orm.update(skillAudits).set({ decision, decidedAt }).where(eq(skillAudits.id, hit.id)).run();
  else
    db.orm
      .insert(skillAudits)
      .values({ documentId, skill, ...fallback, decision, decidedAt })
      .run();
}

const Wording = z.record(
  z.string(),
  z.object({ rationale: z.string(), learnEstimateHours: z.number().int().nullable() }),
);
export type StoredWording = z.infer<typeof Wording>;
const wordingKey = (documentId: string): string => `skills.audit.${documentId}`;

/** The AI-written part of an audit (sentence + hours per skill), cached per document. Null = never run. */
export function getAuditWording(db: Db, documentId: string): StoredWording | null {
  try {
    return getSetting(db, wordingKey(documentId), Wording) ?? null;
  } catch {
    return null;
  }
}

export function setAuditWording(db: Db, documentId: string, wording: StoredWording): void {
  setSetting(db, wordingKey(documentId), wording);
}

/** Distinct jobs where this skill's audit decision is "learn". */
export function countLearnJobs(db: Db, skill: string): number {
  const rows = db.orm
    .select({ jobId: documents.jobId, skill: skillAudits.skill })
    .from(skillAudits)
    .innerJoin(documents, eq(skillAudits.documentId, documents.id))
    .where(eq(skillAudits.decision, 'learning'))
    .all()
    .filter((r) => sameSkill(r.skill, skill));
  return new Set(rows.map((r) => r.jobId)).size;
}

// ---- learning items ----------------------------------------------------------------------------------------

export function listLearningItems(db: Db): LearningRow[] {
  return db.orm
    .select()
    .from(learningItems)
    .orderBy(
      sql`CASE ${learningItems.status} WHEN 'doing' THEN 0 WHEN 'todo' THEN 1 WHEN 'done' THEN 2 ELSE 3 END`,
      desc(learningItems.priority),
      learningItems.skill,
    )
    .all();
}

export function findLearningItem(db: Db, skill: string): LearningRow | undefined {
  return listLearningItems(db).find((l) => sameSkill(l.skill, skill));
}

export function getLearningItem(db: Db, id: string): LearningRow | undefined {
  return db.orm.select().from(learningItems).where(eq(learningItems.id, id)).get();
}

export type LearningPatch = Partial<
  Pick<
    LearningRow,
    | 'priority'
    | 'reason'
    | 'targetLevel'
    | 'estHours'
    | 'status'
    | 'resourcesMd'
    | 'linkedJobs'
    | 'completedAt'
  >
>;

export function insertLearningItem(db: Db, skill: string, patch: LearningPatch): LearningRow {
  return db.orm
    .insert(learningItems)
    .values({ skill, ...patch })
    .returning()
    .get();
}

export function updateLearningItem(db: Db, id: string, patch: LearningPatch): LearningRow | undefined {
  return db.orm.update(learningItems).set(patch).where(eq(learningItems.id, id)).returning().get();
}
