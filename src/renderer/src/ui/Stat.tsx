import s from './metrics.module.css';
import { cx } from './cx';
import type { Tone } from './StatusDot';

/** Micro label, big mono number, optional signed delta. Delta tone defaults to ok (up) / bad (down). */
export function Stat({
  label,
  value,
  delta,
  deltaTone,
  deltaLabel,
}: {
  label: string;
  value: string | number;
  delta?: number;
  deltaTone?: Tone;
  /** What the delta is measured against, e.g. "vs last week". */
  deltaLabel?: string;
}): React.JSX.Element {
  const tone = deltaTone ?? (delta === undefined || delta === 0 ? 'neutral' : delta > 0 ? 'ok' : 'bad');
  return (
    <dl className={s.stat}>
      <dt className="micro">{label}</dt>
      <dd className={s.value}>{value}</dd>
      {delta !== undefined && (
        <dd className={cx(s.delta, s[`d_${tone}`])}>
          {delta > 0 ? '+' : delta < 0 ? '−' : '±'}
          {Math.abs(delta)}
          {deltaLabel && <span className={s.deltaLabel}> {deltaLabel}</span>}
        </dd>
      )}
    </dl>
  );
}
