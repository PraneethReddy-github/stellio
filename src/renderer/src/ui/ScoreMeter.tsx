import s from './metrics.module.css';
import { cx } from './cx';

export interface Thresholds {
  /** value >= ok is good; value >= warn is middling; anything lower is bad. */
  ok: number;
  warn: number;
}

/** Horizontal 2 px bar + mono number, 0–100. */
export function ScoreMeter({
  value,
  thresholds,
  label,
  showValue = true,
}: {
  value: number;
  thresholds: Thresholds;
  label: string;
  /** Hide the number when the screen already shows it. */
  showValue?: boolean;
}): React.JSX.Element {
  const v = Math.min(100, Math.max(0, Math.round(value)));
  const tone = v >= thresholds.ok ? 'ok' : v >= thresholds.warn ? 'warn' : 'bad';
  return (
    <span
      className={s.meter}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={v}
    >
      <span className={s.track} aria-hidden="true">
        <span className={cx(s.fill, s[tone])} style={{ width: `${String(v)}%` }} />
      </span>
      {showValue && <span className={s.score}>{v}</span>}
    </span>
  );
}
