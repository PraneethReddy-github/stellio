import s from './metrics.module.css';
import type { Tone } from './StatusDot';

export interface Bar {
  label: string;
  value: number;
  /** Status colour for this bar. Default is neutral grey. */
  tone?: Tone;
  /** The one bar to draw attention to (signal colour). */
  highlight?: boolean;
}

const MIN_SLOT = 44;
/** 11 px IBM Plex Mono is 6.6 px per character; round up so labels never touch their neighbours. */
const CHAR_W = 7;
const GAP = 8;
const BAR = 24;
const LABEL_H = 20;
const VALUE_H = 18;

/** Horizontal pitch per bar: wide enough for the longest label plus a gap. */
export const barSlot = (labels: readonly string[]): number =>
  Math.max(MIN_SLOT, Math.max(0, ...labels.map((l) => l.length)) * CHAR_W + GAP);

/** Small vertical bars with the value above and the label below each bar. Hand-rolled SVG, no legend. */
export function Bars({
  data,
  height = 96,
  ariaLabel,
}: {
  data: Bar[];
  /** Height of the tallest bar, px. */
  height?: number;
  ariaLabel: string;
}): React.JSX.Element {
  const max = Math.max(1, ...data.map((d) => d.value));
  const slot = barSlot(data.map((d) => d.label));
  const w = data.length * slot;
  const h = VALUE_H + height + LABEL_H;
  const base = VALUE_H + height;
  return (
    <svg
      className={s.bars}
      width={w}
      height={h}
      viewBox={`0 0 ${String(w)} ${String(h)}`}
      role="img"
      aria-label={`${ariaLabel}: ${data.map((d) => `${d.label} ${String(d.value)}`).join(', ')}`}
    >
      <line className={s.baseline} x1={0} x2={w} y1={base + 0.5} y2={base + 0.5} />
      {data.map((d, i) => {
        const bh = d.value > 0 ? Math.max(1, (d.value / max) * height) : 0;
        const mid = i * slot + slot / 2;
        return (
          <g key={d.label}>
            <rect
              className={d.highlight ? s.b_signal : s[`b_${d.tone ?? 'neutral'}`]}
              x={mid - BAR / 2}
              y={base - bh}
              width={BAR}
              height={bh}
            />
            <text className={s.barValue} x={mid} y={base - bh - 5} textAnchor="middle">
              {d.value}
            </text>
            <text className={s.barLabel} x={mid} y={h - 5} textAnchor="middle">
              {d.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
