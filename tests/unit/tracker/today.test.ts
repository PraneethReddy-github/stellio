import { describe, expect, it } from 'vitest';
import { appendEvent } from '../../../src/main/db/repos/applications';
import { createJob, insertAnalysis } from '../../../src/main/db/repos/jobs';
import { applications, interviews, learningItems, scanRuns } from '../../../src/main/db/schema';
import type { Db } from '../../../src/main/db/database';
import { computeToday } from '../../../src/main/services/tracker/today';
import { freshDb } from '../db/helpers';

/** Local time, so the numbers do not depend on the machine's time zone. */
const at = (m: number, d: number, h = 10): string => new Date(2026, m - 1, d, h).toISOString();
const NOW = new Date(2026, 10, 20, 12); // Friday 2026-11-20 12:00; the week starts Monday 11-16

type Status = typeof applications.$inferInsert.status;
let n = 0;
function job(
  db: Db,
  company: string,
  title: string,
  firstSeen: string,
  extra: { state?: 'new' | 'shortlisted' | 'dismissed'; deadlineAt?: string } = {},
) {
  return createJob(db, company, {
    title,
    dedupeKey: `k${String(n++)}`,
    firstSeenAt: firstSeen,
    state: extra.state ?? 'shortlisted',
    deadlineAt: extra.deadlineAt ?? null,
  });
}
function app(
  db: Db,
  jobId: string,
  status: Status,
  statusChangedAt: string,
  events: [Status, string, Record<string, unknown>?][],
  extra: Partial<typeof applications.$inferInsert> = {},
) {
  const row = db.orm
    .insert(applications)
    .values({ jobId, status, statusChangedAt, ...extra })
    .returning()
    .get();
  for (const [to, when, payload] of events)
    appendEvent(db, row.id, 'status_change', payload ?? {}, when, { to });
  return row;
}
const interview = (
  db: Db,
  applicationId: string,
  round: number,
  scheduledAt: string,
  outcome: 'pending' | 'passed' | 'cancelled',
) => db.orm.insert(interviews).values({ applicationId, round, scheduledAt, outcome, kind: 'screen' }).run();

function fixture(): Db {
  const db = freshDb();
  // A: applied this month, interview today
  const a = app(
    db,
    job(db, 'Acme', 'Data Engineer', at(10, 1)).id,
    'applied',
    at(11, 10),
    [
      ['saved', at(10, 5)],
      ['ready', at(11, 9)],
      ['applied', at(11, 10)],
    ],
    { appliedAt: at(11, 10) },
  );
  interview(db, a.id, 1, at(11, 20, 15), 'pending');
  // B: interviewing, round 1 held on 11-05, round 2 tomorrow
  const b = app(
    db,
    job(db, 'Beta', 'Backend Engineer', at(9, 1)).id,
    'interviewing',
    at(11, 3),
    [
      ['saved', at(9, 5)],
      ['applied', at(10, 20)],
      ['screening', at(10, 25)],
      ['interviewing', at(11, 3)],
    ],
    { appliedAt: at(10, 20) },
  );
  interview(db, b.id, 1, at(11, 5), 'passed');
  interview(db, b.id, 2, at(11, 21), 'pending');
  // C: applied in August, silent since (ghost candidate); discovered before the 90-day window
  app(
    db,
    job(db, 'Cyan', 'Cloud Engineer', at(7, 1)).id,
    'applied',
    at(8, 1),
    [
      ['saved', at(7, 5)],
      ['applied', at(8, 1)],
    ],
    { appliedAt: at(8, 1) },
  );
  // D: ready, deadline in 2 days
  app(
    db,
    job(db, 'Delta', 'Designer', at(11, 15), { deadlineAt: '2026-11-22' }).id,
    'ready',
    at(11, 18, 12),
    [
      ['saved', at(11, 16)],
      ['ready', at(11, 18)],
    ],
  );
  // E: saved with a manual next action due today; deadline is far away
  app(
    db,
    job(db, 'Echo', 'ML Engineer', at(10, 20), { deadlineAt: '2026-11-30' }).id,
    'saved',
    at(10, 28),
    [['saved', at(10, 28)]],
    { nextAction: 'Email recruiter', nextActionAt: at(11, 20, 9) },
  );
  // F: rejected this month
  app(
    db,
    job(db, 'Fox', 'Frontend Engineer', at(10, 10)).id,
    'rejected',
    at(11, 2),
    [
      ['saved', at(10, 11)],
      ['applied', at(10, 12)],
      ['rejected', at(11, 2), { stage: 'before_interview' }],
    ],
    { appliedAt: at(10, 12) },
  );
  // G: offer with a deadline
  const g = app(
    db,
    job(db, 'Gamma', 'Go Engineer', at(10, 15)).id,
    'offer',
    at(11, 12),
    [
      ['saved', at(10, 16)],
      ['applied', at(10, 20)],
      ['screening', at(10, 27)],
      ['interviewing', at(11, 1)],
      ['offer', at(11, 12), { deadline: '2026-11-25' }],
    ],
    { appliedAt: at(10, 20) },
  );
  interview(db, g.id, 1, at(10, 30), 'passed');
  // inbox: best fit first, no analysis last; dismissed and shortlisted jobs stay out
  const hotel = job(db, 'Hotel', 'Ops', at(11, 19), { state: 'new' });
  insertAnalysis(db, {
    jobId: hotel.id,
    profileHash: 'h',
    model: 'm',
    promptVersion: 'v1',
    fitScore: 70,
    summary: 'Decent.',
  });
  const india = job(db, 'India', 'Ops 2', at(11, 10), { state: 'new' });
  insertAnalysis(db, {
    jobId: india.id,
    profileHash: 'h',
    model: 'm',
    promptVersion: 'v1',
    fitScore: 90,
    summary: 'Strong.',
  });
  job(db, 'Juliet', 'Ops 3', at(11, 20), { state: 'new' });
  job(db, 'Kilo', 'Ops 4', at(11, 20), { state: 'dismissed' });
  db.orm
    .insert(learningItems)
    .values([
      { skill: 'dbt', status: 'doing' },
      { skill: 'Rust', status: 'todo' },
    ])
    .run();
  db.orm
    .insert(scanRuns)
    .values([
      { trigger: 'manual', startedAt: at(11, 18), status: 'ok', newJobs: 3 },
      {
        trigger: 'schedule',
        startedAt: at(11, 19),
        finishedAt: at(11, 19, 11),
        status: 'partial',
        newJobs: 5,
        perSourceJson: { adzuna: { fetched: 20, new: 5, errors: ['x'] } },
      },
    ])
    .run();
  return db;
}
const missing = ['a', 'b', 'c', 'd', 'e', 'f'].map((skill, i) => ({
  skill,
  jobCount: 10 - i,
  share: 0.5,
  requiredShare: 0.2,
}));

describe('today:summary on a hand-computed fixture (now = Fri 2026-11-20 12:00)', () => {
  const t = computeToday(fixture(), NOW, missing);

  it('status line: entered this month vs last month, and current', () => {
    const row = (k: string) => t.statusLine.find((s) => s.key === k);
    expect(t.statusLine.map((s) => s.key)).toEqual([
      'saved',
      'ready',
      'applied',
      'in_process',
      'waiting',
      'offers',
      'rejected',
    ]);
    expect(row('saved')).toMatchObject({ count: 1, previous: 4, delta: -3, current: 1 });
    expect(row('ready')).toMatchObject({ count: 2, previous: 0, delta: 2, current: 1 });
    expect(row('applied')).toMatchObject({ count: 1, previous: 3, delta: -2, current: 2 });
    expect(row('in_process')).toMatchObject({ count: 2, previous: 2, delta: 0, current: 1 });
    expect(row('waiting')).toMatchObject({ count: 0, previous: 0, delta: 0, current: 0 });
    expect(row('offers')).toMatchObject({ count: 1, previous: 0, delta: 1, current: 1 });
    expect(row('rejected')).toMatchObject({ count: 1, previous: 0, delta: 1, current: 1 });
  });

  it('needs you: follow-ups, ready, deadlines, interviews, ghosted', () => {
    const k = t.needsYou;
    // oldest first: C 08-08 (104 days), B thank-you 11-06 (14), A 11-17 (3), E manual today 09:00 (0)
    expect(k.followUps.map((f) => [f.company, f.action, f.overdueDays])).toEqual([
      ['Cyan', 'Follow up', 104],
      ['Beta', 'Send a thank-you note', 14],
      ['Acme', 'Follow up', 3],
      ['Echo', 'Email recruiter', 0],
    ]);
    expect(k.readyNotSent.map((r) => [r.company, r.daysInStatus])).toEqual([['Delta', 2]]);
    expect(k.deadlines.map((d) => [d.company, d.daysLeft])).toEqual([['Delta', 2]]);
    expect(k.interviews.map((i) => [i.company, i.round, i.when])).toEqual([
      ['Acme', 1, 'today'],
      ['Beta', 2, 'tomorrow'],
    ]);
    expect(k.ghosted.map((g) => [g.company, g.days])).toEqual([['Cyan', 111]]);
  });

  it('new matches: inbox jobs by fit, unscored last, max 5', () => {
    expect(t.newMatches.map((m) => [m.company, m.fit, m.reason])).toEqual([
      ['India', 90, 'Strong.'],
      ['Hotel', 70, 'Decent.'],
      ['Juliet', null, null],
    ]);
  });

  it('funnel (jobs first seen in the last 90 days)', () => {
    // discovered 10 (all but Cyan); shortlisted 6; applied A,B,F,G = 4; response 4 (A has an interview); interview A,B,G = 3; offer G = 1
    expect(t.funnel.windowDays).toBe(90);
    expect(t.funnel.steps.map((s) => [s.key, s.count])).toEqual([
      ['discovered', 10],
      ['shortlisted', 6],
      ['applied', 4],
      ['response', 4],
      ['interview', 3],
      ['offer', 1],
    ]);
    expect(t.funnel.steps.map((s) => s.conversion)).toEqual([null, 6 / 10, 4 / 6, 4 / 4, 3 / 4, 1 / 3]);
  });

  it('applications per week for 12 weeks, oldest first', () => {
    expect(t.weekly).toHaveLength(12);
    expect(t.weekly[0]?.weekStart).toBe('2026-08-31');
    expect(t.weekly[11]?.weekStart).toBe('2026-11-16');
    expect(
      Object.fromEntries(t.weekly.filter((w) => w.count > 0).map((w) => [w.weekStart, w.count])),
    ).toEqual({
      '2026-10-12': 1, // F
      '2026-10-19': 2, // B, G
      '2026-11-09': 1, // A
    });
  });

  it('skills pulse and last scan', () => {
    expect(t.skills.missing.map((s) => s.skill)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(t.skills.learning.map((l) => l.skill)).toEqual(['dbt']);
    expect(t.lastScan).toMatchObject({
      trigger: 'schedule',
      status: 'partial',
      newJobs: 5,
      perSource: { adzuna: { fetched: 20, new: 5, errors: ['x'] } },
    });
  });

  it('is empty and honest on a fresh database', () => {
    const e = computeToday(freshDb(), NOW, []);
    expect(e.newMatches).toEqual([]);
    expect(e.lastScan).toBeNull();
    expect(e.funnel.steps.map((s) => s.count)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(e.funnel.steps.map((s) => s.conversion)).toEqual([null, null, null, null, null, null]);
    expect(e.weekly.every((w) => w.count === 0)).toBe(true);
    expect(e.needsYou.followUps).toEqual([]);
  });
});
