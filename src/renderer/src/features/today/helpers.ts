// Pure helpers for the Today screen. No React, no IPC: unit-tested.
import type { TodaySummary } from '@shared/tracker';
import type { Bar } from '../../ui';
import type { Tone } from '../../ui/StatusDot';
import { formatWhen } from '../applications/helpers';

export interface NeedRow {
  key: string;
  /** Short category shown before the text: "Interview", "Follow up". */
  kind: string;
  title: string;
  detail: string;
  tone: Tone;
  /** Route where you act on it. */
  to: string;
}

const NUDGE_KIND = {
  stale_skill: 'Stale skill',
  stuck_learning: 'Learning stuck',
  profile_review: 'Profile review',
} as const;
const appPath = (id: string): string => `/applications/${id}`;
const plural = (n: number, one: string): string => `${String(n)} ${one}${n === 1 ? '' : 's'}`;

/** One list, most urgent first: interviews, deadlines, follow-ups, ready-not-sent, ghosting suggestions, then the profile and skills nudges. */
export function needsYouRows(n: TodaySummary['needsYou']): NeedRow[] {
  return [
    ...n.interviews.map<NeedRow>((i) => ({
      key: `i-${i.interviewId}`,
      kind: 'Interview',
      title: `${i.company} · ${i.role}`,
      detail: `${[i.when, formatWhen(i.at).slice(11)].filter(Boolean).join(' ')} · round ${String(i.round)}`,
      tone: 'info',
      to: appPath(i.applicationId),
    })),
    ...n.deadlines.map<NeedRow>((d) => ({
      key: `d-${d.applicationId}`,
      kind: 'Deadline',
      title: `${d.company} · ${d.role}`,
      detail: d.daysLeft <= 0 ? 'today' : `in ${plural(d.daysLeft, 'day')}`,
      tone: 'warn',
      to: appPath(d.applicationId),
    })),
    ...n.followUps.map<NeedRow>((f) => ({
      key: `f-${f.applicationId}-${f.action}`,
      kind: f.action,
      title: `${f.company} · ${f.role}`,
      detail: f.overdueDays > 0 ? `${plural(f.overdueDays, 'day')} overdue` : 'due today',
      tone: f.overdueDays > 0 ? 'bad' : 'warn',
      to: appPath(f.applicationId),
    })),
    ...n.readyNotSent.map<NeedRow>((r) => ({
      key: `r-${r.applicationId}`,
      kind: 'Ready, not sent',
      title: `${r.company} · ${r.role}`,
      detail: `${plural(r.daysInStatus, 'day')} ready`,
      tone: 'neutral',
      to: appPath(r.applicationId),
    })),
    ...n.ghosted.map<NeedRow>((g) => ({
      key: `g-${g.applicationId}`,
      kind: 'Ghosted?',
      title: `${g.company} · ${g.role}`,
      detail: `no word for ${plural(g.days, 'day')}`,
      tone: 'warn',
      to: appPath(g.applicationId),
    })),
    ...n.nudges.map<NeedRow>((x) => ({
      key: `n-${x.kind}-${x.skill ?? ''}`,
      kind: NUDGE_KIND[x.kind],
      title: x.text,
      detail: x.to === '/profile' ? 'Profile' : 'Skills',
      tone: 'neutral',
      to: x.to,
    })),
  ];
}

export interface FunnelRow {
  key: string;
  label: string;
  count: number;
  /** 0-1 of the widest step, for the bar. */
  width: number;
  /** Conversion from the previous step, "61%", or null for the first step / an empty previous step. */
  pct: string | null;
}

export function funnelRows(steps: TodaySummary['funnel']['steps']): FunnelRow[] {
  const max = Math.max(1, ...steps.map((s) => s.count));
  return steps.map((s) => ({
    key: s.key,
    label: s.label,
    count: s.count,
    width: s.count / max,
    pct: s.conversion === null ? null : `${String(Math.round(s.conversion * 100))}%`,
  }));
}

/** 12 bars, labelled with the week's Monday (`MM-DD`); the current week is the highlighted one. */
export function weeklyBars(weekly: TodaySummary['weekly']): Bar[] {
  return weekly.map((w, i) => ({
    label: w.weekStart.slice(5),
    value: w.count,
    ...(i === weekly.length - 1 ? { highlight: true } : {}),
  }));
}

/** Nothing tracked at all: a fresh install. */
export const isFresh = (t: TodaySummary): boolean =>
  t.statusLine.every((s) => s.count === 0 && s.current === 0) && t.funnel.steps.every((s) => s.count === 0);
