import { noteLines } from '@shared/settings/updates';
import {
  cancelUpdate,
  mb,
  updateProgressText,
  useInstallUpdate,
  useRestartForUpdate,
  useUpdateDialog,
  useUpdateStatus,
} from '../lib/updates';
import { Button, Dialog, ProgressLine } from '../ui';
import s from './UpdateDialog.module.css';

/** Release notes, then download + install, then restart. Lives in the shell, so closing it never stops an install. */
export function UpdateDialog(): React.JSX.Element | null {
  const { open, setOpen } = useUpdateDialog();
  const status = useUpdateStatus().data;
  const install = useInstallUpdate();
  const restart = useRestartForUpdate();
  const update = status?.available;
  if (!update) return null;
  const ready = status.installed === update.version;
  const p = install.progress;

  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      title={`Stellio ${update.version}`}
      description={`You have ${status.current}.${update.size === null ? '' : ` The download is ${mb(update.size)}.`}`}
      footer={
        <>
          <a href={update.url} target="_blank" rel="noreferrer noopener" className={s.link}>
            Release page
          </a>
          {install.isPending ? (
            <Button disabled={p?.phase === 'install'} onClick={() => void cancelUpdate()}>
              Cancel download
            </Button>
          ) : (
            <Button onClick={() => setOpen(false)}>Later</Button>
          )}
          {ready ? (
            <Button variant="primary" busy={restart.isPending} onClick={() => restart.mutate()}>
              Restart Stellio
            </Button>
          ) : (
            update.installable && (
              <Button
                variant="primary"
                busy={install.isPending}
                onClick={() => install.mutate(update.version)}
              >
                {install.isPending ? 'Updating…' : 'Download and install'}
              </Button>
            )
          )}
        </>
      }
    >
      <div className={s.notes} tabIndex={0} role="region" aria-label="What is new">
        {update.notes.map((n) => (
          <section key={n.version} aria-label={`Version ${n.version}`}>
            <h3 className={s.version}>{n.version}</h3>
            {noteLines(n.body).length === 0 ? (
              <p className={s.quiet}>No notes for this version.</p>
            ) : (
              noteLines(n.body).map((l, i) => (
                <p key={i} className={l.item ? s.item : undefined} data-depth={l.depth}>
                  {l.text}
                </p>
              ))
            )}
          </section>
        ))}
      </div>
      <div role="status" className={s.state}>
        {p && (
          <>
            <ProgressLine
              label="Updating Stellio"
              value={p.phase === 'download' && p.total > 0 ? p.received / p.total : undefined}
            />
            <span className={s.mono}>{updateProgressText(p)}</span>
          </>
        )}
        {ready && <p>Installed. Restart Stellio to use it; a running task would be stopped.</p>}
        {!ready && !update.installable && (
          <p className={s.quiet}>This copy cannot update itself. Download it from the release page.</p>
        )}
        {install.isError && <p className={s.error}>{install.error.message}</p>}
        {restart.isError && <p className={s.error}>{restart.error.message}</p>}
      </div>
    </Dialog>
  );
}
