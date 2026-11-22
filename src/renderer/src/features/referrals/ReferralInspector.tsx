import { Copy } from 'lucide-react';
import { useRef, useState } from 'react';
import { CANCELLED_MESSAGE } from '@shared/messages';
import type { ReferralStatus } from '@shared/referrals';
import {
  Button,
  ConfirmDialog,
  Field,
  IconButton,
  Input,
  SectionHeader,
  Select,
  StatusDot,
  Tag,
  useToast,
} from '../../ui';
import { useElapsedSeconds } from '../../lib/hooks';
import { cancelTask } from '../../lib/jobs';
import { useRulesFile } from '../../lib/rules';
import {
  useDeletePerson,
  useDraftMessage,
  useSetReferralStatus,
  type ReferralItem,
} from '../../lib/referrals';
import { isWebUrl } from '../workspace/helpers';
import {
  LANGUAGE_LABEL,
  PROFILE_KIND_LABEL,
  STATUS_LABEL,
  STATUS_OPTIONS,
  STATUS_TONE,
  contactedText,
  followUpText,
  linkLabel,
  noteLimit,
} from './helpers';
import s from './referrals.module.css';

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** An external link: main opens it in the OS browser. Non-web values are shown as plain text. */
function Ext({ url, children }: { url: string; children?: React.ReactNode }): React.JSX.Element {
  return isWebUrl(url) ? (
    <a href={url} target="_blank" rel="noreferrer noopener" className={s.link}>
      {children ?? linkLabel(url)}
    </a>
  ) : (
    <span className={s.mono}>{url}</span>
  );
}

function CopyButton({ label, value }: { label: string; value: string }): React.JSX.Element {
  const { toast } = useToast();
  return (
    <IconButton
      size="sm"
      label={`Copy ${label}`}
      icon={<Copy />}
      disabled={!value}
      onClick={() => {
        navigator.clipboard.writeText(value).then(
          () => toast({ title: `${label} copied` }),
          (e: unknown) => toast({ title: 'Could not copy', description: errorText(e), tone: 'bad' }),
        );
      }}
    />
  );
}

/** Person, facts with their sources, the drafted message, outreach status. Everything is read-only except status. */
export function ReferralInspector({
  item,
  onDeleted,
}: {
  item: ReferralItem;
  onDeleted: () => void;
}): React.JSX.Element {
  const p = item.person;
  return (
    <div className={s.inspectorBody}>
      <div>
        <h3 className={s.personName}>{p.fullName}</h3>
        <p className={s.dimLine}>{[p.title, p.company].filter(Boolean).join(' · ')}</p>
        {p.locationText && <p className={s.dimLine}>{p.locationText}</p>}
        {item.why && <p className={s.prose}>{item.why}</p>}
      </div>

      <section className={s.block} aria-label="Profile links">
        <SectionHeader title="Profile links" level={3} />
        <ul className={s.plain}>
          {p.profileUrls.map((u) => (
            <li key={u.url} className={s.linkRow}>
              <span className={s.dim}>{PROFILE_KIND_LABEL[u.kind] ?? 'Profile'}</span>
              <Ext url={u.url} />
            </li>
          ))}
        </ul>
      </section>

      <section className={s.block} aria-label="Facts and sources">
        <SectionHeader title="Facts and sources" level={3} />
        {p.sources.every((src) => src.facts.length === 0) ? (
          <p className={s.dim}>No facts stored.</p>
        ) : (
          <ul className={s.plain}>
            {p.sources.flatMap((src) =>
              src.facts.map((fact) => (
                <li key={`${src.url}\n${fact}`} className={s.fact}>
                  <span>{fact}</span>
                  <span className={s.source}>
                    <Ext url={src.url} /> <span className={s.dim}>seen {src.seen_at.slice(0, 10)}</span>
                  </span>
                </li>
              )),
            )}
          </ul>
        )}
      </section>

      <section className={s.block} aria-label="Published contact">
        <SectionHeader title="Published contact" level={3} />
        {p.publicContact.length === 0 ? (
          <p className={s.dim}>None published. Stellio never guesses an address.</p>
        ) : (
          <ul className={s.plain}>
            {p.publicContact.map((c) => (
              <li key={`${c.kind}${c.value}`} className={s.fact}>
                <span className={s.contact}>
                  {isWebUrl(c.value) ? <Ext url={c.value} /> : <span className={s.mono}>{c.value}</span>}
                  <CopyButton label={c.kind === 'email' ? 'email' : 'contact'} value={c.value} />
                </span>
                <span className={s.source}>
                  published at <Ext url={c.source_url} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {p.sharedGround.length > 0 && (
        <section className={s.block} aria-label="Shared ground">
          <SectionHeader title="Shared ground" level={3} />
          <div className={s.tags}>
            {p.sharedGround.map((g) => (
              <Tag key={g}>{g}</Tag>
            ))}
          </div>
        </section>
      )}

      <Draft item={item} />
      <Outreach key={`${item.id}:${item.status}:${item.notesMd ?? ''}`} item={item} />
      <Remove item={item} onDeleted={onDeleted} />
    </div>
  );
}

function Draft({ item }: { item: ReferralItem }): React.JSX.Element {
  const draft = useDraftMessage();
  const rules = useRulesFile('rules/referral-message.md');
  const { toast } = useToast();
  const requestId = useRef<string | null>(null);
  const secs = useElapsedSeconds(draft.isPending);
  const limit = noteLimit(rules.data?.content);
  const note = item.noteText ?? '';
  const checks = item.checks;
  const dirty = checks !== null && !checks.ok;

  const start = (): void => {
    if (!item.jobId || draft.isPending) return;
    requestId.current = crypto.randomUUID();
    draft.mutate(
      { personId: item.personId, jobId: item.jobId, requestId: requestId.current },
      {
        onError: (e) =>
          e.message === CANCELLED_MESSAGE
            ? toast({ title: 'Cancelled' })
            : toast({ title: 'Could not draft the message', description: e.message, tone: 'bad' }),
      },
    );
  };

  return (
    <section className={s.block} aria-label="Message">
      <SectionHeader
        title="Message"
        level={3}
        actions={
          draft.isPending ? (
            <Button
              size="sm"
              onClick={() => {
                if (requestId.current) void cancelTask(requestId.current);
              }}
            >
              Cancel
            </Button>
          ) : (
            <Button size="sm" variant={note ? 'secondary' : 'primary'} onClick={start} disabled={!item.jobId}>
              {note ? 'Redraft' : 'Draft message'}
            </Button>
          )
        }
      />
      {draft.isPending && (
        <p className={s.mono} role="status">
          drafting · {secs} s
        </p>
      )}
      {!item.jobId && <p className={s.dim}>This person was found without a job. Drafting needs a job.</p>}
      {note ? (
        <>
          <div className={s.draftBlock}>
            <div className={s.draftHead}>
              <span className={s.label}>Connection note</span>
              <span className={s.mono} data-over={note.length > limit || undefined}>
                {note.length} / {limit} characters
              </span>
              <CopyButton label="connection note" value={note} />
            </div>
            <p className={s.pre}>{note}</p>
          </div>
          <div className={s.draftBlock}>
            <div className={s.draftHead}>
              <span className={s.label}>Subject</span>
              <CopyButton label="subject" value={item.messageSubject ?? ''} />
            </div>
            <p className={s.pre}>{item.messageSubject}</p>
          </div>
          <div className={s.draftBlock}>
            <div className={s.draftHead}>
              <span className={s.label}>Message</span>
              <CopyButton label="message" value={item.messageBody ?? ''} />
            </div>
            <p className={s.pre}>{item.messageBody}</p>
          </div>
          <p className={s.mono}>
            {LANGUAGE_LABEL[item.language ?? ''] ?? item.language ?? 'unknown language'}
            {item.model ? ` · ${item.model}` : ''}
          </p>
          {dirty ? (
            <div className={s.checks} role="alert">
              <p className={s.strong}>This draft failed checks. Fix it before you send it.</p>
              <ul className={s.plain}>
                {checks.lint.map((l) => (
                  <li key={`l-${l.rule}-${l.message}`}>
                    Rules ({l.rule}): {l.message}
                  </li>
                ))}
                {checks.truth.map((t) => (
                  <li key={`t-${t.kind}-${t.text}`}>
                    Truth ({t.kind}): “{t.text}”. {t.detail}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            checks && (
              <p className={s.dim}>
                <StatusDot tone="ok">Rules and truth checks passed</StatusDot>
              </p>
            )
          )}
          {checks && checks.warnings.length > 0 && (
            <ul className={s.plain}>
              {checks.warnings.map((w) => (
                <li key={w} className={s.dim}>
                  {w}
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        !draft.isPending &&
        item.jobId && (
          <p className={s.dim}>
            No message yet. Drafting uses one Claude run and follows rules/referral-message.md.
          </p>
        )
      )}
    </section>
  );
}

function Outreach({ item }: { item: ReferralItem }): React.JSX.Element {
  const setStatus = useSetReferralStatus();
  const { toast } = useToast();
  const [status, setLocal] = useState<ReferralStatus>(item.status);
  const [note, setNote] = useState('');
  const changed = status !== item.status || note.trim() !== '';
  const follow = followUpText(item, false);
  const contacted = contactedText(item);
  return (
    <section className={s.block} aria-label="Outreach">
      <SectionHeader title="Outreach" level={3} />
      <p className={s.dim}>
        <StatusDot tone={STATUS_TONE[item.status]}>{STATUS_LABEL[item.status]}</StatusDot>
        {contacted && <span className={s.mono}> · contacted {contacted}</span>}
        {follow && <span className={s.mono}> · follow up {follow}</span>}
      </p>
      <Field label="Status">
        {(f) => (
          <Select
            {...f}
            size="sm"
            value={status}
            onValueChange={(v) => setLocal(v as ReferralStatus)}
            options={STATUS_OPTIONS}
          />
        )}
      </Field>
      <Field label="Note (optional)">
        {(f) => (
          <Input
            {...f}
            size="sm"
            value={note}
            maxLength={2000}
            placeholder="e.g. Sent on LinkedIn"
            onChange={(e) => setNote(e.target.value)}
          />
        )}
      </Field>
      <div>
        <Button
          size="sm"
          disabled={!changed}
          busy={setStatus.isPending}
          onClick={() =>
            setStatus.mutate(
              { id: item.id, status, note: note.trim() || undefined },
              {
                onSuccess: () => toast({ title: `Marked ${STATUS_LABEL[status].toLowerCase()}` }),
                onError: (e) =>
                  toast({ title: 'Could not save the status', description: e.message, tone: 'bad' }),
              },
            )
          }
        >
          Save status
        </Button>
      </div>
      {item.notesMd && <p className={s.pre}>{item.notesMd}</p>}
    </section>
  );
}

function Remove({ item, onDeleted }: { item: ReferralItem; onDeleted: () => void }): React.JSX.Element {
  const del = useDeletePerson();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  return (
    <section className={s.block} aria-label="Delete">
      <div>
        <Button size="sm" variant="danger" onClick={() => setOpen(true)}>
          Delete person
        </Button>
      </div>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={`Delete ${item.person.fullName}?`}
        description="The person, their sources and every request and message for them are removed. This cannot be undone."
        confirmLabel="Delete person"
        danger
        onConfirm={() =>
          del.mutate(item.personId, {
            onSuccess: () => {
              toast({ title: 'Person deleted' });
              onDeleted();
            },
            onError: (e) =>
              toast({ title: 'Could not delete the person', description: e.message, tone: 'bad' }),
          })
        }
      />
    </section>
  );
}
