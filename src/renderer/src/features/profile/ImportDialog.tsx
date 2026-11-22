import { useMemo, type RefObject } from 'react';
import { parseProfile, type Profile } from '@shared/profile';
import type { IpcOutput } from '@shared/ipc/contract';
import { Button, DiffView, Dialog, ErrorState, KeyValue, diffLines } from '../../ui';
import { diagnosticsSummary, sortDiagnostics } from './helpers';
import s from './profile.module.css';

export type ImportDraft = Extract<IpcOutput<'profile:importFromFile'>, { status: 'draft' }>;

const SECTIONS: { label: string; count: (m: Profile) => number }[] = [
  { label: 'Skills', count: (m) => m.skills.length },
  { label: 'Experience', count: (m) => m.experience.length },
  { label: 'Projects', count: (m) => m.projects.length },
  { label: 'Education', count: (m) => m.education.length },
];

/** Review step: nothing is written until "Replace profile". */
export function ImportDialog({
  result,
  current,
  dirty,
  saving,
  error,
  returnFocus,
  onReplace,
  onClose,
}: {
  result: ImportDraft;
  /** Markdown the import would replace (the current draft). */
  current: string;
  /** The current draft has unsaved edits, which the import also replaces. */
  dirty: boolean;
  saving: boolean;
  error: string | null;
  /** The import button is disabled while drafting, so focus is sent there explicitly. */
  returnFocus: RefObject<HTMLElement | null>;
  onReplace: () => void;
  onClose: () => void;
}): React.JSX.Element {
  const incoming = result.draft.model;
  const now = useMemo(() => parseProfile(current).model, [current]);
  const diff = useMemo(() => diffLines(current, result.draft.markdown), [current, result.draft.markdown]);
  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      size="lg"
      returnFocus={returnFocus}
      title={`Review import from ${result.sourceName}`}
      description={
        dirty
          ? 'Your current profile is kept in history. Your unsaved edits are not.'
          : 'Your current profile is kept in history.'
      }
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={saving} onClick={onReplace}>
            {saving ? 'Replacing…' : 'Replace profile'}
          </Button>
        </>
      }
    >
      <div className={s.reviewBody}>
        {error && <ErrorState title="Could not replace the profile" message={error} />}
        <KeyValue
          items={[
            ...SECTIONS.map(({ label, count }) => {
              const before = count(now);
              const after = count(incoming);
              return {
                key: label,
                mono: true,
                value: (
                  <>
                    {before} → <span className={after < before ? s.dropped : undefined}>{after}</span>
                  </>
                ),
              };
            }),
            { key: 'Problems', value: diagnosticsSummary(sortDiagnostics(result.draft.diagnostics)) },
          ]}
        />
        <div className={s.reviewDiff} role="region" aria-label="Diff" tabIndex={0}>
          <DiffView
            diff={diff}
            leftLabel="Current"
            rightLabel="Import"
            ariaLabel="Current profile against import"
          />
        </div>
      </div>
    </Dialog>
  );
}
