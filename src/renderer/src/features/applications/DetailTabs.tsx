import { useNavigate } from '@tanstack/react-router';
import { FolderOpen } from 'lucide-react';
import { useState } from 'react';
import {
  Button,
  Dialog,
  EmptyState,
  Field,
  Input,
  KeyValue,
  ScoreMeter,
  SectionHeader,
  Table,
  Tag,
  Textarea,
  useToast,
  type Column,
} from '../../ui';
import { openFolder, useAddNote, useUpdateApp, type TrackerDetail } from '../../lib/tracker';
import { FIT_THRESHOLDS, VERDICT_LABEL, VERDICT_TONE, isoDay } from '../workspace/helpers';
import { dayOrNull, describeEvent, dueText, formatWhen, isOverdue } from './helpers';
import s from './applications.module.css';

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function OverviewTab({ data }: { data: TrackerDetail }): React.JSX.Element {
  const { application: app, events } = data;
  const { toast } = useToast();
  const update = useUpdateApp();
  const note = useAddNote();
  const [notes, setNotes] = useState(app.notesMd ?? '');
  const [entry, setEntry] = useState('');
  const [editing, setEditing] = useState(false);
  const [action, setAction] = useState(app.nextAction ?? '');
  const [due, setDue] = useState(app.nextActionAt ? app.nextActionAt.slice(0, 10) : '');
  const fail = (title: string) => (e: unknown) => toast({ title, description: errorText(e), tone: 'bad' });
  const now = new Date();

  return (
    <div className={s.stack}>
      <section aria-label="Next action" className={s.block}>
        <SectionHeader
          title="Next action"
          actions={
            <>
              <Button
                size="sm"
                disabled={note.isPending}
                onClick={() =>
                  note.mutate(
                    { id: app.id, text: 'Followed up', kind: 'follow_up' },
                    {
                      onSuccess: () => toast({ title: 'Follow-up logged' }),
                      onError: fail('Could not log it'),
                    },
                  )
                }
              >
                Log a follow-up
              </Button>
              <Button size="sm" onClick={() => setEditing(true)}>
                Set next action
              </Button>
            </>
          }
        />
        {app.nextAction ? (
          <p className={s.nextLine}>
            <span>{app.nextAction}</span>
            {app.nextActionAt && (
              <span className={app.nextActionAt && isOverdue(app.nextActionAt, now) ? s.overdue : s.mono}>
                {formatWhen(app.nextActionAt)} · {dueText(app.nextActionAt, now)}
              </span>
            )}
            {app.nextActionSuggested && <Tag>Suggested</Tag>}
          </p>
        ) : (
          <p className={s.dim}>Nothing is due.</p>
        )}
      </section>

      <section aria-label="Notes" className={s.block}>
        <SectionHeader
          title="Notes"
          actions={
            <Button
              size="sm"
              disabled={notes === (app.notesMd ?? '')}
              busy={update.isPending}
              onClick={() =>
                update.mutate(
                  { id: app.id, patch: { notesMd: notes.trim() ? notes : null } },
                  {
                    onSuccess: () => toast({ title: 'Notes saved' }),
                    onError: fail('Could not save the notes'),
                  },
                )
              }
            >
              Save notes
            </Button>
          }
        />
        <Textarea
          aria-label="Notes"
          rows={5}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Anything about this application."
        />
      </section>

      <section aria-label="Timeline" className={s.block}>
        <SectionHeader title="Timeline" />
        <form
          className={s.addRow}
          onSubmit={(e) => {
            e.preventDefault();
            if (!entry.trim()) return;
            note.mutate(
              { id: app.id, text: entry },
              { onSuccess: () => setEntry(''), onError: fail('Could not add the note') },
            );
          }}
        >
          <Input
            size="sm"
            aria-label="Add a note to the timeline"
            placeholder="Add a note to the timeline"
            value={entry}
            onChange={(e) => setEntry(e.target.value)}
          />
          <Button size="sm" type="submit" disabled={!entry.trim()} busy={note.isPending}>
            Add note
          </Button>
        </form>
        <ol className={s.trail}>
          {[...events].reverse().map((ev) => {
            const d = describeEvent(ev);
            return (
              <li key={ev.id} className={s.trailItem}>
                <span className={s.mono}>{formatWhen(ev.at)}</span>
                <span>
                  {d.title}
                  {d.detail && <span className={s.detail}> {d.detail}</span>}
                </span>
              </li>
            );
          })}
        </ol>
      </section>

      <Dialog
        open={editing}
        onOpenChange={setEditing}
        title="Set next action"
        size="sm"
        description="Your own action replaces the suggested one until you clear it."
        footer={
          <>
            <Button onClick={() => setEditing(false)}>Cancel</Button>
            <Button
              variant="primary"
              onClick={() =>
                update.mutate(
                  {
                    id: app.id,
                    patch: {
                      nextAction: action.trim() || null,
                      nextActionAt: action.trim() ? dayOrNull(due) : null,
                    },
                  },
                  { onSuccess: () => setEditing(false), onError: fail('Could not save') },
                )
              }
            >
              Save
            </Button>
          </>
        }
      >
        <div className={s.form}>
          <Field label="Action">
            {(p) => <Input {...p} value={action} onChange={(e) => setAction(e.target.value)} />}
          </Field>
          <Field label="Due">
            {(p) => <Input {...p} type="date" value={due} onChange={(e) => setDue(e.target.value)} />}
          </Field>
        </div>
      </Dialog>
    </div>
  );
}

type Version = TrackerDetail['documents']['resume'][number];
const versionColumns: Column<Version>[] = [
  { id: 'v', header: 'Version', width: '88px', mono: true, cell: (v) => `v${String(v.version)}` },
  {
    id: 'state',
    header: 'State',
    width: '160px',
    cell: (v) => (
      <>
        {v.isFinal && <Tag tone="ok">Final</Tag>} {v.userEdited && <Tag>Edited</Tag>}
      </>
    ),
  },
  { id: 'pdf', header: 'PDF', width: '64px', cell: (v) => (v.hasPdf ? 'yes' : 'no') },
  { id: 'model', header: 'Model', cell: (v) => v.model ?? 'by hand' },
  { id: 'at', header: 'Created', width: '112px', mono: true, cell: (v) => isoDay(v.createdAt) },
];

export function DocumentsTab({ data }: { data: TrackerDetail }): React.JSX.Element {
  const { toast } = useToast();
  const navigate = useNavigate();
  const { frozen, documents, application: app } = data;
  const open = (): void => {
    openFolder(app.id).catch((e: unknown) =>
      toast({ title: 'Could not open the folder', description: errorText(e), tone: 'bad' }),
    );
  };
  const versions = (title: string, rows: Version[]): React.JSX.Element => (
    <section aria-label={title} className={s.block}>
      <SectionHeader title={title} />
      {rows.length === 0 ? (
        <p className={s.dim}>None yet.</p>
      ) : (
        <div
          className={s.versionTable}
          style={{ height: `calc(var(--row) * ${String(rows.length + 1)} + 2px)` }}
        >
          <Table ariaLabel={title} columns={versionColumns} rows={rows} getRowId={(v) => v.id} />
        </div>
      )}
    </section>
  );
  return (
    <div className={s.stack}>
      <section aria-label="Sent files" className={s.block}>
        <SectionHeader
          title="What you sent"
          actions={
            frozen && (
              <Button size="sm" icon={<FolderOpen aria-hidden="true" />} onClick={open}>
                Open folder
              </Button>
            )
          }
        />
        {frozen ? (
          <>
            <p className={s.mono}>{frozen.folder}</p>
            <ul className={s.files}>
              {frozen.files.map((f) => (
                <li key={f} className={s.mono}>
                  {f}
                </li>
              ))}
            </ul>
          </>
        ) : (
          <EmptyState
            title="Nothing frozen yet"
            action={
              <Button onClick={() => void navigate({ to: `/workspace/${data.job.id}` })}>
                Open in Workspace
              </Button>
            }
          >
            When you mark it applied, the final resume, cover letter, job description and analysis are copied
            here.
          </EmptyState>
        )}
      </section>
      {versions('Resume versions', documents.resume)}
      {versions('Cover letter versions', documents.cover)}
    </div>
  );
}

type AuditRow = NonNullable<TrackerDetail['analysis']>['skillAudit'][number];
const auditColumns: Column<AuditRow>[] = [
  { id: 'skill', header: 'Skill', cell: (x) => x.skill },
  { id: 'origin', header: 'Origin', width: '120px', cell: (x) => x.origin },
  { id: 'imp', header: 'In the job', width: '120px', cell: (x) => x.jdImportance },
  { id: 'rec', header: 'Advice', width: '140px', cell: (x) => x.recommendation },
  { id: 'dec', header: 'Your decision', width: '140px', cell: (x) => x.decision },
];

export function AnalysisTab({ data }: { data: TrackerDetail }): React.JSX.Element {
  const navigate = useNavigate();
  const a = data.analysis;
  if (!a)
    return (
      <EmptyState
        title="No analysis yet"
        action={
          <Button onClick={() => void navigate({ to: `/workspace/${data.job.id}` })}>
            Open in Workspace
          </Button>
        }
      >
        Analyze the job in the Workspace to see the fit here.
      </EmptyState>
    );
  const r = a.result;
  return (
    <div className={s.stack}>
      <section aria-label="Fit" className={s.block}>
        <SectionHeader title={data.analysisFrozen ? 'Fit when you applied' : 'Fit now'} />
        <div className={s.fitRow}>
          {a.fitScore !== null && (
            <div className={s.fitMeter}>
              <ScoreMeter value={a.fitScore} thresholds={FIT_THRESHOLDS} label="Fit score" />
            </div>
          )}
          {a.verdict && (a.verdict === 'apply' || a.verdict === 'stretch' || a.verdict === 'skip') && (
            <Tag tone={VERDICT_TONE[a.verdict]}>{VERDICT_LABEL[a.verdict]}</Tag>
          )}
          <span className={s.dim}>
            {a.model} · {a.promptVersion} · {isoDay(a.createdAt)}
          </span>
        </div>
        {r && <p className={s.prose}>{r.summary}</p>}
      </section>
      {r && (
        <>
          <KeyValue
            items={[
              { key: 'Matched', value: r.matched.map((m) => m.requirement).join(', ') || '—' },
              { key: 'Missing skills', value: r.missing_skills.map((m) => m.skill).join(', ') || '—' },
              { key: 'Red flags', value: r.red_flags.join('; ') || '—' },
              { key: 'Strengths', value: r.strengths.join('; ') || '—' },
            ]}
          />
        </>
      )}
      {a.skillAudit.length > 0 && (
        <section aria-label="Skill audit" className={s.block}>
          <SectionHeader title="Skill audit" />
          <div
            className={s.versionTable}
            style={{ height: `calc(var(--row) * ${String(a.skillAudit.length + 1)} + 2px)` }}
          >
            <Table
              ariaLabel="Skill audit"
              columns={auditColumns}
              rows={a.skillAudit}
              getRowId={(x) => x.skill}
            />
          </div>
        </section>
      )}
    </div>
  );
}
