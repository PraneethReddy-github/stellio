import { useMemo } from 'react';
import type { TimelineItem } from '@shared/tracker';
import { Button, EmptyState, ErrorState, Loading, StatusDot, cx } from '../../ui';
import type { Tone } from '../../ui/StatusDot';
import { useTimeline } from '../../lib/tracker';
import { TIMELINE_BACK, formatWhen, groupByWeek, timelineWeeks } from './helpers';
import s from './applications.module.css';

const KIND_TONE: Record<TimelineItem['kind'], Tone> = {
  applied: 'neutral',
  interview: 'info',
  deadline: 'warn',
};
const KIND_LABEL: Record<TimelineItem['kind'], string> = {
  applied: 'Applied',
  interview: 'Interview',
  deadline: 'Deadline',
};

/** Twelve weeks, one row each: what you sent, interviews and deadlines. This week is marked. */
export function TimelineView({ onSelect }: { onSelect: (id: string) => void }): React.JSX.Element {
  const weeks = useMemo(() => timelineWeeks(new Date()), []);
  const first = weeks[0];
  const last = weeks[weeks.length - 1];
  const q = useTimeline(first?.start ?? '', last?.end ?? '');
  const thisWeek = TIMELINE_BACK;

  if (q.isPending) return <Loading what="Reading the timeline" />;
  if (q.isError)
    return (
      <ErrorState
        title="Could not read the timeline"
        message={q.error.message}
        action={<Button onClick={() => void q.refetch()}>Try again</Button>}
      />
    );
  const grouped = groupByWeek(q.data.items, weeks);
  if (q.data.items.length === 0)
    return (
      <EmptyState title="Nothing in these 12 weeks">
        Applications you send, interviews you add and job deadlines are placed here by date.
      </EmptyState>
    );

  return (
    <ol className={s.timeline} aria-label="Timeline, 12 weeks">
      {weeks.map((w, i) => {
        const items = grouped[i] ?? [];
        return (
          <li
            key={w.start}
            className={cx(s.week, i === thisWeek && s.thisWeek)}
            aria-current={i === thisWeek ? 'date' : undefined}
          >
            <div className={s.weekHead}>
              <span className={s.mono}>{w.start}</span>
              {i === thisWeek && <span className={s.now}>this week</span>}
              <span className={s.weekCount}>{items.length > 0 ? items.length : ''}</span>
            </div>
            <ul className={s.weekItems}>
              {items.map((it) => (
                <li key={`${it.kind}-${it.applicationId}-${it.at}`}>
                  <button type="button" className={s.tlItem} onClick={() => onSelect(it.applicationId)}>
                    <StatusDot tone={KIND_TONE[it.kind]}>{KIND_LABEL[it.kind]}</StatusDot>
                    <span className={s.mono}>{formatWhen(it.at)}</span>
                    <span>
                      {it.company} · {it.role}
                    </span>
                    {it.kind === 'interview' && <span className={s.dim}>{it.label}</span>}
                  </button>
                </li>
              ))}
            </ul>
          </li>
        );
      })}
    </ol>
  );
}
