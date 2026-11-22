import type { Diagnostic } from '@shared/profile';
import { Inspector, StatusDot } from '../../ui';
import { useDebounced } from '../../lib/hooks';
import { countDiagnostics, friendlyMessage } from './helpers';
import s from './profile.module.css';

/** Announced to screen readers, so it waits for typing to pause. */
const ANNOUNCE_DELAY_MS = 500;

const Count = ({ n, word }: { n: number; word: string }): React.JSX.Element => (
  <>
    <span className={s.mono}>{n}</span> {word}
    {n === 1 ? '' : 's'}
  </>
);

/** Right-hand list of problems in the current draft; rows with a line jump to it in the editor. */
export function DiagnosticsPanel({
  diagnostics,
  onJump,
  onClose,
}: {
  /** Already sorted: errors first. */
  diagnostics: Diagnostic[];
  onJump: (line: number) => void;
  onClose: () => void;
}): React.JSX.Element {
  const { errors, warnings } = countDiagnostics(useDebounced(diagnostics, ANNOUNCE_DELAY_MS));
  return (
    <Inspector title="Diagnostics" onClose={onClose}>
      <p className={s.diagSummary} role="status">
        <Count n={errors} word="error" /> · <Count n={warnings} word="warning" />
      </p>
      <ul className={s.diagList} aria-label="Problems">
        {diagnostics.map((d, i) => {
          const body = (
            <>
              <span className={s.diagDot}>
                <StatusDot tone={d.severity === 'error' ? 'bad' : 'warn'}>{d.severity}</StatusDot>
              </span>
              <span className={s.diagMsg} title={d.code}>
                {friendlyMessage(d)}
              </span>
              {d.line !== null && <span className={s.diagLine}>L{d.line}</span>}
            </>
          );
          const line = d.line;
          return (
            <li key={`${d.code}-${String(i)}`}>
              {line === null ? (
                <div className={s.diagRow}>{body}</div>
              ) : (
                <button type="button" className={s.diagRow} onClick={() => onJump(line)}>
                  {body}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </Inspector>
  );
}
