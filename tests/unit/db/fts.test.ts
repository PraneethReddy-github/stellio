import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { type Db } from '../../../src/main/db/database';
import { companies, jobs } from '../../../src/main/db/schema';
import { freshDb } from './helpers';

function search(db: Db, q: string): string[] {
  const rows = db.sqlite.prepare('SELECT job_id FROM jobs_fts WHERE jobs_fts MATCH ?').all(q) as {
    job_id: string;
  }[];
  return rows.map((r) => r.job_id);
}

function seed(db: Db) {
  const company = db.orm.insert(companies).values({ name: 'Initech' }).returning().get();
  const job = db.orm
    .insert(jobs)
    .values({
      companyId: company.id,
      title: 'Backend Engineer',
      dedupeKey: 'k1',
      descriptionMd: 'Rust and Postgres',
    })
    .returning()
    .get();
  return { company, job };
}

describe('jobs_fts triggers', () => {
  it('indexes title, joined company name and description on insert', () => {
    const db = freshDb();
    const { job } = seed(db);
    expect(search(db, 'backend')).toEqual([job.id]);
    expect(search(db, 'initech')).toEqual([job.id]);
    expect(search(db, 'postgres')).toEqual([job.id]);
  });

  it('re-indexes on update', () => {
    const db = freshDb();
    const { job } = seed(db);
    db.orm
      .update(jobs)
      .set({ title: 'Platform Lead', descriptionMd: 'Kubernetes' })
      .where(eq(jobs.id, job.id))
      .run();
    expect(search(db, 'backend')).toEqual([]);
    expect(search(db, 'kubernetes')).toEqual([job.id]);
    expect(search(db, 'platform')).toEqual([job.id]);
  });

  it('removes the row on delete', () => {
    const db = freshDb();
    const { job } = seed(db);
    db.orm.delete(jobs).where(eq(jobs.id, job.id)).run();
    expect(search(db, 'backend')).toEqual([]);
  });

  it('follows a company rename', () => {
    const db = freshDb();
    const { company, job } = seed(db);
    db.orm.update(companies).set({ name: 'Hooli' }).where(eq(companies.id, company.id)).run();
    expect(search(db, 'initech')).toEqual([]);
    expect(search(db, 'hooli')).toEqual([job.id]);
  });
});
