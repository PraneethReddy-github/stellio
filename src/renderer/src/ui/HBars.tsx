import s from './hbars.module.css';

export interface HBarCell {
  /** 0-1: the bar's length. */
  value: number;
  /** Direct label, always visible: "60%". */
  text: string;
}
export interface HBarRow {
  label: string;
  /** Sample size, shown as its own column. */
  count: number;
  /** One cell per series, in the order of `series`. */
  cells: HBarCell[];
  /** When set the row is greyed, shows this text instead of bars and carries no values. */
  muted?: string;
}

/**
 * Horizontal bars as a table (docs/09 §7): one row per segment, one bar per series, the value written next to
 * each bar. One series colour (`--text-2`), the first series is the one that matters. The table's own text
 * carries every number, so the bars are decoration for the eye (`aria-hidden`).
 */
export function HBars({
  caption,
  countLabel,
  series,
  rows,
}: {
  caption: string;
  countLabel: string;
  series: string[];
  rows: HBarRow[];
}): React.JSX.Element {
  return (
    <table className={s.table}>
      <caption className={s.caption}>{caption}</caption>
      <thead>
        <tr>
          <th scope="col">Segment</th>
          <th scope="col" className={s.num}>
            {countLabel}
          </th>
          {series.map((x) => (
            <th key={x} scope="col">
              {x}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.label} className={r.muted ? s.muted : undefined}>
            <th scope="row">{r.label}</th>
            <td className={s.num}>{r.count}</td>
            {r.muted ? (
              <td colSpan={series.length}>{r.muted}</td>
            ) : (
              r.cells.map((c, i) => (
                <td key={series[i]}>
                  <span className={s.cell}>
                    <span className={s.track} aria-hidden="true">
                      <span className={s.fill} style={{ width: `${String(Math.round(c.value * 100))}%` }} />
                    </span>
                    <span className={s.value}>{c.text}</span>
                  </span>
                </td>
              ))
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
