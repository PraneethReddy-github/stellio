import { useState } from 'react';
import type { RulesFile } from '@shared/rules';
import {
  Button,
  ConfirmDialog,
  DiffView,
  EmptyState,
  ErrorState,
  Loading,
  Table,
  type Column,
} from '../../ui';
import { relativeTime } from '../profile/helpers';
import { useRulesChanges, useRulesHistory } from '../../lib/rules';
import s from './rules.module.css';

type Commit = { hash: string; date: string; message: string };

const absolute = (iso: string): string => iso.slice(0, 16).replace('T', ' ');
/** "11-19 21:57": the year is rarely needed, and the relative time is in the tooltip. */
const short = (iso: string): string => absolute(iso).slice(5);

const columns: Column<Commit>[] = [
  {
    id: 'date',
    header: 'Date',
    width: '112px',
    cell: (c) => <span title={relativeTime(c.date)}>{short(c.date)}</span>,
    mono: true,
  },
  { id: 'message', header: 'Message', cell: (c) => c.message },
];

export function RulesHistoryTab({
  path,
  gitAvailable,
  blockedReason,
  restoring,
  onRestore,
}: {
  path: RulesFile;
  gitAvailable: boolean;
  /** Why restoring is off right now (unsaved edits), or null. */
  blockedReason: string | null;
  restoring: boolean;
  onRestore: (commit: Commit) => void;
}): React.JSX.Element {
  const history = useRulesHistory(path);
  const [selected, setSelected] = useState<string>();
  const [confirm, setConfirm] = useState(false);
  const commits = history.data ?? [];
  const current = commits.find((c) => c.hash === selected) ?? commits[0];
  const isNewest = current?.hash === commits[0]?.hash;
  const changes = useRulesChanges(path, gitAvailable && current ? current.hash : null);

  if (!gitAvailable)
    return (
      <EmptyState title="No version history">
        Git is not installed. Before each save Stellio copies the current file to .stellio/backups/ instead.
      </EmptyState>
    );
  if (history.isPending) return <Loading what="Reading history" />;
  if (history.isError)
    return (
      <ErrorState
        title="Could not read history"
        message={history.error.message}
        action={<Button onClick={() => void history.refetch()}>Retry</Button>}
      />
    );
  if (commits.length === 0)
    return <EmptyState title="No saved versions yet">Each save is recorded here with a diff.</EmptyState>;

  return (
    <div className={s.history}>
      <div className={s.historyList}>
        <Table
          ariaLabel="Versions"
          columns={columns}
          rows={commits}
          getRowId={(c) => c.hash}
          selectedId={current?.hash}
          onSelectedChange={setSelected}
        />
      </div>
      {current && (
        <div className={s.detail}>
          <div className={s.detailHead}>
            <div>
              <p className={s.detailTitle}>{current.message}</p>
              <p className={s.mono}>
                {current.hash.slice(0, 8)} · {absolute(current.date)}
              </p>
            </div>
            {isNewest ? (
              <p className={s.quiet}>Current version</p>
            ) : (
              <Button disabled={blockedReason !== null} busy={restoring} onClick={() => setConfirm(true)}>
                {restoring ? 'Restoring…' : 'Restore this version'}
              </Button>
            )}
          </div>
          {blockedReason && !isNewest && <p className={s.quiet}>{blockedReason}</p>}
          <div className={s.detailBody} role="region" aria-label="Diff" tabIndex={0}>
            {changes.isPending ? (
              <Loading what="Reading changes" />
            ) : changes.isError ? (
              <ErrorState title="Could not read this change" message={changes.error.message} />
            ) : (
              <DiffView
                diff={changes.data.diff}
                ariaLabel={`Changes in ${current.hash.slice(0, 8)}`}
                leftLabel="Before"
                rightLabel="After"
              />
            )}
          </div>
          <ConfirmDialog
            open={confirm}
            onOpenChange={setConfirm}
            title="Restore this version?"
            description="Your current file is kept in history first."
            confirmLabel="Restore"
            onConfirm={() => onRestore(current)}
          />
        </div>
      )}
    </div>
  );
}
