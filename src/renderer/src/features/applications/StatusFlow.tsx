import { useNavigate } from '@tanstack/react-router';
import { ChevronDown } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { LANES, REJECT_STAGES, statusMetaProblem, type AppStatus, type StatusMeta } from '@shared/tracker';
import {
  Button,
  Dialog,
  DropdownMenu,
  Field,
  Input,
  RadioGroup,
  Textarea,
  useToast,
  type MenuEntry,
} from '../../ui';
import { useCreateApp, useSetStatus } from '../../lib/tracker';
import { STAGE_LABEL, STATUS_LABEL, dialogFor, isNoFinalResume } from './helpers';
import s from './applications.module.css';

/** What a status control knows about an application; `id` is null before the job has one. */
export interface StatusRef {
  id: string | null;
  jobId: string;
  status: AppStatus | null;
  company: string;
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Every status, grouped by lane, for a DropdownMenu. The current one is left out. */
export function statusMenuItems(current: AppStatus | null, pick: (to: AppStatus) => void): MenuEntry[] {
  const out: MenuEntry[] = [];
  for (const lane of LANES) {
    const items = lane.statuses.filter((st) => st !== current);
    if (items.length === 0) continue;
    if (out.length > 0) out.push('separator');
    for (const st of items) out.push({ label: STATUS_LABEL[st], onSelect: () => pick(st) });
  }
  return out;
}

/**
 * One path for every status change in the UI (board keys, table, detail, job page): asks the stage / reason
 * / freeze question when docs/08 §1 says so, creates the application on the first change, offers undo.
 */
export function useStatusFlow(): {
  request: (ref: StatusRef, to: AppStatus) => void;
  dialogs: ReactNode;
  /** A question dialog is open. */
  open: boolean;
} {
  const set = useSetStatus();
  const { toast } = useToast();
  const [pending, setPending] = useState<{ ref: StatusRef; to: AppStatus } | null>(null);
  const create = useCreateApp();

  const run = async (ref: StatusRef, to: AppStatus, meta?: StatusMeta): Promise<void> => {
    const id = ref.id ?? (await create.mutateAsync(ref.jobId)).id;
    await set.mutateAsync({ id, status: to, ...(meta ? { meta } : {}) });
  };

  const request = (ref: StatusRef, to: AppStatus): void => {
    if (ref.status === to) return;
    if (dialogFor(to)) return setPending({ ref, to });
    const previous = ref.status;
    run(ref, to).then(
      () =>
        toast({
          title: `Marked ${STATUS_LABEL[to].toLowerCase()}`,
          // Undo only where it is a plain change: a frozen apply or a status that asks a question is not.
          ...(previous && !dialogFor(previous) && ref.id
            ? {
                action: {
                  label: 'Undo',
                  onClick: () => {
                    set.mutate({ id: ref.id ?? '', status: previous });
                  },
                },
              }
            : {}),
        }),
      (e: unknown) => toast({ title: 'Could not change the status', description: errorText(e), tone: 'bad' }),
    );
  };

  const kind = pending ? dialogFor(pending.to) : null;
  const close = (): void => setPending(null);
  const dialogs = pending && (
    <>
      {kind === 'apply' && <ApplyDialog key="apply" ref_={pending.ref} onClose={close} run={run} />}
      {kind && kind !== 'apply' && (
        <AskDialog key={kind} kind={kind} ref_={pending.ref} to={pending.to} onClose={close} run={run} />
      )}
    </>
  );
  return { request, dialogs, open: pending !== null };
}

type Run = (ref: StatusRef, to: AppStatus, meta?: StatusMeta) => Promise<void>;

function AskDialog({
  kind,
  ref_,
  to,
  onClose,
  run,
}: {
  kind: 'stage' | 'reason' | 'offer';
  ref_: StatusRef;
  to: AppStatus;
  onClose: () => void;
  run: Run;
}): React.JSX.Element {
  const { toast } = useToast();
  const [stage, setStage] = useState<string>('');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [deadline, setDeadline] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const meta: StatusMeta = {
    ...(kind === 'stage' && stage ? { stage: stage as (typeof REJECT_STAGES)[number] } : {}),
    ...(kind === 'reason' ? { reason: reason.trim() } : {}),
    ...(kind === 'offer' && deadline ? { deadline } : {}),
    ...(note.trim() ? { note: note.trim() } : {}),
  };
  const problem = statusMetaProblem(to, meta);
  const submit = (): void => {
    setBusy(true);
    setError(null);
    run(ref_, to, meta).then(
      () => {
        toast({ title: `Marked ${STATUS_LABEL[to].toLowerCase()}` });
        onClose();
      },
      (e: unknown) => {
        setError(errorText(e));
        setBusy(false);
      },
    );
  };

  const title =
    kind === 'stage'
      ? `Mark ${ref_.company} as ${STATUS_LABEL[to].toLowerCase()}`
      : kind === 'reason'
        ? 'Why are you not applying?'
        : 'An offer came in';
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={title}
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={busy} disabled={problem !== null} onClick={submit}>
            {kind === 'stage' ? `Mark ${STATUS_LABEL[to].toLowerCase()}` : 'Save'}
          </Button>
        </>
      }
    >
      <div className={s.form}>
        {kind === 'stage' && (
          <Field label="At which stage?">
            {(p) => (
              <RadioGroup
                aria-label="Stage"
                aria-describedby={p['aria-describedby']}
                value={stage}
                onValueChange={setStage}
                options={REJECT_STAGES.map((v) => ({ value: v, label: STAGE_LABEL[v] }))}
              />
            )}
          </Field>
        )}
        {kind === 'reason' && (
          <Field label="Reason">
            {(p) => <Input {...p} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />}
          </Field>
        )}
        {kind === 'offer' && (
          <Field label="Respond by (optional)" hint="Shows up on Today as a deadline.">
            {(p) => (
              <Input {...p} type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
            )}
          </Field>
        )}
        {kind !== 'offer' && (
          <Field label="Note (optional)">
            {(p) => <Textarea {...p} rows={2} value={note} onChange={(e) => setNote(e.target.value)} />}
          </Field>
        )}
        {error && (
          <p role="alert" className={s.problem}>
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}

/** "I applied": explains the freeze, then sets `applied`. Without a final resume it says so and offers a forced apply. */
export function ApplyDialog({
  ref_,
  onClose,
  run,
  onMarkFinal,
}: {
  ref_: StatusRef;
  onClose: () => void;
  /** Defaults to creating the application when needed and setting the status. */
  run?: Run;
  /** Where "Mark a version final first" leads; defaults to the job page. */
  onMarkFinal?: () => void;
}): React.JSX.Element {
  const navigate = useNavigate();
  const { toast } = useToast();
  const set = useSetStatus();
  const create = useCreateApp();
  const [phase, setPhase] = useState<'confirm' | 'blocked' | 'force'>('confirm');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const exec: Run =
    run ??
    (async (r, to, meta) => {
      const id = r.id ?? (await create.mutateAsync(r.jobId)).id;
      await set.mutateAsync({ id, status: to, ...(meta ? { meta } : {}) });
    });
  const submit = (force: boolean): void => {
    setBusy(true);
    setError(null);
    exec(ref_, 'applied', force ? { force: true, forceReason: reason.trim() } : undefined).then(
      () => {
        toast({
          title: 'Marked applied',
          description: 'The documents are frozen in your applications folder.',
        });
        onClose();
      },
      (e: unknown) => {
        setBusy(false);
        const message = errorText(e);
        if (isNoFinalResume(message)) setPhase('blocked');
        else setError(message);
      },
    );
  };
  const markFinal = (): void => {
    onClose();
    if (onMarkFinal) onMarkFinal();
    else void navigate({ to: `/workspace/${ref_.jobId}` });
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={phase === 'confirm' ? 'Mark as applied?' : 'No final resume'}
      size="sm"
      description={
        phase === 'confirm'
          ? `Stellio copies the final resume, the cover letter if there is one, the job description and the fit analysis into a new folder in your applications folder, and commits it. That copy is the record of what you sent. It is never overwritten, even if you edit the drafts later.`
          : phase === 'blocked'
            ? 'There is no final resume for this job, so there is nothing to freeze as what you sent.'
            : 'Applying without a final resume freezes only the job description and the analysis. Say why, so the record is honest.'
      }
      footer={
        phase === 'confirm' ? (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" busy={busy} onClick={() => submit(false)}>
              I applied
            </Button>
          </>
        ) : phase === 'blocked' ? (
          <>
            <Button variant="ghost" onClick={() => setPhase('force')}>
              Apply without a final resume…
            </Button>
            <Button variant="primary" onClick={markFinal}>
              Mark a version final first
            </Button>
          </>
        ) : (
          <>
            <Button onClick={() => setPhase('blocked')}>Back</Button>
            <Button variant="danger" busy={busy} disabled={!reason.trim()} onClick={() => submit(true)}>
              Apply anyway
            </Button>
          </>
        )
      }
    >
      {phase === 'force' && (
        <div className={s.form}>
          <Field label="Why apply without a final resume?">
            {(p) => <Input {...p} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />}
          </Field>
        </div>
      )}
      {error && (
        <p role="alert" className={s.problem}>
          {error}
        </p>
      )}
    </Dialog>
  );
}

/** "Status: Applied" menu button; every change goes through `onPick`. */
export function StatusMenu({
  current,
  onPick,
  size,
}: {
  current: AppStatus | null;
  onPick: (to: AppStatus) => void;
  size?: 'md' | 'sm';
}): React.JSX.Element {
  return (
    <DropdownMenu
      align="end"
      items={statusMenuItems(current, onPick)}
      trigger={
        <Button size={size} icon={<ChevronDown aria-hidden="true" />}>
          Status: {current ? STATUS_LABEL[current] : 'Not started'}
        </Button>
      }
    />
  );
}
