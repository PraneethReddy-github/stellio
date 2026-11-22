import { describe, expect, it } from 'vitest';
import type { AppEvent, TimelineItem } from '../../../src/shared/tracker';
import {
  VIEWS_KEY,
  cleanFilters,
  dialogFor,
  dueText,
  describeEvent,
  fromLocalInput,
  groupByWeek,
  isNoFinalResume,
  loadViews,
  moveFocus,
  saveViews,
  statusForDigit,
  timelineWeeks,
  toLocalInput,
  upsertView,
} from '../../../src/renderer/src/features/applications/helpers';
import {
  funnelRows,
  isFresh,
  needsYouRows,
  weeklyBars,
} from '../../../src/renderer/src/features/today/helpers';
import type { TodaySummary } from '../../../src/shared/tracker';

describe('status keys and dialogs', () => {
  it('maps digits 1-9 to statuses and ignores other keys', () => {
    expect(statusForDigit('1')).toBe('saved');
    expect(statusForDigit('4')).toBe('applied');
    expect(statusForDigit('9')).toBe('rejected');
    expect(statusForDigit('0')).toBeNull();
    expect(statusForDigit('a')).toBeNull();
    expect(statusForDigit('10')).toBeNull();
  });
  it('asks a question for the statuses that need one', () => {
    expect(dialogFor('rejected')).toBe('stage');
    expect(dialogFor('ghosted')).toBe('stage');
    expect(dialogFor('not_applying')).toBe('reason');
    expect(dialogFor('applied')).toBe('apply');
    expect(dialogFor('offer')).toBe('offer');
    expect(dialogFor('screening')).toBeNull();
  });
  it('recognises the freeze refusing without a final resume', () => {
    expect(
      isNoFinalResume('Mark a final resume version first, or apply without one and give a reason.'),
    ).toBe(true);
    expect(isNoFinalResume('Something else failed')).toBe(false);
  });
});

describe('moveFocus', () => {
  const lanes = [['a', 'b', 'c'], [], ['d', 'e'], ['f']];
  it('moves within a lane and stops at the ends', () => {
    expect(moveFocus(lanes, 'a', 'ArrowDown')).toBe('b');
    expect(moveFocus(lanes, 'c', 'ArrowDown')).toBe('c');
    expect(moveFocus(lanes, 'a', 'ArrowUp')).toBe('a');
    expect(moveFocus(lanes, 'b', 'End')).toBe('c');
    expect(moveFocus(lanes, 'c', 'Home')).toBe('a');
  });
  it('skips empty lanes sideways, keeps the row, clamps to the shorter lane', () => {
    expect(moveFocus(lanes, 'b', 'ArrowRight')).toBe('e');
    expect(moveFocus(lanes, 'c', 'ArrowRight')).toBe('e');
    expect(moveFocus(lanes, 'e', 'ArrowRight')).toBe('f');
    expect(moveFocus(lanes, 'f', 'ArrowRight')).toBe('f');
    expect(moveFocus(lanes, 'd', 'ArrowLeft')).toBe('a');
  });
  it('starts at the first card and copes with no cards', () => {
    expect(moveFocus(lanes, null, 'ArrowDown')).toBe('a');
    expect(moveFocus(lanes, 'gone', 'ArrowDown')).toBe('a');
    expect(moveFocus([[], []], 'a', 'ArrowDown')).toBeNull();
  });
});

describe('timeline weeks', () => {
  // Saturday 2026-11-21 (local)
  const now = new Date(2026, 10, 21, 12, 0, 0);
  const weeks = timelineWeeks(now);
  it('is 12 Monday-start weeks: eight behind, this one, three ahead', () => {
    expect(weeks).toHaveLength(12);
    expect(weeks[8]).toEqual({ start: '2026-11-16', end: '2026-11-22' });
    expect(weeks[0]?.start).toBe('2026-09-21');
    expect(weeks[11]).toEqual({ start: '2026-12-07', end: '2026-12-13' });
  });
  it('groups items into their week, in time order, and drops the rest', () => {
    const item = (at: string, company: string): TimelineItem => ({
      kind: 'interview',
      at,
      applicationId: company,
      company,
      role: 'r',
      label: 'l',
    });
    const grouped = groupByWeek(
      [
        item('2026-11-22', 'sun'),
        item('2026-11-16', 'mon'),
        item('2026-11-23', 'next'),
        item('2025-01-01', 'old'),
      ],
      weeks,
    );
    expect(grouped[8]?.map((i) => i.company)).toEqual(['mon', 'sun']);
    expect(grouped[9]?.map((i) => i.company)).toEqual(['next']);
    expect(grouped.flat()).toHaveLength(3);
  });
});

describe('saved views', () => {
  const store = (initial: string | null) => {
    let v = initial;
    return {
      getItem: (k: string) => (k === VIEWS_KEY ? v : null),
      setItem: (k: string, val: string) => {
        if (k === VIEWS_KEY) v = val;
      },
    };
  };
  it('round-trips through storage', () => {
    const s = store(null);
    const views = upsertView([], {
      name: 'Mine',
      filters: { status: ['waiting'] },
      sort: { by: 'fit', dir: 'desc' },
    });
    saveViews(views, s);
    expect(loadViews(s)).toEqual(views);
  });
  it('replaces a view with the same name', () => {
    const a = { name: 'A', filters: {}, sort: { by: 'company' as const, dir: 'asc' as const } };
    const out = upsertView([a], { ...a, sort: { by: 'fit', dir: 'desc' } });
    expect(out).toHaveLength(1);
    expect(out[0]?.sort.by).toBe('fit');
  });
  it('survives garbage, wrong shapes and missing or throwing storage', () => {
    expect(loadViews(store('not json'))).toEqual([]);
    expect(loadViews(store('[{"name":1}]'))).toEqual([]);
    expect(loadViews(null)).toEqual([]);
    expect(
      loadViews({
        getItem: () => {
          throw new Error('blocked');
        },
      }),
    ).toEqual([]);
    expect(() =>
      saveViews([], {
        setItem: () => {
          throw new Error('full');
        },
      }),
    ).not.toThrow();
  });
  it('cleans empty filter values', () => {
    expect(cleanFilters({ status: [], text: '  ', appliedFrom: '', hasNextActionDue: false })).toEqual({});
    expect(cleanFilters({ status: ['saved'], text: ' x ', hasNextActionDue: true })).toEqual({
      status: ['saved'],
      text: 'x',
      hasNextActionDue: true,
    });
  });
});

describe('dates', () => {
  const now = new Date(2026, 10, 21, 15, 0, 0);
  it('words a due date relative to today', () => {
    expect(dueText('2026-11-21', now)).toBe('today');
    expect(dueText('2026-11-22', now)).toBe('tomorrow');
    expect(dueText('2026-11-20', now)).toBe('yesterday');
    expect(dueText('2026-11-28', now)).toBe('in 7 days');
    expect(dueText('2026-11-11', now)).toBe('10 days ago');
  });
  it('converts a local datetime input to ISO and back', () => {
    const iso = fromLocalInput('2026-11-21T10:30');
    expect(iso).not.toBeNull();
    expect(toLocalInput(iso)).toBe('2026-11-21T10:30');
    expect(fromLocalInput('')).toBeNull();
    expect(toLocalInput(null)).toBe('');
  });
});

describe('describeEvent', () => {
  const ev = (over: Partial<AppEvent>): AppEvent => ({
    id: 'e',
    applicationId: 'a',
    type: 'note',
    fromStatus: null,
    toStatus: null,
    at: '2026-11-21T10:00:00.000Z',
    payload: null,
    ...over,
  });
  it('shows the transition with the stage or reason', () => {
    expect(
      describeEvent(
        ev({
          type: 'status_change',
          fromStatus: 'interviewing',
          toStatus: 'rejected',
          payload: { stage: 'after_interview', note: 'internal hire' },
        }),
      ),
    ).toEqual({ title: 'Interviewing → Rejected', detail: 'After an interview · internal hire' });
    expect(
      describeEvent(ev({ type: 'status_change', toStatus: 'saved', payload: { created: 'shortlist' } })),
    ).toEqual({
      title: 'Started as Saved',
      detail: null,
    });
  });
  it('shows notes and interviews', () => {
    expect(describeEvent(ev({ payload: { text: 'Called back' } }))).toEqual({
      title: 'Note',
      detail: 'Called back',
    });
    expect(
      describeEvent(ev({ type: 'interview', payload: { action: 'added', round: 2, kind: 'technical' } }))
        .title,
    ).toBe('Interview round 2 added');
  });
});

const summary = (over: Partial<TodaySummary> = {}): TodaySummary => ({
  generatedAt: '2026-11-21T10:00:00.000Z',
  statusLine: [{ key: 'saved', label: 'Saved', count: 0, previous: 0, delta: 0, current: 0 }],
  needsYou: { followUps: [], readyNotSent: [], deadlines: [], interviews: [], ghosted: [], nudges: [] },
  newMatches: [],
  funnel: {
    windowDays: 90,
    steps: [
      { key: 'discovered', label: 'Discovered', count: 0, conversion: null },
      { key: 'shortlisted', label: 'Shortlisted', count: 0, conversion: null },
    ],
  },
  weekly: [],
  skills: { missing: [], learning: [] },
  lastScan: null,
  ...over,
});

describe('Today helpers', () => {
  it('orders the needs-you rows by urgency and links to the application', () => {
    const rows = needsYouRows({
      followUps: [
        {
          applicationId: 'f',
          company: 'Acme',
          role: 'DE',
          action: 'Follow up',
          at: '2026-11-13',
          overdueDays: 8,
        },
      ],
      readyNotSent: [{ applicationId: 'r', company: 'Contoso', role: 'DE', daysInStatus: 3 }],
      deadlines: [{ applicationId: 'd', company: 'N26', role: 'DE', deadline: '2026-11-23', daysLeft: 2 }],
      interviews: [
        {
          applicationId: 'i',
          company: 'Fabrikam',
          role: 'DE',
          interviewId: 'x',
          round: 2,
          kind: 'technical',
          at: '2026-11-22T09:00:00.000Z',
          when: 'tomorrow',
        },
      ],
      ghosted: [{ applicationId: 'g', company: 'Initech', role: 'DE', since: '2026-10-01', days: 51 }],
      nudges: [
        { kind: 'profile_review', skill: null, text: 'Profile last reviewed 42 days ago', to: '/profile' },
        { kind: 'stuck_learning', skill: 'dbt', text: 'dbt is in high demand and stuck', to: '/skills' },
      ],
    });
    expect(rows.map((r) => r.kind)).toEqual([
      'Interview',
      'Deadline',
      'Follow up',
      'Ready, not sent',
      'Ghosted?',
      'Profile review',
      'Learning stuck',
    ]);
    expect(rows.map((r) => r.to)).toEqual([
      '/applications/i',
      '/applications/d',
      '/applications/f',
      '/applications/r',
      '/applications/g',
      '/profile',
      '/skills',
    ]);
    expect(rows[1]?.detail).toBe('in 2 days');
    expect(rows[2]?.detail).toBe('8 days overdue');
    expect(rows[4]?.detail).toBe('no word for 51 days');
  });
  it('builds funnel rows with conversion percentages and relative widths', () => {
    const rows = funnelRows([
      { key: 'discovered', label: 'Discovered', count: 200, conversion: null },
      { key: 'shortlisted', label: 'Shortlisted', count: 50, conversion: 0.25 },
      { key: 'applied', label: 'Applied', count: 0, conversion: 0 },
    ]);
    expect(rows.map((r) => [r.count, r.width, r.pct])).toEqual([
      [200, 1, null],
      [50, 0.25, '25%'],
      [0, 0, '0%'],
    ]);
    expect(funnelRows([{ key: 'discovered', label: 'D', count: 0, conversion: null }])[0]?.width).toBe(0);
  });
  it('labels weekly bars by Monday and highlights this week', () => {
    const bars = weeklyBars([
      { weekStart: '2026-11-09', count: 2 },
      { weekStart: '2026-11-16', count: 3 },
    ]);
    expect(bars).toEqual([
      { label: '11-09', value: 2 },
      { label: '11-16', value: 3, highlight: true },
    ]);
  });
  it('knows a fresh install', () => {
    expect(isFresh(summary())).toBe(true);
    expect(
      isFresh(
        summary({
          statusLine: [{ key: 'saved', label: 'Saved', count: 1, previous: 0, delta: 1, current: 1 }],
        }),
      ),
    ).toBe(false);
  });
});
