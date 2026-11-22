import { useState } from 'react';
import type { BackupEntry } from '@shared/backups';
import { Button, ConfirmDialog, ErrorState, Loading, SectionHeader, useToast } from '../../ui';
import {
  formatBytes,
  useBackups,
  useCreateBackup,
  useOpenBackupsFolder,
  useRestoreBackup,
} from '../../lib/backups';
import { formatWhen } from '../applications/helpers';
import s from './settings.module.css';

const KIND_LABEL: Record<BackupEntry['kind'], string> = {
  database: 'Database',
  profile: 'Profile copy',
  rules: 'Rules copy',
};

export function BackupsSection(): React.JSX.Element {
  const q = useBackups();
  const create = useCreateBackup();
  const restore = useRestoreBackup();
  const openFolder = useOpenBackupsFolder();
  const { toast } = useToast();
  const [target, setTarget] = useState<BackupEntry | null>(null);
  const [restarting, setRestarting] = useState(false);

  return (
    <section id="settings-backups" className={s.section} aria-label="Backups">
      <SectionHeader title="Backups" level={3} />
      <p className={s.quiet}>
        Stellio keeps a database snapshot every day, before each upgrade, and whenever you ask. Profile and
        rules files are copied here when they are replaced and git is not available.
      </p>
      <div className={s.buttons}>
        <Button
          busy={create.isPending}
          onClick={() =>
            create.mutate(undefined, {
              onSuccess: (b) => toast({ title: 'Backup written', description: b.name, tone: 'ok' }),
              onError: (e) => toast({ title: 'Could not back up', description: e.message, tone: 'bad' }),
            })
          }
        >
          Back up now
        </Button>
        <Button
          variant="ghost"
          onClick={() =>
            openFolder.mutate(undefined, {
              onError: (e) =>
                toast({ title: 'Could not open the folder', description: e.message, tone: 'bad' }),
            })
          }
        >
          Open folder
        </Button>
      </div>
      {q.isPending ? (
        <Loading what="Reading backups" />
      ) : q.isError ? (
        <ErrorState
          title="Could not read the backups"
          message={q.error.message}
          action={<Button onClick={() => void q.refetch()}>Retry</Button>}
        />
      ) : q.data.length === 0 ? (
        <p className={s.quiet}>No backups yet.</p>
      ) : (
        <table className={s.rows} aria-label="Backups">
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col">Kind</th>
              <th scope="col">File</th>
              <th scope="col">Size</th>
              <th scope="col">
                <span className={s.srOnly}>Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {q.data.map((b) => (
              <tr key={b.name}>
                <td className={s.mono}>{formatWhen(b.createdAt)}</td>
                <td>{KIND_LABEL[b.kind]}</td>
                <td className={s.mono}>{b.name}</td>
                <td className={s.mono}>{formatBytes(b.sizeBytes)}</td>
                <td className={s.end}>
                  {b.restorable && (
                    <Button size="sm" aria-label={`Restore ${b.name}`} onClick={() => setTarget(b)}>
                      Restore…
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <ConfirmDialog
        open={target !== null}
        onOpenChange={(open) => {
          if (!open) setTarget(null);
        }}
        title="Restore this backup?"
        description={
          <>
            Stellio replaces its database with <span className={s.code}>{target?.name}</span> and restarts.
            The current database is saved as a backup first, so you can undo this. Profile, rules and
            documents on disk are not touched.
          </>
        }
        confirmLabel="Restore and restart"
        danger
        onConfirm={() => {
          if (!target) return;
          restore.mutate(target.name, {
            onSuccess: () => setRestarting(true),
            onError: (e) => toast({ title: 'Nothing was restored', description: e.message, tone: 'bad' }),
          });
        }}
      />
      {restarting && (
        <p role="status" className={s.quiet}>
          Restored. Stellio is restarting…
        </p>
      )}
    </section>
  );
}
