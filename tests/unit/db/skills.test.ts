import { describe, expect, it } from 'vitest';
import * as schema from '../../../src/main/db/schema';
import { createJob, deleteJob } from '../../../src/main/db/repos/jobs';
import {
  countLearnJobs,
  demandMap,
  findLearningItem,
  getAuditWording,
  insertLearningItem,
  listAuditRows,
  listLearningItems,
  recomputeSkillDemand,
  setAuditDecision,
  setAuditWording,
  updateLearningItem,
  upsertAuditRows,
} from '../../../src/main/db/repos/skills';
import { insertDocumentVersion } from '../../../src/main/db/repos/documents';
import type { Jd } from '../../../src/shared/jobs/schemas';
import {
  DEMAND_WINDOWS,
  JD_IMPORTANCE,
  LEARNING_STATUSES,
  SKILL_DECISIONS,
  SKILL_ORIGINS,
  type SkillAuditRow,
} from '../../../src/shared/skills/schemas';
import { sampleJd } from '../../fixtures/jobs';
import { freshDb } from './helpers';

const NOW = new Date('2026-11-20T12:00:00Z');
const daysAgo = (n: number): string => new Date(NOW.getTime() - n * 86_400_000).toISOString();
const jd = (kind: 'required' | 'preferred', ...skills: string[]): Jd => ({
  ...sampleJd,
  requirements: [{ text: skills.join(', '), kind, skills }],
});
let n = 0;
const addJob = (db: ReturnType<typeof freshDb>, structured: unknown, postedAt: string | null) =>
  createJob(db, 'Acme', {
    title: `Role ${String(++n)}`,
    remote: 'unknown',
    descriptionMd: 'd',
    descriptionHash: `h${String(n)}`,
    dedupeKey: `acme|${String(n)}`,
    structuredJson: structured,
    postedAt,
  });

describe('shared skill enums mirror the DB schema', () => {
  it('match', () => {
    expect([...SKILL_ORIGINS]).toEqual([...schema.SKILL_ORIGINS]);
    expect([...JD_IMPORTANCE]).toEqual([...schema.JD_IMPORTANCE]);
    expect([...SKILL_DECISIONS]).toEqual([...schema.SKILL_DECISIONS]);
    expect([...DEMAND_WINDOWS]).toEqual([...schema.DEMAND_WINDOWS]);
    expect([...LEARNING_STATUSES]).toEqual([...schema.LEARNING_STATUSES]);
  });
});

describe('recomputeSkillDemand', () => {
  it('stores all three windows from the stored jobs and replaces the old rows', () => {
    const db = freshDb();
    const a = addJob(db, jd('required', 'Python', 'SQL'), daysAgo(3));
    addJob(db, jd('preferred', 'Python'), daysAgo(50));
    addJob(db, jd('required', 'Go'), daysAgo(300));
    addJob(db, { not: 'a jd' }, daysAgo(1)); // unparseable: ignored
    addJob(db, null, null); // never parsed: ignored
    recomputeSkillDemand(db, NOW);
    expect(demandMap(db, '30d').get('python')).toMatchObject({ jobCount: 1, share: 1, requiredShare: 1 });
    expect(demandMap(db, '90d').get('python')).toMatchObject({ jobCount: 2, share: 1, requiredShare: 0.5 });
    expect(demandMap(db, 'all').get('python')).toMatchObject({ jobCount: 2, share: 2 / 3 });
    expect(demandMap(db, 'all').get('go')).toMatchObject({ jobCount: 1, requiredShare: 1 / 3 });
    expect(demandMap(db, '90d').has('go')).toBe(false);

    deleteJob(db, a.id);
    recomputeSkillDemand(db, NOW);
    expect(demandMap(db, '90d').has('sql')).toBe(false);
    expect(demandMap(db, '90d').get('python')).toMatchObject({ jobCount: 1, requiredShare: 0 });
    recomputeSkillDemand(db, NOW); // idempotent
    expect(db.sqlite.prepare('select count(*) as c from skill_demand').get()).toEqual({ c: 3 });
  });

  it('is empty without jobs', () => {
    const db = freshDb();
    recomputeSkillDemand(db, NOW);
    expect(db.sqlite.prepare('select count(*) as c from skill_demand').get()).toEqual({ c: 0 });
  });
});

const auditRow = (over: Partial<SkillAuditRow> = {}): SkillAuditRow => ({
  skill: 'Python',
  origin: 'profile_have',
  onResume: true,
  jdImportance: 'required',
  evidenceIds: ['exp-globex'],
  strength: 'high',
  recommendation: 'emphasize',
  decision: 'pending',
  demand: null,
  adjacentTo: null,
  rationale: null,
  learnEstimateHours: null,
  ...over,
});

describe('skill audit rows', () => {
  const doc = (db: ReturnType<typeof freshDb>, jobId: string) =>
    insertDocumentVersion(db, {
      jobId,
      kind: 'resume',
      tex: 't',
      truthReportJson: null,
      atsReportJson: null,
      userEdited: false,
    });
  const setup = () => {
    const db = freshDb();
    const job = addJob(db, jd('required', 'Python'), null);
    return { db, doc: doc(db, job.id) };
  };

  it('keeps one row per (document, skill), stores emphasize/ask_have as their actions, keeps decisions', () => {
    const { db, doc } = setup();
    upsertAuditRows(db, doc.id, [
      auditRow(),
      auditRow({ skill: 'Amazon Redshift', origin: 'jd_only', recommendation: 'ask_have' }),
    ]);
    setAuditDecision(db, doc.id, 'python', 'kept', {
      origin: 'profile_have',
      jdImportance: 'required',
      recommendation: 'keep',
    });
    const rows = upsertAuditRows(db, doc.id, [auditRow({ rationale: 'Because.' })]);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.skill === 'Python')).toMatchObject({
      recommendation: 'keep',
      decision: 'kept',
      rationale: 'Because.',
      evidenceIds: ['exp-globex'],
    });
    expect(rows.find((r) => r.skill === 'Amazon Redshift')?.recommendation).toBe('add_to_profile');
  });

  it('a decision on a skill the audit never listed inserts a row', () => {
    const { db, doc } = setup();
    setAuditDecision(db, doc.id, 'dbt', 'added', {
      origin: 'unlisted_confirmed',
      jdImportance: 'absent',
      recommendation: 'add_to_profile',
    });
    expect(listAuditRows(db, doc.id)).toMatchObject([{ skill: 'dbt', decision: 'added' }]);
  });

  it('caches wording per document and ignores a broken cache entry', () => {
    const { db, doc } = setup();
    expect(getAuditWording(db, doc.id)).toBeNull();
    setAuditWording(db, doc.id, { dbt: { rationale: 'x', learnEstimateHours: 20 } });
    expect(getAuditWording(db, doc.id)).toEqual({ dbt: { rationale: 'x', learnEstimateHours: 20 } });
    db.sqlite.prepare('update settings_kv set value_json = \'"junk"\'').run();
    expect(getAuditWording(db, doc.id)).toBeNull();
  });

  it('counts the distinct jobs whose audit decision is "learn"', () => {
    const { db, doc: doc1 } = setup();
    const doc2 = doc(db, addJob(db, jd('required', 'Python'), null).id);
    const f = { origin: 'jd_only', jdImportance: 'required', recommendation: 'learn' } as const;
    setAuditDecision(db, doc1.id, 'dbt', 'learning', f);
    setAuditDecision(db, doc2.id, 'DBT', 'learning', f);
    setAuditDecision(db, doc2.id, 'Rust', 'learning', f);
    expect(countLearnJobs(db, 'dbt')).toBe(2);
    expect(countLearnJobs(db, 'Rust')).toBe(1);
    expect(countLearnJobs(db, 'Go')).toBe(0);
  });
});

describe('learning items', () => {
  it('insert, find case-insensitively, update, and order active items first by priority', () => {
    const db = freshDb();
    insertLearningItem(db, 'dbt', { priority: 2 });
    const k = insertLearningItem(db, 'Kubernetes', { priority: 5, estHours: 40 });
    const d = insertLearningItem(db, 'Docker', { priority: 4 });
    updateLearningItem(db, d.id, { status: 'done', completedAt: 'now' });
    updateLearningItem(db, k.id, { status: 'doing' });
    expect(findLearningItem(db, 'DBT')?.skill).toBe('dbt');
    expect(findLearningItem(db, 'nope')).toBeUndefined();
    expect(listLearningItems(db).map((l) => `${l.skill}:${l.status}`)).toEqual([
      'Kubernetes:doing',
      'dbt:todo',
      'Docker:done',
    ]);
    expect(updateLearningItem(db, 'missing', { priority: 1 })).toBeUndefined();
  });
});
