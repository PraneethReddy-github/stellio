import { DAY_MS, RESPONSE_STATUSES, daysSince, ghostedCandidate, toMs, type AppStatus } from '../tracker';
import { daysBand, fitBand, remoteLabel, roleFamily, seniorityLabel } from './normalize';
import {
  MIN_SAMPLE,
  type Dimension,
  type InsightWindow,
  type InsightsSummary,
  type Segment,
} from './schemas';

/** One sent application with everything the segments need. Built by main from the DB. */
export interface InsightApp {
  appliedAt: string;
  status: AppStatus;
  events: { type: string; toStatus: AppStatus | null; at: string }[];
  interviews: { outcome: string }[];
  /** First source of the job (board name), or null when unknown. */
  source: string | null;
  title: string;
  /** The JD's seniority (`jobs.seniority`), else null. */
  seniority: string | null;
  fit: number | null;
  remote: string;
  postedAt: string | null;
  coverLetter: boolean;
  /** Skills in the skills section of the final resume (empty when there is none). */
  skills: string[];
}

const reached = (a: InsightApp, set: readonly AppStatus[]): boolean =>
  set.includes(a.status) || a.events.some((e) => e.toStatus !== null && set.includes(e.toStatus));

export const hasInterview = (a: InsightApp): boolean =>
  a.interviews.some((i) => i.outcome !== 'cancelled') || reached(a, ['interviewing']);

/** Any reply counts, rejections included; an interview implies a reply (same rule as the Today funnel). */
export const hasResponse = (a: InsightApp): boolean => reached(a, RESPONSE_STATUSES) || hasInterview(a);

/** First sign from the company: an answer status, an interview or a mail event. Null when none is dated. */
export function firstResponseAt(a: InsightApp): string | null {
  const t0 = toMs(a.appliedAt);
  const times = a.events
    .filter(
      (e) =>
        e.type === 'interview' ||
        e.type === 'email' ||
        (e.type === 'status_change' &&
          e.toStatus !== null &&
          (RESPONSE_STATUSES.includes(e.toStatus) || e.toStatus === 'interviewing')),
    )
    .map((e) => e.at)
    .filter((at) => toMs(at) >= t0);
  return times.reduce<string | null>((x, y) => (x === null || toMs(y) < toMs(x) ? y : x), null);
}

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
};

function segment(label: string, apps: readonly InsightApp[]): Segment {
  const responses = apps.filter(hasResponse).length;
  const interviews = apps.filter(hasInterview).length;
  const insufficient = apps.length < MIN_SAMPLE;
  return {
    label,
    applications: apps.length,
    responses,
    interviews,
    responseRate: insufficient ? null : responses / apps.length,
    interviewRate: insufficient ? null : interviews / apps.length,
    insufficient,
  };
}

/** Groups by label. Labels in `order` come first in that order; the rest by size, then name. */
function group(
  apps: readonly InsightApp[],
  labelOf: (a: InsightApp) => string | readonly string[],
  order: readonly string[] = [],
): Segment[] {
  const map = new Map<string, InsightApp[]>();
  for (const a of apps) {
    const labels = labelOf(a);
    for (const l of new Set(typeof labels === 'string' ? [labels] : labels))
      (map.get(l) ?? map.set(l, []).get(l))?.push(a);
  }
  const rank = (l: string): number => (order.includes(l) ? order.indexOf(l) : order.length);
  return [...map.entries()]
    .sort((x, y) => rank(x[0]) - rank(y[0]) || y[1].length - x[1].length || x[0].localeCompare(y[0]))
    .map(([label, list]) => segment(label, list));
}

const FIT_ORDER = ['0-49', '50-69', '70-84', '85+', 'Not scored'];
const DAYS_ORDER = ['0-3 days', '4-7 days', '8-14 days', '15+ days', 'Posting date unknown'];
const SENIORITY_ORDER = ['Intern', 'Junior', 'Mid', 'Senior', 'Staff', 'Lead', 'Manager', 'Director'];
const COVER = ['With cover letter', 'Without cover letter'];
const TOP_SKILLS = 10;

/**
 * Response and interview rates per segment, median time to first response and ghosting rate (docs/08 §5), from
 * the applications that were sent. A segment under `MIN_SAMPLE` applications keeps its counts but gets no rates.
 * `window` keeps applications sent in the last 90 days, or all. Pure.
 */
export function computeInsights(
  all: readonly InsightApp[],
  window: InsightWindow,
  now: Date,
): InsightsSummary {
  const from = window === '90d' ? now.getTime() - 90 * DAY_MS : -Infinity;
  const apps = all.filter((a) => toMs(a.appliedAt) >= from && toMs(a.appliedAt) <= now.getTime());

  const days = apps.flatMap((a) => {
    const at = firstResponseAt(a);
    return at === null ? [] : [Math.round(((toMs(at) - toMs(a.appliedAt)) / DAY_MS) * 10) / 10];
  });
  const mature = apps.filter((a) => a.status === 'ghosted' || daysSince(a.appliedAt, now) >= 30);
  const ghosted = mature.filter(
    (a) =>
      !hasResponse(a) &&
      (a.status === 'ghosted' ||
        ghostedCandidate({ status: a.status, lastContactAt: a.appliedAt }, now) !== null),
  );

  const dimensions: Dimension[] = [
    { key: 'source', title: 'Source', segments: group(apps, (a) => a.source ?? 'Unknown') },
    { key: 'roleFamily', title: 'Role family', segments: group(apps, (a) => roleFamily(a.title)) },
    {
      key: 'seniority',
      title: 'Seniority',
      segments: group(apps, (a) => seniorityLabel(a.seniority, a.title), SENIORITY_ORDER),
    },
    { key: 'fitBand', title: 'Fit score', segments: group(apps, (a) => fitBand(a.fit), FIT_ORDER) },
    { key: 'remote', title: 'Remote type', segments: group(apps, (a) => remoteLabel(a.remote)) },
    {
      key: 'coverLetter',
      title: 'Cover letter',
      segments: group(apps, (a) => (a.coverLetter ? COVER[0] : COVER[1]) as string, COVER),
    },
    {
      key: 'daysSincePosting',
      title: 'Days since posting when applied',
      segments: group(apps, (a) => daysBand(a.postedAt, a.appliedAt), DAYS_ORDER),
    },
    {
      key: 'skills',
      title: 'Skills on the final resume',
      segments: group(apps, (a) => a.skills).slice(0, TOP_SKILLS),
    },
  ];

  return {
    window,
    generatedAt: now.toISOString(),
    minSample: MIN_SAMPLE,
    totals: segment('All applications', apps),
    timeToResponse: { medianDays: median(days), responses: days.length },
    ghosting: {
      eligible: mature.length,
      ghosted: ghosted.length,
      rate: mature.length < MIN_SAMPLE ? null : ghosted.length / mature.length,
      insufficient: mature.length < MIN_SAMPLE,
    },
    dimensions: dimensions.filter((d) => d.segments.length > 0),
  };
}
