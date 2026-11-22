import { useState } from 'react';
import type { RulesFile } from '@shared/rules';
import { Button, ConfirmDialog, DiffView, ErrorState, Loading, diffLines } from '../../ui';
import { useResetPreview } from '../../lib/rules';
import s from './rules.module.css';

/** What "Reset to default" would change: the diff from the current file to the bundled default. */
export function DefaultTab({
  path,
  gitAvailable,
  blockedReason,
  resetting,
  onReset,
}: {
  path: RulesFile;
  gitAvailable: boolean;
  /** Why resetting is off right now (unsaved edits), or null. */
  blockedReason: string | null;
  resetting: boolean;
  onReset: () => void;
}): React.JSX.Element {
  const q = useResetPreview(path);
  const [confirm, setConfirm] = useState(false);

  if (q.isPending) return <Loading what="Reading the default" />;
  if (q.isError)
    return (
      <ErrorState
        title="Could not read the default"
        message={q.error.message}
        action={<Button onClick={() => void q.refetch()}>Retry</Button>}
      />
    );
  const same = q.data.current === q.data.seedDefault;
  return (
    <div className={s.detail}>
      <div className={s.detailHead}>
        <p className={s.detailTitle}>
          {same ? 'This file matches the default.' : 'Changes needed to get back to the default.'}
        </p>
        <Button disabled={same || blockedReason !== null} busy={resetting} onClick={() => setConfirm(true)}>
          {resetting ? 'Resetting…' : 'Reset to default'}
        </Button>
      </div>
      {blockedReason && !same && <p className={s.quiet}>{blockedReason}</p>}
      <div className={s.detailBody} role="region" aria-label="Diff to default" tabIndex={0}>
        <DiffView
          diff={diffLines(q.data.current, q.data.seedDefault)}
          ariaLabel="Current to default"
          leftLabel="Current"
          rightLabel="Default"
        />
      </div>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Reset to default?"
        description={
          gitAvailable
            ? 'The file goes back to the bundled default. Your current version is kept in history, so you can restore it.'
            : 'The file goes back to the bundled default. Your current version is copied to .stellio/backups/ first.'
        }
        confirmLabel="Reset"
        danger
        onConfirm={onReset}
      />
    </div>
  );
}
