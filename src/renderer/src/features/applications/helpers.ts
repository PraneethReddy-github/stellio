// Pure helpers for the Applications screens, the Apply tab and Today. No React, no IPC: unit-tested.
import { z } from 'zod';
import {
  TableFiltersSchema,
  TableSortSchema,
  addLocalDays,
  localDateStr,
  startOfLocalDay,
  toMs,
  type AppEvent,
  type AppStatus,
  type TableFilters,
  type TableSort,
  type TimelineItem,
} from '@shared/tracker';
import type { Tone } from '../../ui/StatusDot';

/** The router's route table is untyped; literal paths do not type-check, `string` does (see workspace/helpers). */
export const route = (path: string): string => path;

export const STATUS_LABEL: Record<AppStatus, string> = {
  saved: 'Saved',
  preparing: 'Preparing',
  ready: 'Ready',
  applied: 'Applied',
  acknowledged: 'Acknowledged',
  screening: 'Screening',
  interviewing: 'Interviewing',
  assessment: 'Assessment',
  offer: 'Offer',
  waiting: 'Waiting',
  accepted: 'Accepted',
  declined: 'Declined',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
  ghosted: 'Ghosted',
  not_applying: 'Not applying',
};

export const STATUS_TONE: Record<AppStatus, Tone> = {
  saved: 'neutral',
  preparing: 'neutral',
  ready: 'info',
  applied: 'info',
  acknowledged: 'info',
  screening: 'info',
  interviewing: 'info',
  assessment: 'info',
  offer: 'ok',
  waiting: 'warn',
  accepted: 'ok',
  declined: 'neutral',
  rejected: 'bad',
  withdrawn: 'neutral',
  ghosted: 'warn',
  not_applying: 'neutral',
};

/** Keys 1-9 on a focused board card. The other statuses are in the status menu. */
export const DIGIT_STATUS: readonly AppStatus[] = [
  'saved',
  'preparing',
  'ready',
  'applied',
  'screening',
  'interviewing',
  'offer',
  'waiting',
  'rejected',
];
export const statusForDigit = (key: string): AppStatus | null =>
  /^[1-9]$/.test(key) ? (DIGIT_STATUS[Number(key) - 1] ?? null) : null;

export type StatusDialog = 'stage' | 'reason' | 'apply' | 'offer';
/** Which statuses need a question before they are set (docs/08 §1). */
export const dialogFor = (to: AppStatus): StatusDialog | null =>
  to === 'rejected' || to === 'ghosted'
    ? 'stage'
    : to === 'not_applying'
      ? 'reason'
      : to === 'applied'
        ? 'apply'
        : to === 'offer'
          ? 'offer'
          : null;

/** The freeze refuses without a final resume; the message says so. */
export const isNoFinalResume = (message: string): boolean => /final resume/i.test(message);

export const STAGE_LABEL = {
  before_interview: 'Before an interview',
  after_interview: 'After an interview',
} as const;

// ---- board keyboard ----------------------------------------------------------------------------------------

export type MoveKey = 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End';

/** Next focused card id. `lanes` are the card ids per lane in display order. Left/Right keep the row, clamped. */
export function moveFocus(
  lanes: readonly (readonly string[])[],
  current: string | null,
  key: MoveKey,
): string | null {
  const filled = lanes.map((ids, lane) => ({ ids, lane })).filter((l) => l.ids.length > 0);
  if (filled.length === 0) return null;
  const at = filled.findIndex((l) => current !== null && l.ids.includes(current));
  if (at < 0) return filled[0]?.ids[0] ?? null;
  const lane = filled[at];
  if (!lane) return null;
  const row = lane.ids.indexOf(current ?? '');
  if (key === 'ArrowUp') return lane.ids[Math.max(0, row - 1)] ?? null;
  if (key === 'ArrowDown') return lane.ids[Math.min(lane.ids.length - 1, row + 1)] ?? null;
  if (key === 'Home') return lane.ids[0] ?? null;
  if (key === 'End') return lane.ids[lane.ids.length - 1] ?? null;
  const next = filled[Math.min(filled.length - 1, Math.max(0, at + (key === 'ArrowRight' ? 1 : -1)))];
  return next?.ids[Math.min(row, next.ids.length - 1)] ?? null;
}

// ---- timeline ----------------------------------------------------------------------------------------------

export interface Week {
  /** Monday, YYYY-MM-DD (local). */
  start: string;
  /** Sunday, YYYY-MM-DD. */
  end: string;
}
export const TIMELINE_BACK = 8;
export const TIMELINE_FORWARD = 3;

/** 12 Monday-start weeks: eight behind this one, this one, and three ahead (interviews and deadlines are ahead). */
export function timelineWeeks(now: Date, back = TIMELINE_BACK, forward = TIMELINE_FORWARD): Week[] {
  const today = startOfLocalDay(now);
  const monday = addLocalDays(today, -((today.getDay() + 6) % 7));
  return Array.from({ length: back + 1 + forward }, (_, i) => {
    const start = addLocalDays(monday, (i - back) * 7);
    return { start: localDateStr(start), end: localDateStr(addLocalDays(start, 6)) };
  });
}

/** Items per week, each week's items in time order. Items outside the window are dropped. */
export function groupByWeek(items: readonly TimelineItem[], weeks: readonly Week[]): TimelineItem[][] {
  const bounds = weeks.map((w) => [toMs(w.start), toMs(w.end) + 86_400_000] as const);
  return bounds.map(([lo, hi]) =>
    items.filter((i) => toMs(i.at) >= lo && toMs(i.at) < hi).sort((a, b) => toMs(a.at) - toMs(b.at)),
  );
}

// ---- saved table views -------------------------------------------------------------------------------------

export interface SavedView {
  name: string;
  filters: TableFilters;
  sort: TableSort;
}
const SavedViewsSchema = z.array(
  z.object({ name: z.string().min(1).max(60), filters: TableFiltersSchema, sort: TableSortSchema }),
);
export const VIEWS_KEY = 'stellio.applications.views';
export const DEFAULT_SORT: TableSort = { by: 'updatedAt', dir: 'desc' };
export const BUILT_IN_VIEWS: readonly SavedView[] = [
  { name: 'Follow-ups due', filters: { hasNextActionDue: true }, sort: { by: 'nextActionAt', dir: 'asc' } },
  { name: 'Waiting', filters: { status: ['waiting'] }, sort: { by: 'updatedAt', dir: 'asc' } },
];

export function loadViews(storage: Pick<Storage, 'getItem'> | null = safeStorage()): SavedView[] {
  try {
    const raw = storage?.getItem(VIEWS_KEY);
    const parsed = raw ? SavedViewsSchema.safeParse(JSON.parse(raw)) : null;
    return parsed?.success ? parsed.data : [];
  } catch {
    return [];
  }
}
export function saveViews(
  views: readonly SavedView[],
  storage: Pick<Storage, 'setItem'> | null = safeStorage(),
): void {
  try {
    storage?.setItem(VIEWS_KEY, JSON.stringify(views));
  } catch {
    /* storage unavailable: views last until the screen closes */
  }
}
/** Adds a view, or replaces the one with the same name. */
export const upsertView = (views: readonly SavedView[], view: SavedView): SavedView[] => [
  ...views.filter((v) => v.name !== view.name),
  view,
];
function safeStorage(): Storage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

/** Filters that actually narrow the table (what "clear" resets). */
export const hasFilters = (f: TableFilters): boolean =>
  Boolean(f.status?.length || f.text?.trim() || f.appliedFrom || f.appliedTo || f.hasNextActionDue);

/** Drops empty filter values so the query key and IPC input stay minimal. */
export function cleanFilters(f: TableFilters): TableFilters {
  const out: TableFilters = {};
  if (f.status?.length) out.status = f.status;
  if (f.text?.trim()) out.text = f.text.trim();
  if (f.appliedFrom) out.appliedFrom = f.appliedFrom;
  if (f.appliedTo) out.appliedTo = f.appliedTo;
  if (f.hasNextActionDue) out.hasNextActionDue = true;
  return out;
}

// ---- dates -------------------------------------------------------------------------------------------------

const p2 = (n: number): string => String(n).padStart(2, '0');
/** `2026-11-21` for a plain date, `2026-11-21 10:00` (local) for a datetime. */
export function formatWhen(iso: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${localDateStr(d)} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}
/** ISO instant -> value of a `datetime-local` input (local time). Empty when invalid. */
export function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(toMs(iso));
  return Number.isNaN(d.getTime()) ? '' : `${localDateStr(d)}T${p2(d.getHours())}:${p2(d.getMinutes())}`;
}
/** Value of a `datetime-local` input -> ISO instant. Null when empty. */
export function fromLocalInput(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
/** `date` input value or empty -> the plain date or null. */
export const dayOrNull = (value: string): string | null => (/^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null);

/** "in 3 days", "today", "2 days ago" for a due date. */
export function dueText(at: string, now: Date): string {
  const days = Math.round((toMs(at) - startOfLocalDay(now).getTime()) / 86_400_000);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  return days > 0 ? `in ${String(days)} days` : `${String(-days)} days ago`;
}
export const isOverdue = (at: string, now: Date): boolean => toMs(at) < startOfLocalDay(now).getTime();

// ---- event trail -------------------------------------------------------------------------------------------

const payloadOf = (e: AppEvent): Record<string, unknown> =>
  e.payload !== null && typeof e.payload === 'object' ? (e.payload as Record<string, unknown>) : {};
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** One line for the Overview trail, plus an optional detail line (the note, stage or reason). */
export function describeEvent(e: AppEvent): { title: string; detail: string | null } {
  const p = payloadOf(e);
  switch (e.type) {
    case 'status_change': {
      const to = e.toStatus ? STATUS_LABEL[e.toStatus] : 'Unknown';
      const stage =
        p.stage === 'before_interview' || p.stage === 'after_interview' ? STAGE_LABEL[p.stage] : null;
      const detail = [stage, text(p.reason), text(p.note), text(p.forceReason)].filter(Boolean).join(' · ');
      return {
        title: e.fromStatus ? `${STATUS_LABEL[e.fromStatus]} → ${to}` : `Started as ${to}`,
        detail: detail || null,
      };
    }
    case 'note':
      return { title: 'Note', detail: text(p.text) };
    case 'follow_up':
      return { title: 'Followed up', detail: text(p.text) };
    case 'interview': {
      const round = typeof p.round === 'number' ? ` round ${String(p.round)}` : '';
      const verb = text(p.action) ?? 'changed';
      const when = text(p.scheduledAt);
      return {
        title: `Interview${round} ${verb}`,
        detail: [text(p.kind), when ? formatWhen(when) : null].filter(Boolean).join(' · ') || null,
      };
    }
    case 'contact':
      return { title: `Contact ${text(p.action) ?? 'changed'}`, detail: text(p.name) };
    case 'document': {
      const files = Array.isArray(p.files) ? p.files.length : 0;
      return {
        title: 'Documents frozen',
        detail: [text(p.frozen), files ? `${String(files)} files` : null].filter(Boolean).join(' · ') || null,
      };
    }
    case 'email':
      return { title: 'Email', detail: text(p.subject) ?? text(p.text) };
    case 'referral':
      return { title: text(p.text) ?? 'Referral', detail: text(p.note) };
  }
}
