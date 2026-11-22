import { useState } from 'react';
import type { Schedule } from '@shared/discovery/schemas';
import {
  Button,
  CodeEditor,
  ConfirmDialog,
  Dialog,
  ErrorState,
  Field,
  Input,
  KeyValue,
  Loading,
  SectionHeader,
  StatusDot,
  Switch,
  useToast,
} from '../../ui';
import {
  useSchedule,
  useSetSchedule,
  useTimerInstall,
  useTimerPreview,
  useTimerRemove,
  useTimerStatus,
} from '../../lib/discovery';
import { formatWhen } from '../applications/helpers';
import { isScanTime } from './discoveryHelpers';
import s from './settings.module.css';

export function ScheduleSection(): React.JSX.Element {
  const q = useSchedule();
  return (
    <section id="settings-schedule" className={s.section} aria-label="Schedule">
      <SectionHeader title="Schedule" level={3} />
      {q.isPending ? (
        <Loading what="Reading the schedule" />
      ) : q.isError ? (
        <ErrorState
          title="Could not read the schedule"
          message={q.error.message}
          action={<Button onClick={() => void q.refetch()}>Retry</Button>}
        />
      ) : (
        <>
          <InApp schedule={q.data} />
          <Timer />
        </>
      )}
    </section>
  );
}

function InApp({ schedule }: { schedule: Schedule }): React.JSX.Element {
  const set = useSetSchedule();
  const { toast } = useToast();
  const [time, setTime] = useState(schedule.time);
  const save = (next: Schedule): void =>
    set.mutate(next, {
      onError: (e) => toast({ title: 'Could not save the schedule', description: e.message, tone: 'bad' }),
    });
  const bad = !isScanTime(time);
  return (
    <div className={s.stack}>
      <Switch
        label="Scan once a day while Stellio is open"
        checked={schedule.enabled}
        onCheckedChange={(enabled) => save({ ...schedule, enabled })}
      />
      <div className={s.fields}>
        <Field
          label="Scan time"
          hint="Local time, 24-hour HH:MM."
          error={bad ? 'Use HH:MM, e.g. 08:00.' : undefined}
        >
          {(p) => (
            <Input
              {...p}
              inputMode="numeric"
              placeholder="08:00"
              value={time}
              onChange={(e) => {
                setTime(e.target.value);
                if (isScanTime(e.target.value)) save({ ...schedule, time: e.target.value });
              }}
            />
          )}
        </Field>
      </div>
      <p className={s.quiet}>
        Off by default: a scan uses Claude usage. If the app was closed at that time, it scans on the next
        start when the last scan is over a day old.
      </p>
    </div>
  );
}

function Timer(): React.JSX.Element {
  const st = useTimerStatus();
  const install = useTimerInstall();
  const remove = useTimerRemove();
  const { toast } = useToast();
  const [previewing, setPreviewing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const t = st.data;

  return (
    <div className={s.stack}>
      <h4 className={s.subTitle}>Run when the app is closed</h4>
      <p className={s.quiet}>
        A systemd user timer starts a headless scan at the scan time above, even if Stellio is not running.
        Nothing is written until you confirm the unit files.
      </p>
      {st.isPending ? (
        <Loading what="Asking systemd" />
      ) : st.isError ? (
        <ErrorState
          title="Could not read the timer"
          message={st.error.message}
          action={<Button onClick={() => void st.refetch()}>Retry</Button>}
        />
      ) : (
        t && (
          <>
            <KeyValue
              items={[
                {
                  key: 'Timer',
                  value: t.unavailable ? (
                    <StatusDot tone="warn">systemd is not available in this session</StatusDot>
                  ) : t.installed ? (
                    <StatusDot tone={t.active ? 'ok' : 'warn'}>
                      Installed{t.active ? ', active' : ', not active'}
                    </StatusDot>
                  ) : (
                    <StatusDot tone="neutral">Not installed</StatusDot>
                  ),
                },
                ...(t.installed
                  ? [
                      { key: 'Runs at', value: t.time ?? '—', mono: true },
                      { key: 'Next run', value: t.nextRun ? formatWhen(t.nextRun) : '—', mono: true },
                    ]
                  : []),
              ]}
            />
            <div className={s.buttons}>
              <Button onClick={() => setPreviewing(true)}>{t.installed ? 'Reinstall…' : 'Install…'}</Button>
              {t.installed && (
                <Button busy={remove.isPending} onClick={() => setRemoving(true)}>
                  Remove
                </Button>
              )}
            </div>
          </>
        )
      )}
      {previewing && (
        <PreviewDialog
          busy={install.isPending}
          error={install.error?.message ?? null}
          onCancel={() => setPreviewing(false)}
          onConfirm={() =>
            install.mutate(undefined, {
              onSuccess: () => {
                setPreviewing(false);
                toast({ title: 'Timer installed', tone: 'ok' });
              },
            })
          }
        />
      )}
      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        title="Remove the timer?"
        description="The two unit files are deleted and the timer stops. Scans in the app keep working."
        confirmLabel="Remove timer"
        danger
        onConfirm={() =>
          remove.mutate(undefined, {
            onSuccess: () => toast({ title: 'Timer removed', tone: 'neutral' }),
            onError: (e) =>
              toast({ title: 'Could not remove the timer', description: e.message, tone: 'bad' }),
          })
        }
      />
    </div>
  );
}

function PreviewDialog({
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}): React.JSX.Element {
  const q = useTimerPreview(true);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      title="Install the scan timer"
      description="These two files will be written, then the timer is enabled with systemctl --user."
      size="lg"
      footer={
        <>
          <Button onClick={onCancel}>Cancel</Button>
          <Button variant="primary" busy={busy} disabled={!q.data} onClick={onConfirm}>
            Install timer
          </Button>
        </>
      }
    >
      {q.isPending ? (
        <Loading what="Preparing the unit files" />
      ) : q.isError ? (
        <ErrorState title="Could not prepare the unit files" message={q.error.message} />
      ) : (
        <div className={s.stack}>
          {[q.data.service, q.data.timer].map((u) => (
            <div key={u.path} className={s.unit}>
              <p className={s.mono}>{u.path}</p>
              <CodeEditor
                language="markdown"
                readOnly
                ariaLabel={`Unit file ${u.path.split('/').pop() ?? ''}`}
                value={u.content}
                height={Math.min(220, 28 + 20 * u.content.split('\n').length)}
              />
            </div>
          ))}
          {error && (
            <p className={s.error} role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </Dialog>
  );
}
