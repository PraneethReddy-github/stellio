import { and, asc, eq, max, sql } from 'drizzle-orm';
import type { Db } from '../database';
import {
  applicationContacts,
  applicationEvents,
  applications,
  contacts,
  documents,
  interviews,
} from '../schema';

export type ApplicationRow = typeof applications.$inferSelect;
export type EventRow = typeof applicationEvents.$inferSelect;
export type InterviewRow = typeof interviews.$inferSelect;
export type ContactRow = typeof contacts.$inferSelect;
type Status = ApplicationRow['status'];
type EventType = EventRow['type'];
const iso = (): string => new Date().toISOString();

export function getApplication(db: Db, id: string): ApplicationRow | undefined {
  return db.orm.select().from(applications).where(eq(applications.id, id)).get();
}

export function getApplicationByJob(db: Db, jobId: string): ApplicationRow | undefined {
  return db.orm.select().from(applications).where(eq(applications.jobId, jobId)).get();
}

export function appendEvent(
  db: Db,
  applicationId: string,
  type: EventType,
  payload: unknown,
  at = iso(),
  statuses: { from?: Status | null; to?: Status | null } = {},
): EventRow {
  return db.orm
    .insert(applicationEvents)
    .values({
      applicationId,
      type,
      at,
      fromStatus: statuses.from ?? null,
      toStatus: statuses.to ?? null,
      payloadJson: payload ?? null,
    })
    .returning()
    .get();
}

/** Documents of the job belong to its application from now on. */
export function linkJobDocuments(db: Db, jobId: string, applicationId: string): void {
  db.orm.update(documents).set({ applicationId }).where(eq(documents.jobId, jobId)).run();
}

/**
 * Creates the application for a job (idempotent). `saved`, or `preparing` when a document already exists;
 * the creation is the first event, so the timeline starts there.
 */
export function ensureApplication(
  db: Db,
  jobId: string,
  via: 'shortlisted' | 'draft' | 'manual',
  at = iso(),
): { app: ApplicationRow; created: boolean } {
  return db.sqlite.transaction(() => {
    const found = getApplicationByJob(db, jobId);
    if (found) return { app: found, created: false };
    const hasDoc = db.orm
      .select({ id: documents.id })
      .from(documents)
      .where(eq(documents.jobId, jobId))
      .get();
    const status: Status = hasDoc || via === 'draft' ? 'preparing' : 'saved';
    const app = db.orm.insert(applications).values({ jobId, status, statusChangedAt: at }).returning().get();
    appendEvent(db, app.id, 'status_change', { created: via }, at, { from: null, to: status });
    linkJobDocuments(db, jobId, app.id);
    return { app, created: true };
  })();
}

/** A resume or cover letter is being drafted: creates the application as `preparing`, or moves `saved` there. */
export function markPreparing(db: Db, jobId: string, at = iso()): ApplicationRow {
  return db.sqlite.transaction(() => {
    const { app, created } = ensureApplication(db, jobId, 'draft', at);
    if (created || app.status !== 'saved') return app;
    return setStatusRow(db, app.id, 'preparing', { auto: 'draft' }, at);
  })();
}

/** Status change + its event in one transaction. `patch` carries columns that change with it (applied_at, folder). */
export function setStatusRow(
  db: Db,
  id: string,
  to: Status,
  payload: unknown,
  at = iso(),
  patch: Partial<Pick<ApplicationRow, 'appliedAt' | 'folderPath' | 'resumeDocId' | 'coverDocId'>> = {},
): ApplicationRow {
  return db.sqlite.transaction(() => {
    const cur = getApplication(db, id);
    if (!cur) throw new Error(`application ${id} not found`);
    const row = db.orm
      .update(applications)
      .set({ ...patch, status: to, statusChangedAt: at })
      .where(eq(applications.id, id))
      .returning()
      .get();
    appendEvent(db, id, 'status_change', payload, at, { from: cur.status, to });
    return row;
  })();
}

export type ApplicationPatch = Partial<
  Pick<
    ApplicationRow,
    'channel' | 'priority' | 'nextAction' | 'nextActionAt' | 'salaryExpectation' | 'notesMd'
  >
>;
export function updateApplicationRow(
  db: Db,
  id: string,
  patch: ApplicationPatch,
): ApplicationRow | undefined {
  if (Object.keys(patch).length === 0) return getApplication(db, id);
  return db.orm.update(applications).set(patch).where(eq(applications.id, id)).returning().get();
}

export function listApplicationRows(db: Db): ApplicationRow[] {
  return db.orm.select().from(applications).all();
}

export function listEvents(db: Db, applicationId: string): EventRow[] {
  return db.orm
    .select()
    .from(applicationEvents)
    .where(eq(applicationEvents.applicationId, applicationId))
    .orderBy(sql`${applicationEvents}.rowid`)
    .all();
}

// ---- interviews --------------------------------------------------------------------------------------------

export type NewInterview = Partial<
  Pick<InterviewRow, 'round' | 'kind' | 'scheduledAt' | 'outcome' | 'notesMd'>
>;

export function getInterview(db: Db, id: string): InterviewRow | undefined {
  return db.orm.select().from(interviews).where(eq(interviews.id, id)).get();
}
export function listInterviews(db: Db, applicationId: string): InterviewRow[] {
  return db.orm
    .select()
    .from(interviews)
    .where(eq(interviews.applicationId, applicationId))
    .orderBy(asc(interviews.round), asc(interviews.scheduledAt))
    .all();
}
export function listAllInterviews(db: Db): InterviewRow[] {
  return db.orm.select().from(interviews).all();
}
export function insertInterview(db: Db, applicationId: string, v: NewInterview): InterviewRow {
  return db.sqlite.transaction(() => {
    const top = db.orm
      .select({ r: max(interviews.round) })
      .from(interviews)
      .where(eq(interviews.applicationId, applicationId))
      .get();
    return db.orm
      .insert(interviews)
      .values({ ...v, applicationId, round: v.round ?? (top?.r ?? 0) + 1 })
      .returning()
      .get();
  })();
}
export function updateInterview(db: Db, id: string, v: NewInterview): InterviewRow | undefined {
  if (Object.keys(v).length === 0) return getInterview(db, id);
  return db.orm.update(interviews).set(v).where(eq(interviews.id, id)).returning().get();
}
export function deleteInterview(db: Db, id: string): boolean {
  return db.orm.delete(interviews).where(eq(interviews.id, id)).run().changes > 0;
}

// ---- contacts ----------------------------------------------------------------------------------------------

export type NewContact = Partial<Pick<ContactRow, 'role' | 'email' | 'linkedinUrl' | 'notesMd' | 'name'>>;

export function getContact(db: Db, id: string): ContactRow | undefined {
  return db.orm.select().from(contacts).where(eq(contacts.id, id)).get();
}
export function insertContact(
  db: Db,
  companyId: string | null,
  v: NewContact & { name: string },
): ContactRow {
  return db.orm
    .insert(contacts)
    .values({ ...v, companyId })
    .returning()
    .get();
}
export function updateContact(db: Db, id: string, v: NewContact): ContactRow | undefined {
  if (Object.keys(v).length === 0) return getContact(db, id);
  return db.orm.update(contacts).set(v).where(eq(contacts.id, id)).returning().get();
}
export function deleteContact(db: Db, id: string): boolean {
  return db.orm.delete(contacts).where(eq(contacts.id, id)).run().changes > 0;
}
export function linkContact(db: Db, applicationId: string, contactId: string): void {
  db.orm.insert(applicationContacts).values({ applicationId, contactId }).onConflictDoNothing().run();
}
export function unlinkContact(db: Db, applicationId: string, contactId: string): boolean {
  return (
    db.orm
      .delete(applicationContacts)
      .where(
        and(
          eq(applicationContacts.applicationId, applicationId),
          eq(applicationContacts.contactId, contactId),
        ),
      )
      .run().changes > 0
  );
}
export function linkedContacts(db: Db, applicationId: string): ContactRow[] {
  return db.orm
    .select({ c: contacts })
    .from(applicationContacts)
    .innerJoin(contacts, eq(contacts.id, applicationContacts.contactId))
    .where(eq(applicationContacts.applicationId, applicationId))
    .orderBy(asc(contacts.name))
    .all()
    .map((r) => r.c);
}
/** Contacts at the company that are not linked to this application yet. */
export function availableContacts(db: Db, applicationId: string, companyId: string): ContactRow[] {
  const linked = linkedContacts(db, applicationId).map((c) => c.id);
  const rows = db.orm
    .select()
    .from(contacts)
    .where(eq(contacts.companyId, companyId))
    .orderBy(asc(contacts.name))
    .all();
  return rows.filter((c) => !linked.includes(c.id));
}
