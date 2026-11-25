import { useMemo } from 'react';
import { Link } from '@tanstack/react-router';
import { Button, EmptyState, ErrorState, Loading, StatusDot } from '../../ui';
import { useElapsedSeconds } from '../../lib/hooks';
import { base64ToBytes, type CompileResult, type LatexStatus } from '../../lib/latex';
import { PdfCanvas } from './PdfCanvas';
import { Row } from './Diagnostics';
import { durationLabel, pagesLabel, warningLabel } from './helpers';
import s from './rules.module.css';

// The route table is typed loosely, so the target is a plain string like the nav rail's.
const SETTINGS: string = '/settings';

export interface CompileState {
  result: CompileResult | null;
  /** The text that was compiled, to say when the draft has moved on. */
  text: string;
  pending: boolean;
  error: string | null;
}

/** Result of "Test compile": pages, line-numbered errors, warnings, and page 1 of the PDF. */
export function CompilePanel({
  state,
  status,
  current,
  warming,
  onWarm,
  onJump,
}: {
  state: CompileState;
  status: LatexStatus | undefined;
  /** The text now in the editor. */
  current: string;
  warming: boolean;
  onWarm: () => void;
  onJump: (line: number) => void;
}): React.JSX.Element {
  const compileSecs = useElapsedSeconds(state.pending);
  const warmSecs = useElapsedSeconds(warming);
  const r = state.result;
  const bytes = useMemo(() => (r?.pdfBase64 ? base64ToBytes(r.pdfBase64) : null), [r]);

  if (status && status.engine === null)
    return (
      <EmptyState
        title="No LaTeX engine found."
        action={
          <Link to={SETTINGS} search={{ section: 'latex' }} className={s.link}>
            Set up in Settings
          </Link>
        }
      >
        Test compile needs Tectonic, a small local LaTeX engine.
      </EmptyState>
    );
  if (state.pending) return <Loading what={`Compiling the template · ${String(compileSecs)} s`} />;
  if (state.error) return <ErrorState title="Could not compile" message={state.error} />;
  if (!r)
    return (
      <p className={s.quiet}>
        Test compile builds this template with sample content, including your unsaved edits. Nothing is saved.
      </p>
    );

  if (r.cacheMissing)
    return (
      <div className={s.compile}>
        <p>LaTeX packages are not downloaded yet.</p>
        <p className={s.quiet}>The first compile needs about 43 MB and takes up to 2 minutes. Once only.</p>
        <Button variant="secondary" busy={warming} onClick={onWarm}>
          {warming ? 'Downloading…' : 'Download LaTeX packages'}
        </Button>
        {warming && <p className={s.quiet}>Downloading packages · {warmSecs} s</p>}
      </div>
    );

  return (
    <div className={s.compile}>
      <p className={s.compileHead}>
        <StatusDot tone={r.ok ? 'ok' : 'bad'}>{r.ok ? 'Compiled' : 'Failed'}</StatusDot>
        <span className={s.num}>{pagesLabel(r.pages)}</span>
        <span className={s.num}>{durationLabel(r.durationMs)}</span>
      </p>
      {state.text !== current && (
        <p className={s.quiet}>Edited since this compile; line numbers may have moved.</p>
      )}
      {r.errors.length > 0 && (
        <ul className={s.rows} aria-label="Compile errors">
          {r.errors.map((e, i) => (
            <li key={i}>
              <Row tone="bad" label="error" line={e.line} onJump={onJump}>
                {e.message}
              </Row>
            </li>
          ))}
        </ul>
      )}
      {r.warnings.length > 0 && (
        <ul className={s.rows} aria-label="Compile warnings">
          {r.warnings.map((w, i) => (
            <li key={i}>
              <Row tone="warn" label={warningLabel[w.kind]} onJump={onJump}>
                <span className={s.mono}>{w.message}</span>
              </Row>
            </li>
          ))}
        </ul>
      )}
      {bytes ? (
        <PdfCanvas bytes={bytes} label="PDF preview, page 1" />
      ) : (
        r.ok && <p className={s.quiet}>The PDF is over 5 MB, so no preview is shown.</p>
      )}
    </div>
  );
}
