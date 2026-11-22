import type { ReactNode } from 'react';
import s from './states.module.css';
import { cx } from './cx';

/** What is empty, why, and the one next action. */
export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}): React.JSX.Element {
  return (
    <div className={s.state} role="status">
      <h2 className={s.title}>{title}</h2>
      {children && <p className={s.body}>{children}</p>}
      {action}
    </div>
  );
}

/** What failed, the exact message, and a retry. */
export function ErrorState({
  title,
  message,
  action,
}: {
  title: string;
  message?: string;
  action?: ReactNode;
}): React.JSX.Element {
  return (
    <div className={cx(s.state, s.error)} role="alert">
      <h2 className={s.title}>{title}</h2>
      {message && <pre className={s.detail}>{message}</pre>}
      {action}
    </div>
  );
}

/** 1 px progress line. Indeterminate without `value`; `value` is 0–1. */
export function ProgressLine({ value, label }: { value?: number; label: string }): React.JSX.Element {
  return (
    <div
      className={s.progress}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value === undefined ? undefined : Math.round(value * 100)}
      data-value={value === undefined ? undefined : ''}
      style={
        value === undefined ? undefined : ({ '--value': `${String(value * 100)}%` } as React.CSSProperties)
      }
    />
  );
}

/** Loading with a statement of what is happening (no bare spinners). */
export function Loading({ what }: { what: string }): React.JSX.Element {
  return (
    <div className={s.loading} aria-live="polite">
      <ProgressLine label={what} />
      <span>{what}</span>
    </div>
  );
}
