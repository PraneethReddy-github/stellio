import { describe, expect, it } from 'vitest';
import { applications, companies, jobSources, jobs } from '../../../src/main/db/schema';
import { freshDb } from './helpers';

function seedJob(db: ReturnType<typeof freshDb>, dedupeKey = 'k1') {
  const c = db.orm.insert(companies).values({ name: 'Initech' }).returning().get();
  return db.orm.insert(jobs).values({ companyId: c.id, title: 'Dev', dedupeKey }).returning().get();
}

describe('constraints', () => {
  it('enforces foreign keys', () => {
    const db = freshDb();
    expect(() =>
      db.orm.insert(jobs).values({ companyId: 'nope', title: 'Dev', dedupeKey: 'x' }).run(),
    ).toThrow(/FOREIGN KEY/);
  });

  it('applies defaults: ULID id, ISO timestamps, enum defaults', () => {
    const db = freshDb();
    const job = seedJob(db);
    expect(job.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(new Date(job.createdAt).toISOString()).toBe(job.createdAt);
    expect(job.state).toBe('new');
  });

  it('rejects duplicate dedupe_key', () => {
    const db = freshDb();
    const job = seedJob(db);
    expect(() =>
      db.orm.insert(jobs).values({ companyId: job.companyId, title: 'Dev 2', dedupeKey: 'k1' }).run(),
    ).toThrow(/UNIQUE/);
  });

  it('rejects duplicate (source, external_id)', () => {
    const db = freshDb();
    const job = seedJob(db);
    const row = { jobId: job.id, source: 'adzuna', externalId: '42' } as const;
    db.orm.insert(jobSources).values(row).run();
    expect(() => db.orm.insert(jobSources).values(row).run()).toThrow(/UNIQUE/);
  });

  it('allows one application per job', () => {
    const db = freshDb();
    const job = seedJob(db);
    db.orm.insert(applications).values({ jobId: job.id }).run();
    expect(() => db.orm.insert(applications).values({ jobId: job.id }).run()).toThrow(/UNIQUE/);
  });

  it('round-trips JSON columns', () => {
    const db = freshDb();
    const job = seedJob(db);
    db.orm
      .insert(jobSources)
      .values({ jobId: job.id, source: 'manual', externalId: '1', rawJson: { a: [1, 2] } })
      .run();
    const row = db.orm.select().from(jobSources).get();
    expect(row?.rawJson).toEqual({ a: [1, 2] });
  });
});
