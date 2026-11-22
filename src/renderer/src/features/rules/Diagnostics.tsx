import type { Diagnostic } from '@shared/profile';
import { StatusDot } from '../../ui';
import { useDebounced } from '../../lib/hooks';
import { countDiagnostics } from './helpers';
import s from './rules.module.css';

/** Announced to screen readers, so it waits for typing to pause. */
const ANNOUNCE_DELAY_MS = 500;

const Count = ({ n, word }: { n: number; word: string }): React.JSX.Element => (
  <>
    <span className={s.num}>{n}</span> {word}
    {n === 1 ? '' : 's'}
  </>
);

/** Problems in the current draft; rows with a line jump to it in the editor. */
export function Diagnostics({
  diagnostics,
  onJump,
}: {
  /** Already sorted: errors first. */
  diagnostics: Diagnostic[];
  onJump: (line: number) => void;
}): React.JSX.Element {
  const now = countDiagnostics(diagnostics);
  const heard = countDiagnostics(useDebounced(diagnostics, ANNOUNCE_DELAY_MS));
  return (
    <>
      <p className={s.summary}>
        <Count n={now.errors} word="error" /> · <Count n={now.warnings} word="warning" />
      </p>
      <p className="sr-only" role="status">
        Checks: {heard.errors} errors, {heard.warnings} warnings
      </p>
      {diagnostics.length === 0 ? (
        <p className={s.quiet}>No problems found.</p>
      ) : (
        <ul className={s.rows} aria-label="Problems">
          {diagnostics.map((d, i) => (
            <li key={`${d.code}-${String(i)}`}>
              <Row
                tone={d.severity === 'error' ? 'bad' : 'warn'}
                label={d.severity}
                line={d.line}
                onJump={onJump}
              >
                <span title={d.code}>{d.message}</span>
              </Row>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** One problem: dot + severity, message, and the line it points at (a button when there is one). */
export function Row({
  tone,
  label,
  line,
  onJump,
  children,
}: {
  tone: 'bad' | 'warn';
  label: string;
  line?: number | null;
  onJump: (line: number) => void;
  children: React.ReactNode;
}): React.JSX.Element {
  const body = (
    <>
      <span className={s.rowDot}>
        <StatusDot tone={tone}>{label}</StatusDot>
      </span>
      <span className={s.rowMsg}>{children}</span>
      {line != null && <span className={s.rowLine}>L{line}</span>}
    </>
  );
  return line == null ? (
    <div className={s.row}>{body}</div>
  ) : (
    <button type="button" className={s.row} onClick={() => onJump(line)}>
      {body}
    </button>
  );
}
