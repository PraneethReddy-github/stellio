// Pure tracker rules (docs/08 §1-2): statuses, lanes, status metadata, follow-ups, ghosting, slugs, local dates.

/** Mirror of APPLICATION_STATUSES in src/main/db/schema.ts (a unit test keeps them equal). */
export const APPLICATION_STATUSES = [
  'saved',
  'preparing',
  'ready',
  'applied',
  'acknowledged',
  'screening',
  'interviewing',
  'assessment',
  'offer',
  'waiting',
  'accepted',
  'declined',
  'rejected',
  'withdrawn',
  'ghosted',
  'not_applying',
] as const;
export type AppStatus = (typeof APPLICATION_STATUSES)[number];

export const LANES = [
  { id: 'not_applied', label: 'Not applied', statuses: ['saved', 'preparing', 'ready'] },
  { id: 'applied', label: 'Applied', statuses: ['applied', 'acknowledged'] },
  {
    id: 'in_process',
    label: 'In process',
    statuses: ['screening', 'interviewing', 'assessment', 'offer'],
  },
  { id: 'waiting', label: 'Waiting', statuses: ['waiting'] },
  {
    id: 'closed',
    label: 'Closed',
    statuses: ['accepted', 'declined', 'rejected', 'withdrawn', 'ghosted', 'not_applying'],
  },
] as const satisfies readonly { id: string; label: string; statuses: readonly AppStatus[] }[];

export const CLOSED_STATUSES: readonly AppStatus[] = LANES[4].statuses;
export const isClosed = (s: AppStatus): boolean => CLOSED_STATUSES.includes(s);
/** Statuses where the company has the ball (candidates for ghosting). */
const AWAITING: readonly AppStatus[] = [
  'applied',
  'acknowledged',
  'screening',
  'interviewing',
  'assessment',
  'waiting',
];
/** Statuses that mean the company answered at some point (the funnel's "response"). */
export const RESPONSE_STATUSES: readonly AppStatus[] = [
  'acknowledged',
  'screening',
  'interviewing',
  'assessment',
  'offer',
  'accepted',
  'declined',
  'rejected',
];
export const OFFER_STATUSES: readonly AppStatus[] = ['offer', 'accepted', 'declined'];

export const REJECT_STAGES = ['before_interview', 'after_interview'] as const;
export type RejectStage = (typeof REJECT_STAGES)[number];

/** Metadata that rides along with a status change. Stored as the event payload. */
export interface StatusMeta {
  /** Required for rejected and ghosted. */
  stage?: RejectStage | undefined;
  /** Required for not_applying. */
  reason?: string | undefined;
  note?: string | undefined;
  /** Offer: respond-by date (YYYY-MM-DD or ISO). */
  deadline?: string | undefined;
  /** applied without a final resume; needs `forceReason`. */
  force?: boolean | undefined;
  forceReason?: string | undefined;
}

/** A readable problem with the metadata for this change, or null when it is fine. Any transition is allowed. */
export function statusMetaProblem(to: AppStatus, meta: StatusMeta = {}): string | null {
  if ((to === 'rejected' || to === 'ghosted') && !meta.stage)
    return `Say at which stage it was ${to === 'rejected' ? 'rejected' : 'ghosted'}: before or after an interview.`;
  if (to === 'not_applying' && !meta.reason?.trim()) return 'Give a reason for not applying.';
  if (meta.force && !meta.forceReason?.trim()) return 'Applying without a final resume needs a reason.';
  return null;
}

// ---- dates (local time: the user's day, not UTC) -----------------------------------------------------------

export const DAY_MS = 86_400_000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Parses an ISO datetime, or a date-only string as local midnight. NaN when invalid. */
export function toMs(value: string): number {
  if (DATE_ONLY.test(value)) {
    const [y, m, d] = value.split('-').map(Number) as [number, number, number];
    return new Date(y, m - 1, d).getTime();
  }
  return Date.parse(value);
}
export const startOfLocalDay = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate());
export const addLocalDays = (d: Date, n: number): Date =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes(), d.getSeconds());
const pad = (n: number): string => String(n).padStart(2, '0');
export const localDateStr = (d: Date): string =>
  `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** Whole days from `fromIso` to `now` (floor; never negative). */
export const daysSince = (fromIso: string, now: Date): number =>
  Math.max(0, Math.floor((now.getTime() - toMs(fromIso)) / DAY_MS));

// ---- follow-ups --------------------------------------------------------------------------------------------

export interface History {
  appliedAt: string | null;
  /** `follow_up` events (a follow-up or thank-you the user logged). */
  followUps: string[];
  interviews: { scheduledAt: string | null; outcome: 'pending' | 'passed' | 'failed' | 'cancelled' }[];
  /** Respond-by date of the latest offer. */
  offerDeadline: string | null;
}
export interface NextAction {
  action: string;
  at: string;
}
export const FOLLOW_UP_DAYS = 7;
export const GHOST_DAYS = 30;

const plusDays = (iso: string, n: number): string => new Date(toMs(iso) + n * DAY_MS).toISOString();
const latest = (isos: string[]): string | null =>
  isos.reduce<string | null>((a, b) => (!a || toMs(b) > toMs(a) ? b : a), null);

/** Follow-up rules, docs/08 §2. Null when nothing is suggested. */
export function nextActionFor(status: AppStatus, h: History, now: Date): NextAction | null {
  if (status === 'offer')
    return h.offerDeadline ? { action: 'Respond to the offer', at: h.offerDeadline } : null;
  if (status === 'applied' && h.appliedAt) {
    const anchor = latest([h.appliedAt, ...h.followUps]) ?? h.appliedAt;
    return { action: 'Follow up', at: plusDays(anchor, FOLLOW_UP_DAYS) };
  }
  if (!isClosed(status) && AWAITING.includes(status)) {
    // Thank-you: one day after the latest interview that already happened, unless a follow-up was logged since.
    const past = h.interviews
      .filter(
        (i) => i.outcome !== 'cancelled' && i.scheduledAt !== null && toMs(i.scheduledAt) <= now.getTime(),
      )
      .map((i) => i.scheduledAt as string);
    const last = latest(past);
    if (last && !h.followUps.some((f) => toMs(f) >= toMs(last)))
      return { action: 'Send a thank-you note', at: plusDays(last, 1) };
  }
  return null;
}

export interface GhostInput {
  status: AppStatus;
  /** The last time the company was in touch (or the application date). */
  lastContactAt: string | null;
}
/** Suggests ghosted when an awaiting application has had no contact for `days`. The user confirms. */
export function ghostedCandidate(
  app: GhostInput,
  now: Date,
  days = GHOST_DAYS,
): { since: string; days: number } | null {
  if (!AWAITING.includes(app.status) || !app.lastContactAt) return null;
  const d = daysSince(app.lastContactAt, now);
  return d >= days ? { since: app.lastContactAt, days: d } : null;
}

// ---- folder names ------------------------------------------------------------------------------------------

/** Lowercase ascii slug; empty input gives `untitled`. */
export function slugify(text: string, max = 40): string {
  const s = text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return s || 'untitled';
}
/** `applications/<YYYY-MM-DD>_<company>_<role>` relative to the data folder (without a re-apply suffix). */
export const applicationFolder = (now: Date, company: string, role: string): string =>
  `applications/${localDateStr(now)}_${slugify(company)}_${slugify(role)}`;
