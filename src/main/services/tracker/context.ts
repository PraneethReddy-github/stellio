import { eq, inArray, sql } from 'drizzle-orm';
import { RESPONSE_STATUSES, isClosed, nextActionFor, toMs, type History } from '@shared/tracker';
import type { Application } from '@shared/tracker';
import type { Db } from '../../db/database';
import { analyses, applicationEvents, applications, companies, interviews, jobs } from '../../db/schema';
import type { ApplicationRow, EventRow, InterviewRow } from '../../db/repos/applications';

/** An application with its job, fit and what the follow-up rules need. */
export interface Ctx {
  app: ApplicationRow;
  job: typeof jobs.$inferSelect;
  company: string;
  fit: number | null;
  events: EventRow[];
  interviews: InterviewRow[];
}

/** Loads applications (all, or one) with job, company, latest full analysis fit, events and interviews. */
export function loadContexts(db: Db, id?: string): Ctx[] {
  const rows = db.orm
    .select({ app: applications, job: jobs, company: companies.name, fit: analyses.fitScore })
    .from(applications)
    .innerJoin(jobs, eq(jobs.id, applications.jobId))
    .innerJoin(companies, eq(companies.id, jobs.companyId))
    .leftJoin(
      analyses,
      eq(
        analyses.id,
        sql`(select a2.id from analyses a2 where a2.job_id = ${jobs.id} and a2.triage = 0 order by a2.created_at desc, a2.id desc limit 1)`,
      ),
    )
    .where(id ? eq(applications.id, id) : undefined)
    .all();
  const ids = rows.map((r) => r.app.id);
  if (ids.length === 0) return [];
  const events = new Map<string, EventRow[]>();
  const ivs = new Map<string, InterviewRow[]>();
  // Chunked: SQLite caps bound parameters.
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    for (const e of db.orm
      .select()
      .from(applicationEvents)
      .where(inArray(applicationEvents.applicationId, chunk))
      .orderBy(sql`${applicationEvents}.rowid`)
      .all())
      (events.get(e.applicationId) ?? events.set(e.applicationId, []).get(e.applicationId))?.push(e);
    for (const v of db.orm.select().from(interviews).where(inArray(interviews.applicationId, chunk)).all())
      (ivs.get(v.applicationId) ?? ivs.set(v.applicationId, []).get(v.applicationId))?.push(v);
  }
  return rows.map((r) => ({
    ...r,
    events: events.get(r.app.id) ?? [],
    interviews: ivs.get(r.app.id) ?? [],
  }));
}

const payloadOf = (e: EventRow): Record<string, unknown> =>
  e.payloadJson && typeof e.payloadJson === 'object' ? (e.payloadJson as Record<string, unknown>) : {};

export function historyOf(c: Ctx): History {
  const offer = [...c.events]
    .reverse()
    .find(
      (e) =>
        e.type === 'status_change' && e.toStatus === 'offer' && typeof payloadOf(e).deadline === 'string',
    );
  return {
    appliedAt: c.app.appliedAt,
    followUps: c.events.filter((e) => e.type === 'follow_up').map((e) => e.at),
    interviews: c.interviews.map((i) => ({ scheduledAt: i.scheduledAt, outcome: i.outcome })),
    offerDeadline: offer ? (payloadOf(offer).deadline as string) : null,
  };
}

/** The last time the company was in touch: the application, their answers, mail, contacts, interviews held. */
export function lastContactAt(c: Ctx, now: Date): string | null {
  const times: string[] = [];
  if (c.app.appliedAt) times.push(c.app.appliedAt);
  for (const e of c.events) {
    if (e.type === 'email' || e.type === 'contact' || e.type === 'interview') times.push(e.at);
    else if (e.type === 'status_change' && e.toStatus && RESPONSE_STATUSES.includes(e.toStatus))
      times.push(e.at);
  }
  for (const i of c.interviews)
    if (i.scheduledAt && i.outcome !== 'cancelled' && toMs(i.scheduledAt) <= now.getTime())
      times.push(i.scheduledAt);
  return times.reduce<string | null>((a, b) => (!a || toMs(b) > toMs(a) ? b : a), null);
}

/** The user's own next action wins over the suggested one; closed applications have none. */
export function effectiveNext(
  c: Ctx,
  now: Date,
): { action: string | null; at: string | null; suggested: boolean } {
  if (isClosed(c.app.status)) return { action: null, at: null, suggested: false };
  if (c.app.nextAction !== null || c.app.nextActionAt !== null)
    return { action: c.app.nextAction ?? 'Follow up', at: c.app.nextActionAt, suggested: false };
  const s = nextActionFor(c.app.status, historyOf(c), now);
  return { action: s?.action ?? null, at: s?.at ?? null, suggested: s !== null };
}

export function toApplication(c: Ctx, now: Date): Application {
  const next = effectiveNext(c, now);
  const a = c.app;
  return {
    id: a.id,
    jobId: a.jobId,
    company: c.company,
    role: c.job.title,
    status: a.status,
    statusChangedAt: a.statusChangedAt,
    appliedAt: a.appliedAt,
    channel: a.channel,
    priority: a.priority,
    nextAction: next.action,
    nextActionAt: next.at,
    nextActionSuggested: next.suggested,
    folderPath: a.folderPath,
    resumeDocId: a.resumeDocId,
    coverDocId: a.coverDocId,
    salaryExpectation: a.salaryExpectation,
    notesMd: a.notesMd,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}
