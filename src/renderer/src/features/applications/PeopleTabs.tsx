import { useState } from 'react';
import { INTERVIEW_KINDS, INTERVIEW_OUTCOMES, type Contact, type Interview } from '@shared/tracker';
import {
  Button,
  ConfirmDialog,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Loading,
  Select,
  SectionHeader,
  StatusDot,
  Textarea,
  useToast,
} from '../../ui';
import type { Tone } from '../../ui/StatusDot';
import {
  useAddContact,
  useAddInterview,
  useContacts,
  useDeleteContact,
  useDeleteInterview,
  useLinkContact,
  useUnlinkContact,
  useUpdateContact,
  useUpdateInterview,
  type TrackerDetail,
} from '../../lib/tracker';
import { isWebUrl, humanize } from '../workspace/helpers';
import { formatWhen, fromLocalInput, toLocalInput } from './helpers';
import s from './applications.module.css';

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const OUTCOME_TONE: Record<Interview['outcome'], Tone> = {
  pending: 'info',
  passed: 'ok',
  failed: 'bad',
  cancelled: 'neutral',
};
const kindOptions = INTERVIEW_KINDS.map((k) => ({ value: k, label: humanize(k) }));
const outcomeOptions = INTERVIEW_OUTCOMES.map((k) => ({ value: k, label: humanize(k) }));

export function InterviewsTab({ data }: { data: TrackerDetail }): React.JSX.Element {
  const { toast } = useToast();
  const add = useAddInterview();
  const update = useUpdateInterview();
  const del = useDeleteInterview();
  const [editing, setEditing] = useState<Interview | 'new' | null>(null);
  const [removing, setRemoving] = useState<Interview | null>(null);
  const appId = data.application.id;
  const fail = (title: string) => (e: unknown) => toast({ title, description: errorText(e), tone: 'bad' });

  return (
    <div className={s.stack}>
      <SectionHeader
        title="Interview rounds"
        actions={
          <Button size="sm" onClick={() => setEditing('new')}>
            Add interview
          </Button>
        }
      />
      {data.interviews.length === 0 ? (
        <EmptyState title="No interviews yet">
          Add a round when one is scheduled. Rounds are numbered for you.
        </EmptyState>
      ) : (
        <ul className={s.rows}>
          {data.interviews.map((i) => (
            <li key={i.id} className={s.rowItem}>
              <div className={s.rowMain}>
                <span className={s.strong}>
                  Round {i.round} · {humanize(i.kind)}
                </span>
                <span className={s.mono}>{i.scheduledAt ? formatWhen(i.scheduledAt) : 'not scheduled'}</span>
                <StatusDot tone={OUTCOME_TONE[i.outcome]}>{humanize(i.outcome)}</StatusDot>
              </div>
              {i.notesMd && <p className={s.notes}>{i.notesMd}</p>}
              <div className={s.rowActions}>
                <Button size="sm" variant="ghost" onClick={() => setEditing(i)}>
                  Edit
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setRemoving(i)}>
                  Delete
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {editing && (
        <InterviewDialog
          key={editing === 'new' ? 'new' : editing.id}
          initial={editing === 'new' ? null : editing}
          busy={add.isPending || update.isPending}
          onClose={() => setEditing(null)}
          onSave={(v) => {
            const done = { onSuccess: () => setEditing(null), onError: fail('Could not save the interview') };
            if (editing === 'new') add.mutate({ applicationId: appId, ...v }, done);
            else update.mutate({ id: editing.id, patch: v }, done);
          }}
        />
      )}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={`Delete round ${String(removing?.round ?? '')}?`}
        description="The interview and its notes are removed."
        confirmLabel="Delete"
        danger
        onConfirm={() => removing && del.mutate(removing.id, { onError: fail('Could not delete') })}
      />
    </div>
  );
}

function InterviewDialog({
  initial,
  busy,
  onClose,
  onSave,
}: {
  initial: Interview | null;
  busy: boolean;
  onClose: () => void;
  onSave: (v: {
    kind: Interview['kind'];
    scheduledAt: string | null;
    outcome: Interview['outcome'];
    notesMd: string | null;
  }) => void;
}): React.JSX.Element {
  const [kind, setKind] = useState<Interview['kind']>(initial?.kind ?? 'screen');
  const [when, setWhen] = useState(toLocalInput(initial?.scheduledAt ?? null));
  const [outcome, setOutcome] = useState<Interview['outcome']>(initial?.outcome ?? 'pending');
  const [notes, setNotes] = useState(initial?.notesMd ?? '');
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={initial ? `Edit round ${String(initial.round)}` : 'Add interview'}
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            busy={busy}
            onClick={() =>
              onSave({
                kind,
                scheduledAt: fromLocalInput(when),
                outcome,
                notesMd: notes.trim() ? notes : null,
              })
            }
          >
            {initial ? 'Save' : 'Add interview'}
          </Button>
        </>
      }
    >
      <div className={s.form}>
        <Field label="Kind">
          {(p) => (
            <Select
              {...p}
              options={kindOptions}
              value={kind}
              onValueChange={(v) => setKind(v as Interview['kind'])}
            />
          )}
        </Field>
        <Field label="When">
          {(p) => (
            <Input {...p} type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
          )}
        </Field>
        <Field label="Outcome">
          {(p) => (
            <Select
              {...p}
              options={outcomeOptions}
              value={outcome}
              onValueChange={(v) => setOutcome(v as Interview['outcome'])}
            />
          )}
        </Field>
        <Field label="Notes">
          {(p) => <Textarea {...p} rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />}
        </Field>
      </div>
    </Dialog>
  );
}

export function ContactsTab({ data }: { data: TrackerDetail }): React.JSX.Element {
  const appId = data.application.id;
  const { toast } = useToast();
  const q = useContacts(appId);
  const add = useAddContact();
  const update = useUpdateContact();
  const del = useDeleteContact();
  const link = useLinkContact();
  const unlink = useUnlinkContact();
  const [editing, setEditing] = useState<Contact | 'new' | null>(null);
  const [removing, setRemoving] = useState<Contact | null>(null);
  const [toLink, setToLink] = useState('');
  const fail = (title: string) => (e: unknown) => toast({ title, description: errorText(e), tone: 'bad' });

  if (q.isPending) return <Loading what="Reading contacts" />;
  if (q.isError)
    return (
      <ErrorState
        title="Could not read the contacts"
        message={q.error.message}
        action={<Button onClick={() => void q.refetch()}>Try again</Button>}
      />
    );
  const { linked, available } = q.data;
  return (
    <div className={s.stack}>
      <SectionHeader
        title={`Contacts at ${data.job.company}`}
        actions={
          <Button size="sm" onClick={() => setEditing('new')}>
            Add contact
          </Button>
        }
      />
      {linked.length === 0 ? (
        <EmptyState title="No contacts linked">
          Add the recruiter or the hiring manager, or link one you saved before.
        </EmptyState>
      ) : (
        <ul className={s.rows}>
          {linked.map((c) => (
            <li key={c.id} className={s.rowItem}>
              <div className={s.rowMain}>
                <span className={s.strong}>{c.name}</span>
                {c.role && <span className={s.dim}>{c.role}</span>}
                {c.email && <span className={s.mono}>{c.email}</span>}
                {isWebUrl(c.linkedinUrl) && (
                  <a href={c.linkedinUrl} target="_blank" rel="noreferrer noopener" className={s.link}>
                    LinkedIn
                  </a>
                )}
              </div>
              {c.notesMd && <p className={s.notes}>{c.notesMd}</p>}
              <div className={s.rowActions}>
                <Button size="sm" variant="ghost" onClick={() => setEditing(c)}>
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    unlink.mutate(
                      { applicationId: appId, contactId: c.id },
                      { onSuccess: () => void q.refetch(), onError: fail('Could not unlink') },
                    )
                  }
                >
                  Unlink
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setRemoving(c)}>
                  Delete
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {available.length > 0 && (
        <div className={s.addRow}>
          <Select
            size="sm"
            aria-label="Link a saved contact"
            placeholder="Link a saved contact"
            value={toLink}
            onValueChange={setToLink}
            options={available.map((c) => ({ value: c.id, label: c.name }))}
          />
          <Button
            size="sm"
            disabled={!toLink}
            onClick={() =>
              link.mutate(
                { applicationId: appId, contactId: toLink },
                {
                  onSuccess: () => {
                    setToLink('');
                    void q.refetch();
                  },
                  onError: fail('Could not link'),
                },
              )
            }
          >
            Link
          </Button>
        </div>
      )}
      {editing && (
        <ContactDialog
          key={editing === 'new' ? 'new' : editing.id}
          initial={editing === 'new' ? null : editing}
          busy={add.isPending || update.isPending}
          onClose={() => setEditing(null)}
          onSave={(v) => {
            const done = {
              onSuccess: () => {
                setEditing(null);
                void q.refetch();
              },
              onError: fail('Could not save the contact'),
            };
            if (editing === 'new') add.mutate({ applicationId: appId, ...v }, done);
            else update.mutate({ id: editing.id, patch: v }, done);
          }}
        />
      )}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={`Delete ${removing?.name ?? 'contact'}?`}
        description="The contact is removed from every application it is linked to."
        confirmLabel="Delete"
        danger
        onConfirm={() =>
          removing &&
          del.mutate(removing.id, { onSuccess: () => void q.refetch(), onError: fail('Could not delete') })
        }
      />
    </div>
  );
}

function ContactDialog({
  initial,
  busy,
  onClose,
  onSave,
}: {
  initial: Contact | null;
  busy: boolean;
  onClose: () => void;
  onSave: (v: {
    name: string;
    role: string | null;
    email: string | null;
    linkedinUrl: string | null;
    notesMd: string | null;
  }) => void;
}): React.JSX.Element {
  const [name, setName] = useState(initial?.name ?? '');
  const [role, setRole] = useState(initial?.role ?? '');
  const [email, setEmail] = useState(initial?.email ?? '');
  const [linkedin, setLinkedin] = useState(initial?.linkedinUrl ?? '');
  const [notes, setNotes] = useState(initial?.notesMd ?? '');
  const orNull = (v: string): string | null => (v.trim() ? v.trim() : null);
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={initial ? 'Edit contact' : 'Add contact'}
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            busy={busy}
            disabled={!name.trim()}
            onClick={() =>
              onSave({
                name: name.trim(),
                role: orNull(role),
                email: orNull(email),
                linkedinUrl: orNull(linkedin),
                notesMd: orNull(notes),
              })
            }
          >
            {initial ? 'Save' : 'Add contact'}
          </Button>
        </>
      }
    >
      <div className={s.form}>
        <Field label="Name">
          {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} autoFocus />}
        </Field>
        <Field label="Role">
          {(p) => <Input {...p} value={role} onChange={(e) => setRole(e.target.value)} />}
        </Field>
        <Field label="Email">
          {(p) => <Input {...p} type="email" value={email} onChange={(e) => setEmail(e.target.value)} />}
        </Field>
        <Field label="LinkedIn">
          {(p) => <Input {...p} value={linkedin} onChange={(e) => setLinkedin(e.target.value)} />}
        </Field>
        <Field label="Notes">
          {(p) => <Textarea {...p} rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />}
        </Field>
      </div>
    </Dialog>
  );
}
