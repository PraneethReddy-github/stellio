import { describe, expect, it } from 'vitest';
import { AI_RUN_STATUSES as SHARED_RUN_STATUSES } from '../../../src/shared/ai/runs';
import { JOB_STATES, REMOTE_KINDS } from '../../../src/shared/jobs/schemas';
import * as schema from '../../../src/main/db/schema';
import {
  createJob,
  deleteJob,
  findJobByDedupeKey,
  findJobByHash,
  getJobSummary,
  insertAnalysis,
  latestAnalysis,
  listJobSources,
  listJobs,
  setJobState,
  upsertCompanyByName,
} from '../../../src/main/db/repos/jobs';
import { freshDb } from './helpers';

const job = (n: number, extra: object = {}) => ({
  title: `Role ${String(n)}`,
  remote: 'unknown' as const,
  descriptionMd: `desc ${String(n)}`,
  descriptionHash: `hash${String(n)}`,
  dedupeKey: `acme|role ${String(n)}|`,
  ...extra,
});

describe('shared enums mirror the DB schema', () => {
  it('match', () => {
    expect([...REMOTE_KINDS]).toEqual([...schema.REMOTE_KINDS]);
    expect([...JOB_STATES]).toEqual([...schema.JOB_STATES]);
    expect([...SHARED_RUN_STATUSES]).toEqual([...schema.AI_RUN_STATUSES]);
  });
});

describe('companies', () => {
  it('upserts by case-insensitive name', () => {
    const db = freshDb();
    const a = upsertCompanyByName(db, 'Acme GmbH');
    expect(upsertCompanyByName(db, ' acme gmbh ').id).toBe(a.id);
    expect(upsertCompanyByName(db, 'Other').id).not.toBe(a.id);
  });
});

describe('jobs repo', () => {
  it('creates job + company + source, finds by key and hash', () => {
    const db = freshDb();
    const j = createJob(db, 'Acme', job(1), {
      source: 'manual',
      externalId: 'hash:1',
      url: 'https://x.test/1',
      rawJson: null,
    });
    expect(findJobByDedupeKey(db, 'acme|role 1|')?.id).toBe(j.id);
    expect(findJobByHash(db, 'hash1')?.id).toBe(j.id);
    expect(findJobByHash(db, 'nope')).toBeUndefined();
    expect(listJobSources(db, j.id)).toHaveLength(1);
    expect(getJobSummary(db, j.id)).toMatchObject({
      company: 'Acme',
      title: 'Role 1',
      state: 'new',
      fitScore: null,
      verdict: null,
    });
  });

  it('enforces a unique dedupe key and rolls the transaction back', () => {
    const db = freshDb();
    createJob(db, 'Acme', job(1));
    expect(() => createJob(db, 'Brand New Co', job(2, { dedupeKey: 'acme|role 1|' }))).toThrow(/UNIQUE/);
    expect(upsertCompanyByName(db, 'Brand New Co').name).toBe('Brand New Co');
    expect(db.sqlite.prepare('select count(*) n from companies').get()).toEqual({ n: 2 }); // Acme + the one just upserted
  });

  it('ignores a duplicate (source, external_id)', () => {
    const db = freshDb();
    const src = { source: 'manual' as const, externalId: 'same', url: null, rawJson: null };
    createJob(db, 'Acme', job(1), src);
    createJob(db, 'Acme', job(2), src);
    expect(db.sqlite.prepare('select count(*) n from job_sources').get()).toEqual({ n: 1 });
  });

  it('lists newest first with paging, state filter and total', () => {
    const db = freshDb();
    for (let i = 1; i <= 5; i++)
      createJob(
        db,
        'Acme',
        job(i, {
          firstSeenAt: `2026-11-0${String(i)}T00:00:00.000Z`,
          ...(i === 2 ? { state: 'dismissed' } : {}),
        }),
      );
    const page = listJobs(db, { limit: 2, offset: 0 });
    expect(page.total).toBe(5);
    expect(page.items.map((r) => r.title)).toEqual(['Role 5', 'Role 4']);
    expect(listJobs(db, { limit: 2, offset: 4 }).items.map((r) => r.title)).toEqual(['Role 1']);
    expect(listJobs(db, { limit: 10, offset: 0, state: 'dismissed' })).toMatchObject({
      total: 1,
      items: [{ title: 'Role 2' }],
    });
  });

  it('sets state; deleting cascades to sources, analyses and FTS', () => {
    const db = freshDb();
    const j = createJob(db, 'Acme', job(1), { source: 'manual', externalId: 'e', url: null, rawJson: null });
    insertAnalysis(db, {
      jobId: j.id,
      profileHash: 'p',
      model: 'm',
      promptVersion: 'v1',
      fitScore: 80,
      verdict: 'apply',
      summary: 's',
      resultJson: {},
      triage: false,
    });
    expect(setJobState(db, j.id, 'shortlisted')).toBe(true);
    expect(setJobState(db, 'missing', 'new')).toBe(false);
    expect(getJobSummary(db, j.id)?.state).toBe('shortlisted');
    expect(deleteJob(db, j.id)).toBe(true);
    expect(deleteJob(db, j.id)).toBe(false);
    for (const t of ['job_sources', 'analyses', 'jobs_fts'])
      expect(db.sqlite.prepare(`select count(*) n from ${t}`).get(), t).toEqual({ n: 0 });
  });
});

describe('analyses', () => {
  it('latest full analysis wins; triage rows are ignored; summary shows the latest score', () => {
    const db = freshDb();
    const j = createJob(db, 'Acme', job(1));
    const base = { jobId: j.id, profileHash: 'p', model: 'm', promptVersion: 'v1', resultJson: {} };
    insertAnalysis(db, {
      ...base,
      fitScore: 40,
      verdict: 'skip',
      summary: 'old',
      triage: false,
      createdAt: '2026-11-01T00:00:00.000Z',
    });
    insertAnalysis(db, {
      ...base,
      fitScore: 82,
      verdict: 'apply',
      summary: 'new',
      triage: false,
      createdAt: '2026-11-02T00:00:00.000Z',
    });
    insertAnalysis(db, {
      ...base,
      fitScore: 5,
      verdict: 'skip',
      summary: 'triage',
      triage: true,
      createdAt: '2026-11-03T00:00:00.000Z',
    });
    expect(latestAnalysis(db, j.id)?.summary).toBe('new');
    expect(getJobSummary(db, j.id)).toMatchObject({ fitScore: 82, verdict: 'apply' });
    expect(latestAnalysis(db, 'none')).toBeUndefined();
  });
});
