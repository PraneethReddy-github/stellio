import { and, desc, eq, isNull, notExists, sql } from 'drizzle-orm';
import {
  DAY_MS,
  OFFER_STATUSES,
  RESPONSE_STATUSES,
  addLocalDays,
  daysSince,
  ghostedCandidate,
  isClosed,
  startOfLocalDay,
  toMs,
  localDateStr,
  type AppStatus,
  type TodaySummary,
} from '@shared/tracker';
import type { Db } from '../../db/database';
import { dueItems } from '../../db/repos/referrals';
import type { Nudge } from '@shared/skills/nudges';
import { shortName } from '../referrals/service';
import { listLearningItems } from '../../db/repos/skills';
import { analyses, applications, companies, jobs, scanRuns } from '../../db/schema';
import { effectiveNext, lastContactAt, loadContexts, type Ctx } from './context';

export interface MissingSkill {
  skill: string;
  jobCount: number;
  share: number;
  requiredShare: number;
}

const GROUPS = [
  { key: 'saved', label: 'Saved', statuses: ['saved'] },
  { key: 'ready', label: 'Ready', statuses: ['ready'] },
  { key: 'applied', label: 'Applied', statuses: ['applied', 'acknowledged'] },
  { key: 'in_process', label: 'In process', statuses: ['screening', 'interviewing', 'assessment'] },
  { key: 'waiting', label: 'Waiting', statuses: ['waiting'] },
  { key: 'offers', label: 'Offers', statuses: ['offer'] },
  { key: 'rejected', label: 'Rejected', statuses: ['rejected'] },
] as const satisfies readonly { key: string; label: string; statuses: readonly AppStatus[] }[];

export const FUNNEL_DAYS = 90;
const WEEKS = 12;
const dayDiff = (from: Date, to: Date): number =>
  Math.round((startOfLocalDay(to).getTime() - startOfLocalDay(from).getTime()) / DAY_MS);
/** A deadline is a date (YYYY-MM-DD) or an instant; either way, which local day it falls on. */
const localDay = (value: string): Date => startOfLocalDay(new Date(toMs(value)));
const everReached = (c: Ctx, set: readonly AppStatus[]): boolean =>
  set.includes(c.app.status) || c.events.some((e) => e.toStatus !== null && set.includes(e.toStatus));

/** Referral follow-ups (contacted a week ago or more) of open applications, as follow-up rows (docs/14 §2). */
export function referralFollowUps(db: Db, open: readonly Ctx[], now: Date) {
  return dueItems(db, now.toISOString()).flatMap((i) => {
    const c = open.find((x) => x.app.id === i.applicationId);
    const at = i.nextActionAt as string;
    return c
      ? [
          {
            applicationId: c.app.id,
            company: c.company,
            role: c.job.title,
            action: `Follow up with ${shortName(i.person.fullName)} about the referral`,
            at,
            overdueDays: Math.floor((now.getTime() - toMs(at)) / DAY_MS),
          },
        ]
      : [];
  });
}

/** Every Today number, computed from the DB (docs/08 §4). `missing` = top missing skills by demand. */
export function computeToday(db: Db, now: Date, missing: MissingSkill[], nudges: Nudge[] = []): TodaySummary {
  const all = loadContexts(db);
  const open = all.filter((c) => !isClosed(c.app.status));

  // 1. status line: applications that entered each group this month vs last month, and how many are there now
  const m0 = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const m1 = new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime();
  const mPrev = new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime();
  const entered = (c: Ctx, statuses: readonly AppStatus[], from: number, to: number): boolean =>
    c.events.some(
      (e) =>
        e.type === 'status_change' &&
        e.toStatus !== null &&
        statuses.includes(e.toStatus) &&
        toMs(e.at) >= from &&
        toMs(e.at) < to,
    );
  const statusLine = GROUPS.map((g) => {
    const count = all.filter((c) => entered(c, g.statuses, m0, m1)).length;
    const previous = all.filter((c) => entered(c, g.statuses, mPrev, m0)).length;
    return {
      key: g.key,
      label: g.label,
      count,
      previous,
      delta: count - previous,
      current: all.filter((c) => (g.statuses as readonly AppStatus[]).includes(c.app.status)).length,
    };
  });

  // 2. needs you
  const ref = (c: Ctx) => ({ applicationId: c.app.id, company: c.company, role: c.job.title });
  const followUps = open
    .map((c) => ({ c, next: effectiveNext(c, now) }))
    .filter(
      (x): x is { c: Ctx; next: { action: string; at: string; suggested: boolean } } =>
        x.next.action !== null && x.next.at !== null && toMs(x.next.at) <= now.getTime(),
    )
    .sort((a, b) => toMs(a.next.at) - toMs(b.next.at))
    .map(({ c, next }) => ({
      ...ref(c),
      action: next.action,
      at: next.at,
      overdueDays: Math.floor((now.getTime() - toMs(next.at)) / DAY_MS),
    }))
    .concat(referralFollowUps(db, open, now))
    .sort((a, b) => toMs(a.at) - toMs(b.at));
  const readyNotSent = open
    .filter((c) => c.app.status === 'ready')
    .map((c) => ({ ...ref(c), daysInStatus: daysSince(c.app.statusChangedAt, now) }))
    .sort((a, b) => b.daysInStatus - a.daysInStatus);
  const deadlines = open
    .filter((c) => ['saved', 'preparing', 'ready'].includes(c.app.status) && c.job.deadlineAt)
    .map((c) => ({
      ...ref(c),
      deadline: c.job.deadlineAt as string,
      daysLeft: dayDiff(now, localDay(c.job.deadlineAt as string)),
    }))
    .filter((d) => d.daysLeft >= 0 && d.daysLeft <= 3)
    .sort((a, b) => a.daysLeft - b.daysLeft);
  const interviewsSoon = open
    .flatMap((c) =>
      c.interviews
        .filter((i) => i.outcome === 'pending' && i.scheduledAt)
        .map((i) => ({ c, i, d: dayDiff(now, new Date(toMs(i.scheduledAt as string))) })),
    )
    .filter((x) => x.d === 0 || x.d === 1)
    .sort((a, b) => toMs(a.i.scheduledAt as string) - toMs(b.i.scheduledAt as string))
    .map(({ c, i, d }) => ({
      ...ref(c),
      interviewId: i.id,
      round: i.round,
      kind: i.kind,
      at: i.scheduledAt as string,
      when: d === 0 ? ('today' as const) : ('tomorrow' as const),
    }));
  const ghosted = open
    .flatMap((c) => {
      const g = ghostedCandidate({ status: c.app.status, lastContactAt: lastContactAt(c, now) }, now);
      return g ? [{ ...ref(c), ...g }] : [];
    })
    .sort((a, b) => b.days - a.days);

  // 3. new matches: inbox jobs without an application, best fit first (full analysis, else the scan's triage)
  const latestTriage = (col: 'fit_score' | 'summary') =>
    sql`(select t.${sql.raw(col)} from analyses t where t.job_id = ${jobs.id} and t.triage = 1 order by t.created_at desc, t.id desc limit 1)`;
  const fitExpr = sql<number | null>`coalesce(${analyses.fitScore}, ${latestTriage('fit_score')})`;
  const newMatches = db.orm
    .select({
      jobId: jobs.id,
      company: companies.name,
      title: jobs.title,
      fit: fitExpr,
      reason: sql<string | null>`coalesce(${analyses.summary}, ${latestTriage('summary')})`,
    })
    .from(jobs)
    .innerJoin(companies, eq(companies.id, jobs.companyId))
    .leftJoin(
      analyses,
      eq(
        analyses.id,
        sql`(select a2.id from analyses a2 where a2.job_id = ${jobs.id} and a2.triage = 0 order by a2.created_at desc, a2.id desc limit 1)`,
      ),
    )
    .where(
      and(
        eq(jobs.state, 'new'),
        isNull(jobs.closedAt),
        notExists(
          db.orm
            .select({ x: sql`1` })
            .from(applications)
            .where(eq(applications.jobId, jobs.id)),
        ),
      ),
    )
    .orderBy(sql`${fitExpr} is null`, desc(fitExpr), desc(jobs.firstSeenAt), jobs.id)
    .limit(5)
    .all();

  // 4. funnel: jobs first seen in the last 90 days, followed through the stages
  const cutoff = now.getTime() - FUNNEL_DAYS * DAY_MS;
  const jobsSeen = db.orm
    .select({ id: jobs.id, firstSeenAt: jobs.firstSeenAt })
    .from(jobs)
    .all()
    .filter((j) => toMs(j.firstSeenAt) >= cutoff && toMs(j.firstSeenAt) <= now.getTime());
  const seen = new Set(jobsSeen.map((j) => j.id));
  const cohort = all.filter((c) => seen.has(c.job.id));
  const applied = cohort.filter((c) => c.app.appliedAt !== null);
  const hadInterview = (c: Ctx): boolean =>
    c.interviews.some((i) => i.outcome !== 'cancelled') || everReached(c, ['interviewing']);
  // An interview implies they answered, so the funnel never grows on the way down.
  const responded = applied.filter((c) => everReached(c, RESPONSE_STATUSES) || hadInterview(c));
  const interviewed = applied.filter(hadInterview);
  const offered = applied.filter((c) => everReached(c, OFFER_STATUSES));
  const counts = [
    jobsSeen.length,
    cohort.length,
    applied.length,
    responded.length,
    interviewed.length,
    offered.length,
  ];
  const stepDefs = [
    ['discovered', 'Discovered'],
    ['shortlisted', 'Shortlisted'],
    ['applied', 'Applied'],
    ['response', 'Response'],
    ['interview', 'Interview'],
    ['offer', 'Offer'],
  ] as const;
  const steps = stepDefs.map(([key, label], i) => {
    const prev = counts[i - 1];
    return { key, label, count: counts[i] as number, conversion: prev ? (counts[i] as number) / prev : null };
  });

  // 5. applications per week, oldest first (weeks start on Monday)
  const today = startOfLocalDay(now);
  const thisWeek = addLocalDays(today, -((today.getDay() + 6) % 7));
  const weekly = Array.from({ length: WEEKS }, (_, k) => {
    const start = addLocalDays(thisWeek, -7 * (WEEKS - 1 - k));
    const end = addLocalDays(start, 7).getTime();
    return {
      weekStart: localDateStr(start),
      count: all.filter(
        (c) =>
          c.app.appliedAt !== null && toMs(c.app.appliedAt) >= start.getTime() && toMs(c.app.appliedAt) < end,
      ).length,
    };
  });

  // 6. skills pulse
  const learning = listLearningItems(db)
    .filter((l) => l.status === 'doing')
    .map((l) => ({ id: l.id, skill: l.skill, priority: l.priority, status: l.status }));

  // 7. last scan
  const scan = db.orm
    .select()
    .from(scanRuns)
    .orderBy(desc(scanRuns.startedAt), desc(scanRuns.id))
    .limit(1)
    .get();

  return {
    generatedAt: now.toISOString(),
    statusLine,
    needsYou: { followUps, readyNotSent, deadlines, interviews: interviewsSoon, ghosted, nudges },
    newMatches,
    funnel: { windowDays: FUNNEL_DAYS, steps },
    weekly,
    skills: { missing: missing.slice(0, 5), learning },
    lastScan: scan
      ? {
          id: scan.id,
          startedAt: scan.startedAt,
          finishedAt: scan.finishedAt,
          trigger: scan.trigger,
          status: scan.status,
          newJobs: scan.newJobs,
          perSource: scan.perSourceJson ?? {},
          error: scan.error,
        }
      : null,
  };
}
