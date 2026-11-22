import s from './misc.module.css';
import { cx } from './cx';

export type Tone = 'neutral' | 'signal' | 'ok' | 'warn' | 'bad' | 'info';

/** 6 px dot + text. Status is never colour-only (docs/09 §3). */
export function StatusDot({ tone, children }: { tone: Tone; children: React.ReactNode }): React.JSX.Element {
  return (
    <span className={s.status}>
      <span className={cx(s.dot, s[tone])} aria-hidden="true" />
      {children}
    </span>
  );
}

export function Tag({
  children,
  tone = 'neutral',
}: {
  children: React.ReactNode;
  tone?: Tone;
}): React.JSX.Element {
  return <span className={cx(s.tag, s[`tag_${tone}`])}>{children}</span>;
}
