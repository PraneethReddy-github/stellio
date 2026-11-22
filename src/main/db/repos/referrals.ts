import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, ne } from 'drizzle-orm';
import {
  MessageChecksSchema,
  personKey,
  urlKey,
  type Person,
  type PersonSource,
  type ProfileUrl,
  type PublicContact,
  type ReferralItem,
  type ReferralRequest,
  type ValidPerson,
} from '@shared/referrals';
import type { Db } from '../database';
import { people, referralRequests } from '../schema';

export type PersonRow = typeof people.$inferSelect;
export type RequestRow = typeof referralRequests.$inferSelect;

export const toPerson = (r: PersonRow, company: string): Person => ({
  id: r.id,
  fullName: r.fullName,
  title: r.title,
  company,
  companyId: r.companyId,
  locationText: r.locationText,
  country: r.country,
  profileUrls: r.profileUrlsJson as ProfileUrl[],
  publicContact: r.publicContactJson as PublicContact[],
  sources: r.sourcesJson,
  sharedGround: r.sharedGroundJson,
  firstSeenAt: r.firstSeenAt,
  lastSeenAt: r.lastSeenAt,
  purgeAfter: r.purgeAfter,
});

export const toRequest = (r: RequestRow): ReferralRequest => ({
  id: r.id,
  personId: r.personId,
  jobId: r.jobId,
  applicationId: r.applicationId,
  status: r.status,
  why: r.why,
  score: r.score,
  noteText: r.noteText,
  messageSubject: r.messageSubject,
  messageBody: r.messageBody,
  language: r.language,
  checks: MessageChecksSchema.safeParse(r.checksJson).data ?? null,
  rulesHash: r.rulesHash,
  model: r.model,
  promptVersion: r.promptVersion,
  contactedAt: r.contactedAt,
  nextActionAt: r.nextActionAt,
  notesMd: r.notesMd,
  createdAt: r.createdAt,
});

const byUrl = <T extends { url: string }>(a: readonly T[], b: readonly T[]): T[] => {
  const out = new Map<string, T>();
  for (const x of [...a, ...b]) out.set(urlKey(x.url) ?? x.url, x);
  return [...out.values()];
};

/** The company name kept with a person (the companies table is not joined for it). */
const companyName = (db: Db, id: string | null, fallback = ''): string =>
  id
    ? ((db.sqlite.prepare('SELECT name FROM companies WHERE id = ?').get(id) as { name: string } | undefined)
        ?.name ?? fallback)
    : fallback;

export function getPersonRow(db: Db, id: string): PersonRow | undefined {
  return db.orm.select().from(people).where(eq(people.id, id)).get();
}
export const getPerson = (db: Db, id: string): Person | undefined => {
  const r = getPersonRow(db, id);
  return r ? toPerson(r, companyName(db, r.companyId)) : undefined;
};

/**
 * Stores a validated person, or merges into the one already stored (same name + company, or the same profile
 * URL at the same company): sources are merged per page, newest facts win. `purgeAfter` is only set for people
 * who were never contacted.
 */
export function upsertPerson(
  db: Db,
  v: ValidPerson,
  o: { companyId: string; ground: string[]; now: string; purgeAfter: string },
): PersonRow {
  return db.sqlite.transaction(() => {
    const key = personKey(v.fullName, v.company);
    let found = db.orm.select().from(people).where(eq(people.dedupeKey, key)).get();
    if (!found) {
      const mine = new Set(v.profileUrls.map((p) => urlKey(p.url)));
      found = db.orm
        .select()
        .from(people)
        .where(eq(people.companyId, o.companyId))
        .all()
        .find((p) => (p.profileUrlsJson as ProfileUrl[]).some((u) => mine.has(urlKey(u.url))));
    }
    if (!found) {
      return db.orm
        .insert(people)
        .values({
          fullName: v.fullName,
          title: v.title,
          companyId: o.companyId,
          locationText: v.locationText,
          country: v.country,
          profileUrlsJson: v.profileUrls,
          publicContactJson: v.publicContact,
          sourcesJson: v.sources,
          sharedGroundJson: o.ground,
          dedupeKey: key,
          firstSeenAt: o.now,
          lastSeenAt: o.now,
          purgeAfter: o.purgeAfter,
        })
        .returning()
        .get();
    }
    const sources = new Map<string, PersonSource>();
    for (const s of [...found.sourcesJson, ...v.sources]) sources.set(urlKey(s.url) ?? s.url, s);
    const contacts = [...(found.publicContactJson as PublicContact[])];
    for (const c of v.publicContact)
      if (!contacts.some((x) => x.value.toLowerCase() === c.value.toLowerCase())) contacts.push(c);
    return db.orm
      .update(people)
      .set({
        title: v.title || found.title,
        locationText: v.locationText || found.locationText,
        country: v.country ?? found.country,
        profileUrlsJson: byUrl(found.profileUrlsJson as ProfileUrl[], v.profileUrls),
        publicContactJson: contacts,
        sourcesJson: [...sources.values()],
        sharedGroundJson: o.ground,
        lastSeenAt: o.now,
        purgeAfter: found.purgeAfter === null ? null : o.purgeAfter,
      })
      .where(eq(people.id, found.id))
      .returning()
      .get();
  })();
}

export function findRequest(db: Db, personId: string, jobId: string | null): RequestRow | undefined {
  return db.orm
    .select()
    .from(referralRequests)
    .where(
      and(
        eq(referralRequests.personId, personId),
        jobId === null ? isNull(referralRequests.jobId) : eq(referralRequests.jobId, jobId),
      ),
    )
    .get();
}

/** The request for this person and job (created as `not_contacted` on first sight); ranking is refreshed. */
export function upsertRequest(
  db: Db,
  personId: string,
  jobId: string | null,
  rank: { why: string; score: number },
): RequestRow {
  const found = findRequest(db, personId, jobId);
  if (found)
    return db.orm
      .update(referralRequests)
      .set(rank)
      .where(eq(referralRequests.id, found.id))
      .returning()
      .get();
  return db.orm
    .insert(referralRequests)
    .values({ personId, jobId, ...rank })
    .returning()
    .get();
}

export function getRequestRow(db: Db, id: string): RequestRow | undefined {
  return db.orm.select().from(referralRequests).where(eq(referralRequests.id, id)).get();
}

export function updateRequest(
  db: Db,
  id: string,
  patch: Partial<typeof referralRequests.$inferInsert>,
): RequestRow {
  return db.orm.update(referralRequests).set(patch).where(eq(referralRequests.id, id)).returning().get();
}

export function requestsOfPerson(db: Db, personId: string): RequestRow[] {
  return db.orm
    .select()
    .from(referralRequests)
    .where(eq(referralRequests.personId, personId))
    .orderBy(desc(referralRequests.createdAt), asc(referralRequests.id))
    .all();
}

/** Requests with their person, best score first. `jobId` undefined = all jobs. */
export function listItems(db: Db, jobId?: string): ReferralItem[] {
  const rows = db.orm
    .select()
    .from(referralRequests)
    .innerJoin(people, eq(people.id, referralRequests.personId))
    .where(jobId === undefined ? undefined : eq(referralRequests.jobId, jobId))
    .orderBy(desc(referralRequests.score), asc(people.fullName))
    .all();
  const names = new Map<string, string>();
  for (const r of rows) {
    const id = r.people.companyId;
    if (id && !names.has(id)) names.set(id, companyName(db, id));
  }
  return rows.map((r) => ({
    ...toRequest(r.referral_requests),
    person: toPerson(r.people, names.get(r.people.companyId ?? '') ?? ''),
  }));
}

/** Contacted requests whose follow-up date has passed, oldest first. */
export function dueItems(db: Db, nowIso: string): ReferralItem[] {
  return listItems(db)
    .filter((i) => i.status === 'contacted' && i.nextActionAt !== null && i.nextActionAt <= nowIso)
    .sort((a, b) => (a.nextActionAt as string).localeCompare(b.nextActionAt as string));
}

export function itemsByIds(db: Db, ids: readonly string[]): ReferralItem[] {
  if (ids.length === 0) return [];
  const want = new Set(ids);
  return listItems(db).filter((i) => want.has(i.id));
}

export const deletePerson = (db: Db, id: string): boolean =>
  db.orm.delete(people).where(eq(people.id, id)).run().changes > 0;

export const deleteAllPeople = (db: Db): number => db.orm.delete(people).run().changes;

/** True when any request of the person was ever contacted: such people are kept. */
export function wasContacted(db: Db, personId: string): boolean {
  return (
    db.orm
      .select({ id: referralRequests.id })
      .from(referralRequests)
      .where(and(eq(referralRequests.personId, personId), ne(referralRequests.status, 'not_contacted')))
      .get() !== undefined
  );
}

export function setPurgeAfter(db: Db, personId: string, at: string | null): void {
  db.orm.update(people).set({ purgeAfter: at }).where(eq(people.id, personId)).run();
}

/** Deletes people never contacted whose retention ran out. Returns how many. */
export function purgeExpired(db: Db, nowIso: string): number {
  return db.sqlite.transaction(() => {
    const due = db.orm
      .select({ id: people.id })
      .from(people)
      .where(and(isNotNull(people.purgeAfter), lt(people.purgeAfter, nowIso)))
      .all()
      .map((r) => r.id)
      .filter((id) => !wasContacted(db, id));
    if (due.length === 0) return 0;
    return db.orm.delete(people).where(inArray(people.id, due)).run().changes;
  })();
}

/** Re-bases the retention of never-contacted people (retention setting changed). */
export function rebasePurge(db: Db, days: number): void {
  for (const p of db.orm.select().from(people).where(isNotNull(people.purgeAfter)).all())
    setPurgeAfter(db, p.id, new Date(Date.parse(p.lastSeenAt) + days * 86_400_000).toISOString());
}

export const countPeople = (db: Db): number =>
  (db.sqlite.prepare('SELECT count(*) AS n FROM people').get() as { n: number }).n;

/** For tests and diagnostics: every stored contact with its source. */
export const allContacts = (db: Db): PublicContact[] =>
  db.orm
    .select({ c: people.publicContactJson })
    .from(people)
    .all()
    .flatMap((r) => r.c as PublicContact[]);
