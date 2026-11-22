import { useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { BoardCard } from '@shared/tracker';
import { Button, EmptyState, ErrorState, Kbd, Loading, StatusDot, cx } from '../../ui';
import { useBoard } from '../../lib/tracker';
import {
  DIGIT_STATUS,
  STATUS_LABEL,
  STATUS_TONE,
  dueText,
  isOverdue,
  moveFocus,
  route,
  statusForDigit,
  type MoveKey,
} from './helpers';
import { useStatusFlow } from './StatusFlow';
import s from './applications.module.css';

const ARROWS = new Set<string>(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End']);

/**
 * Lanes of cards. One card is in the tab order; arrows move between cards, 1-9 set its status, Enter opens the
 * full page, Space or a click opens the inspector.
 */
export function BoardView({
  selectedId,
  onSelect,
}: {
  selectedId: string | null;
  onSelect: (id: string) => void;
}): React.JSX.Element {
  const q = useBoard();
  const navigate = useNavigate();
  const flow = useStatusFlow();
  const [focusId, setFocusId] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);

  // A card that changed lane is a new element, and a closed dialog gives focus back to nothing: keep the keyboard on it.
  useEffect(() => {
    if (flow.open || !focusId || document.activeElement !== document.body) return;
    root.current?.querySelector<HTMLElement>(`[data-card="${focusId}"]`)?.focus();
  }, [q.data, flow.open, focusId]);

  if (q.isPending) return <Loading what="Reading applications" />;
  if (q.isError)
    return (
      <ErrorState
        title="Could not read the board"
        message={q.error.message}
        action={<Button onClick={() => void q.refetch()}>Try again</Button>}
      />
    );
  const { lanes } = q.data;
  if (lanes.every((l) => l.cards.length === 0))
    return (
      <EmptyState
        title="No applications yet"
        action={<Button onClick={() => void navigate({ to: route('/workspace') })}>Add a job</Button>}
      >
        An application starts when you shortlist a job or begin a resume for it.
      </EmptyState>
    );

  const ids = lanes.map((l) => l.cards.map((c) => c.id));
  const all = lanes.flatMap((l) => l.cards);
  const tabStop = focusId && all.some((c) => c.id === focusId) ? focusId : (all[0]?.id ?? null);
  const focusCard = (id: string | null): void => {
    if (!id) return;
    setFocusId(id);
    root.current?.querySelector<HTMLElement>(`[data-card="${id}"]`)?.focus();
  };

  const onKey = (e: KeyboardEvent<HTMLButtonElement>, card: BoardCard): void => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (ARROWS.has(e.key)) {
      e.preventDefault();
      focusCard(moveFocus(ids, card.id, e.key as MoveKey));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      void navigate({ to: `/applications/${card.id}` });
      return;
    }
    const to = statusForDigit(e.key);
    if (to) {
      e.preventDefault();
      flow.request({ id: card.id, jobId: card.jobId, status: card.status, company: card.company }, to);
    }
  };

  return (
    <div className={s.board} ref={root}>
      <p className={s.boardHint}>
        <Kbd keys="↑ ↓ ← →" /> move · <Kbd keys="Enter" /> open · <Kbd keys="1–9" /> set status:{' '}
        {DIGIT_STATUS.map((st, i) => `${String(i + 1)} ${STATUS_LABEL[st].toLowerCase()}`).join(', ')}
      </p>
      <div className={s.lanes}>
        {lanes.map((lane) => (
          <section key={lane.id} className={s.lane} aria-label={lane.label}>
            <h3 className={s.laneTitle}>
              {lane.label} <span className={s.count}>{lane.cards.length}</span>
            </h3>
            <ul className={s.cards}>
              {lane.cards.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    data-card={c.id}
                    tabIndex={c.id === tabStop ? 0 : -1}
                    className={cx(s.card, c.id === selectedId && s.cardSelected)}
                    onFocus={() => setFocusId(c.id)}
                    onClick={() => onSelect(c.id)}
                    onKeyDown={(e) => onKey(e, c)}
                  >
                    <span className={s.cardTop}>
                      <span className={s.company}>{c.company}</span>
                      {c.fit !== null && (
                        <span className={s.fit}>
                          <span className="sr-only">Fit </span>
                          {c.fit}
                        </span>
                      )}
                    </span>
                    <span className={s.role}>{c.role}</span>
                    <span className={s.cardMeta}>
                      <StatusDot tone={STATUS_TONE[c.status]}>{STATUS_LABEL[c.status]}</StatusDot>
                      <span className={s.mono}>{c.daysInStatus} d</span>
                    </span>
                    {c.nextAction && (
                      <span
                        className={cx(
                          s.next,
                          c.nextActionAt && isOverdue(c.nextActionAt, new Date()) && s.overdue,
                        )}
                      >
                        {c.nextAction}
                        {c.nextActionAt && ` · ${dueText(c.nextActionAt, new Date())}`}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      {flow.dialogs}
    </div>
  );
}
