import { parseUnifiedDiff, toRows, type DiffLine, type Hunk } from './diff';
import s from './DiffView.module.css';
import { cx } from './cx';

function Side({ line, kind }: { line?: DiffLine; kind: 'del' | 'add' }): React.JSX.Element[] {
  const changed = line && line.kind === kind;
  const rule = changed ? s[kind] : undefined;
  const no = kind === 'del' ? line?.oldNo : line?.newNo;
  return [
    <td key="n" className={cx(s.no, rule)}>
      {no}
    </td>,
    <td key="t" className={cx(s.text, !line && s.gap)}>
      {changed && <span className="sr-only">{kind === 'del' ? 'removed: ' : 'added: '}</span>}
      {line?.text}
    </td>,
  ];
}

/** Two-column line diff. Pass git unified diff text, or hunks from `diffLines(before, after)`. */
export function DiffView({
  diff,
  ariaLabel = 'Changes',
  leftLabel,
  rightLabel,
}: {
  diff: string | Hunk[];
  ariaLabel?: string;
  /** Column captions, e.g. "Before" / "After". Shown when both are given. */
  leftLabel?: string;
  rightLabel?: string;
}): React.JSX.Element {
  const hunks = typeof diff === 'string' ? parseUnifiedDiff(diff) : diff;
  if (hunks.length === 0) return <p className={s.none}>No changes.</p>;
  return (
    <table className={s.diff} aria-label={ariaLabel}>
      <colgroup>
        <col className={s.numCol} />
        <col />
        <col className={s.numCol} />
        <col />
      </colgroup>
      {leftLabel && rightLabel && (
        <thead>
          <tr>
            <th colSpan={2} scope="col" className={s.colHead}>
              {leftLabel}
            </th>
            <th colSpan={2} scope="col" className={s.colHead}>
              {rightLabel}
            </th>
          </tr>
        </thead>
      )}
      {hunks.map((h, i) => (
        <tbody key={`${h.header}-${String(i)}`}>
          <tr>
            <th colSpan={4} scope="colgroup" className={s.hunk}>
              {h.header}
            </th>
          </tr>
          {toRows(h).map((r, k) => (
            <tr key={k}>
              <Side line={r.left} kind="del" />
              <Side line={r.right} kind="add" />
            </tr>
          ))}
        </tbody>
      ))}
    </table>
  );
}
