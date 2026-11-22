import { useState } from 'react';
import { Button, Dialog, Field, Input, RadioGroup } from '../../ui';
import { DISMISS_REASONS, dismissReason } from './helpers';
import s from './inbox.module.css';

/** Asks why a job leaves the inbox. The reason is stored with the dismissal. */
export function DismissDialog({
  label,
  busy,
  onCancel,
  onConfirm,
}: {
  /** "Company · Title" of the job being dismissed; null keeps the dialog closed. */
  label: string | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}): React.JSX.Element {
  const [reason, setReason] = useState<string>(DISMISS_REASONS[0].value);
  const [note, setNote] = useState('');
  return (
    <Dialog
      open={label !== null}
      onOpenChange={(open) => {
        if (!open) {
          onCancel();
          setNote('');
          setReason(DISMISS_REASONS[0].value);
        }
      }}
      title="Dismiss this job"
      description={label}
      size="sm"
      footer={
        <>
          <Button onClick={onCancel}>Cancel</Button>
          <Button variant="primary" busy={busy} onClick={() => onConfirm(dismissReason(reason, note))}>
            Dismiss
          </Button>
        </>
      }
    >
      <form
        className={s.dismissForm}
        onSubmit={(e) => {
          e.preventDefault();
          onConfirm(dismissReason(reason, note));
        }}
      >
        <RadioGroup
          aria-label="Reason"
          value={reason}
          onValueChange={setReason}
          options={DISMISS_REASONS.map((r) => ({ value: r.value, label: r.label }))}
        />
        <Field label="Note (optional)" hint="Up to 200 characters, kept with the job.">
          {(p) => <Input {...p} value={note} maxLength={150} onChange={(e) => setNote(e.target.value)} />}
        </Field>
      </form>
    </Dialog>
  );
}
