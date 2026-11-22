import { describe, expect, it } from 'vitest';
import { sourcesByJob } from '../../../src/main/db/repos/discovery';
import { companies, jobSources, jobs } from '../../../src/main/db/schema';
import { freshDb } from './helpers';

describe('analyses lookups by job (perf budget: 5,000-job inbox)', () => {
  it('the latest-analysis subquery uses the job index, not a table scan', () => {
    const db = freshDb();
    const plan = db.sqlite
      .prepare(
        `EXPLAIN QUERY PLAN select a.id from analyses a where a.job_id = ? and a.triage = 0
         order by a.created_at desc, a.id desc limit 1`,
      )
      .all('x') as { detail: string }[];
    expect(plan.map((p) => p.detail).join('\n')).toContain('analyses_job_triage_idx');
  });
});

describe('sourcesByJob', () => {
  it('groups distinct sources per job and ignores unknown ids', () => {
    const db = freshDb();
    const c = db.orm.insert(companies).values({ name: 'Acme' }).returning().get();
    const mk = (key: string) =>
      db.orm.insert(jobs).values({ companyId: c.id, title: key, dedupeKey: key }).returning().get();
    const [a, b] = [mk('a'), mk('b')];
    const src = (jobId: string, source: 'arbeitnow' | 'remotive' | 'lever', externalId: string) =>
      db.orm.insert(jobSources).values({ jobId, source, externalId }).run();
    src(a.id, 'arbeitnow', '1');
    src(a.id, 'remotive', '2');
    src(a.id, 'remotive', '3'); // same source twice: listed once
    src(b.id, 'lever', '4');
    const got = sourcesByJob(db, [a.id, b.id, 'missing']);
    expect(got.get(a.id)).toEqual(['arbeitnow', 'remotive']);
    expect(got.get(b.id)).toEqual(['lever']);
    expect(got.has('missing')).toBe(false);
    expect(sourcesByJob(db, []).size).toBe(0);
  });
});
