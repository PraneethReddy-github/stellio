import { useNavigate } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { Page } from '../../app/Page';
import {
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Field,
  Inspector,
  Input,
  Loading,
  Select,
  SelectControls,
  SplitView,
  Table,
  useSelectMode,
  useToast,
  type Column,
} from '../../ui';
import { useJobs } from '../../lib/jobs';
import {
  useDeleteAllPeople,
  useDeletePeople,
  useDueReferrals,
  useReferralSettings,
  useReferrals,
  useSetRetention,
  type ReferralItem,
} from '../../lib/referrals';
import { route } from '../applications/helpers';
import { jobPath } from '../workspace/helpers';
import { locationColumn, nameColumn, statusColumn } from './columns';
import {
  BOUNDARY_LINE,
  STATUS_OPTIONS,
  contactedText,
  filterByStatus,
  followUpText,
  peopleCount,
} from './helpers';
import { ReferralInspector } from './ReferralInspector';
import s from './referrals.module.css';

export default function ReferralsScreen(): React.JSX.Element {
  const q = useReferrals();
  const jobs = useJobs(500);
  const navigate = useNavigate();
  const [status, setStatus] = useState('any');
  const [sel, setSel] = useState<string | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const delAll = useDeleteAllPeople();
  const delSome = useDeletePeople();
  const mode = useSelectMode();
  const { toast } = useToast();
  const due = useDueReferrals();
  const dueIds = useMemo(() => new Set((due.data ?? []).map((i) => i.id)), [due.data]);

  const jobTitle = useMemo(() => new Map((jobs.data?.items ?? []).map((j) => [j.id, j.title])), [jobs.data]);
  const all = q.data ?? [];
  const rows = filterByStatus(all, status);
  const dueCount = dueIds.size;
  // One person can have several rows (one per job): deleting any of them deletes the person.
  const chosen = [...new Set(rows.filter((r) => mode.ids.has(r.id)).map((r) => r.personId))];
  const selecting = {
    ...mode,
    start: () => {
      setSel(null);
      mode.start();
    },
  };
  const selected = mode.on ? null : (rows.find((r) => r.id === sel) ?? null);

  const columns: Column<ReferralItem>[] = [
    nameColumn,
    { id: 'company', header: 'Company', width: 'minmax(0, 1fr)', cell: (r) => r.person.company },
    {
      id: 'job',
      header: 'Job',
      width: 'minmax(0, 1.4fr)',
      cell: (r) => (r.jobId ? (jobTitle.get(r.jobId) ?? '') : <span className={s.dim}>No job</span>),
    },
    locationColumn,
    statusColumn,
    { id: 'contacted', header: 'Contacted', width: '112px', mono: true, cell: (r) => contactedText(r) },
    {
      id: 'followUp',
      header: 'Follow-up',
      width: '168px',
      mono: true,
      cell: (r) => followUpText(r, dueIds.has(r.id)),
    },
  ];

  return (
    <Page
      title="Referrals"
      subtitle={BOUNDARY_LINE}
      fill
      actions={
        <Button variant="danger" disabled={all.length === 0} onClick={() => setConfirmAll(true)}>
          Delete all people
        </Button>
      }
    >
      {q.isPending ? (
        <Loading what="Reading referrals" />
      ) : q.isError ? (
        <ErrorState
          title="Could not read the referrals"
          message={q.error.message}
          action={<Button onClick={() => void q.refetch()}>Try again</Button>}
        />
      ) : all.length === 0 ? (
        <EmptyState
          title="No people yet"
          action={<Button onClick={() => void navigate({ to: route('/workspace') })}>Open Workspace</Button>}
        >
          Open a job and use its Referrals tab to find people at that company.
        </EmptyState>
      ) : (
        <>
          <div className={s.filters} role="group" aria-label="Filters">
            <Field label="Status">
              {(f) => (
                <Select
                  {...f}
                  size="sm"
                  value={status}
                  onValueChange={setStatus}
                  options={[{ value: 'any', label: 'All statuses' }, ...STATUS_OPTIONS]}
                />
              )}
            </Field>
            <p className={s.countInline} role="status">
              {peopleCount(rows.length)}
              {dueCount > 0 ? ` · ${String(dueCount)} follow-up${dueCount === 1 ? '' : 's'} due` : ''}
            </p>
            <span className={s.spacer} />
            <SelectControls
              mode={selecting}
              count={chosen.length}
              disabled={rows.length === 0}
              busy={delSome.isPending}
              confirmTitle={`Delete ${peopleCount(chosen.length)}?`}
              confirmText="The people, their sources and every request and message for them, for all jobs, are removed. This cannot be undone."
              onDelete={() =>
                delSome.mutate(chosen, {
                  onSuccess: (r) => {
                    mode.stop();
                    toast({ title: `Deleted ${peopleCount(r.deleted)}` });
                  },
                  onError: (e) => toast({ title: 'Could not delete', description: e.message, tone: 'bad' }),
                })
              }
            />
          </div>
          <div className={s.screenTable}>
            <SplitView
              inspector={
                selected && (
                  <Inspector title="Person" onClose={() => setSel(null)}>
                    {selected.jobId && (
                      <div className={s.openJob}>
                        <Button
                          size="sm"
                          onClick={() => void navigate({ to: jobPath(selected.jobId as string) })}
                        >
                          Open job
                        </Button>
                      </div>
                    )}
                    <ReferralInspector key={selected.id} item={selected} onDeleted={() => setSel(null)} />
                  </Inspector>
                )
              }
            >
              <Table
                ariaLabel="All referral requests"
                columns={columns}
                rows={rows}
                getRowId={(r) => r.id}
                checked={mode.checked}
                selectedId={sel ?? undefined}
                onSelectedChange={setSel}
                empty={
                  <EmptyState
                    title="No one has this status"
                    action={<Button onClick={() => setStatus('any')}>Show all</Button>}
                  />
                }
              />
            </SplitView>
          </div>
        </>
      )}
      <Retention />
      <ConfirmDialog
        open={confirmAll}
        onOpenChange={setConfirmAll}
        title="Delete all people?"
        description={`Every person, source, message and outreach status is removed (${peopleCount(
          new Set(all.map((i) => i.personId)).size,
        )}). This cannot be undone. Timeline entries on applications stay.`}
        confirmLabel="Delete all people"
        danger
        onConfirm={() =>
          delAll.mutate(undefined, {
            onSuccess: (r) => {
              setSel(null);
              toast({ title: `Deleted ${peopleCount(r.deleted)}` });
            },
            onError: (e) => toast({ title: 'Could not delete', description: e.message, tone: 'bad' }),
          })
        }
      />
    </Page>
  );
}

function Retention(): React.JSX.Element | null {
  const q = useReferralSettings();
  if (!q.data)
    return q.isError ? (
      <p className={s.dim}>Could not read the retention setting: {q.error.message}</p>
    ) : null;
  return <RetentionForm key={q.data.retentionDays} days={q.data.retentionDays} />;
}

function RetentionForm({ days }: { days: number }): React.JSX.Element {
  const save = useSetRetention();
  const { toast } = useToast();
  const [text, setText] = useState(String(days));
  const n = Number(text);
  const valid = Number.isInteger(n) && n >= 1 && n <= 3650;
  return (
    <form
      className={s.retention}
      aria-label="Retention"
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid || n === days) return;
        save.mutate(n, {
          onSuccess: () => toast({ title: 'Retention saved' }),
          onError: (err) =>
            toast({ title: 'Could not save the retention', description: err.message, tone: 'bad' }),
        });
      }}
    >
      <Field
        label="Keep people you never contacted for (days)"
        hint="Then they are deleted. People you contacted are kept until you delete them."
        error={valid ? undefined : 'Enter a whole number from 1 to 3650.'}
      >
        {(f) => (
          <div className={s.inline}>
            <Input
              {...f}
              size="sm"
              type="number"
              min={1}
              max={3650}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <Button type="submit" size="sm" busy={save.isPending} disabled={!valid || n === days}>
              Save
            </Button>
          </div>
        )}
      </Field>
    </form>
  );
}
