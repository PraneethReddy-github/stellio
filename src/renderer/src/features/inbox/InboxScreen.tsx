import { useNavigate, useSearch } from '@tanstack/react-router';
import { useMemo, useState, type KeyboardEvent } from 'react';
import type { InboxItem } from '@shared/discovery/schemas';
import { Page } from '../../app/Page';
import { useRegisterCommands, type Command } from '../../app/commands';
import { isTypingTarget } from '../../app/shortcuts';
import {
  Button,
  EmptyState,
  ErrorState,
  Field,
  Inspector,
  Input,
  Loading,
  ProgressLine,
  Select,
  SplitView,
  StatusDot,
  Switch,
  Table,
  Tag,
  useToast,
  type Column,
} from '../../ui';
import { useElapsedSeconds } from '../../lib/hooks';
import {
  cancelScan,
  startScan,
  useDismiss,
  useInbox,
  useLastRun,
  useProfiles,
  useScanState,
  useShortlist,
} from '../../lib/discovery';
import { formatWhen, route } from '../applications/helpers';
import { REMOTE_LABEL, isWebUrl, isoDay } from '../workspace/helpers';
import { DismissDialog } from './DismissDialog';
import { InboxInspector } from './InboxInspector';
import {
  BANDS,
  NO_FILTERS,
  REMOTE_FILTERS,
  applyLocalFilters,
  dash,
  inboxQuery,
  isFiltered,
  lastScanLine,
  neighbour,
  scoreTone,
  sourceErrors,
  sourceLabel,
  type InboxFilters,
} from './helpers';
import s from './inbox.module.css';

const columns: Column<InboxItem>[] = [
  {
    id: 'score',
    header: 'Score',
    width: '72px',
    mono: true,
    cell: (r) => (r.score === null ? dash : <StatusDot tone={scoreTone(r.score)}>{r.score}</StatusDot>),
  },
  { id: 'title', header: 'Title', width: 'minmax(180px, 2fr)', cell: (r) => r.title },
  { id: 'company', header: 'Company', width: 'minmax(120px, 1.2fr)', cell: (r) => r.company },
  {
    id: 'location',
    header: 'Location',
    width: 'minmax(120px, 1.2fr)',
    cell: (r) => [r.locationText, REMOTE_LABEL[r.remote]].filter(Boolean).join(' · ') || dash,
  },
  { id: 'salary', header: 'Salary', width: '204px', mono: true, cell: (r) => r.salaryText ?? dash },
  {
    id: 'posted',
    header: 'Posted',
    width: '112px',
    mono: true,
    cell: (r) => (r.postedAt ? isoDay(r.postedAt) : dash),
  },
  {
    id: 'sources',
    header: 'Sources',
    width: 'minmax(120px, 1fr)',
    cell: (r) => (
      <span className={s.tags}>
        {r.sources.map((x) => (
          <Tag key={x}>{sourceLabel(x)}</Tag>
        ))}
      </span>
    ),
  },
];

const named = (r: InboxItem): string => `${r.company} · ${r.title}`;

export default function InboxScreen(): React.JSX.Element {
  const navigate = useNavigate();
  const { toast } = useToast();
  const search: { job?: string } = useSearch({ strict: false });
  const [filters, setFilters] = useState<InboxFilters>(NO_FILTERS);
  const [sel, setSel] = useState<string | null>(search.job ?? null); // a link from Today names the job to open
  const [dismissing, setDismissing] = useState<InboxItem | null>(null);
  const scan = useScanState();
  const secs = useElapsedSeconds(scan.running);

  const profiles = useProfiles();
  const run = useLastRun();
  const q = useInbox(inboxQuery(filters));
  const shortlist = useShortlist();
  const dismiss = useDismiss();

  const rows = useMemo(
    () => applyLocalFilters(q.data ?? [], filters, profiles.data ?? [], run.data ?? null),
    [q.data, filters, profiles.data, run.data],
  );
  const selected = rows.find((r) => r.jobId === sel) ?? null;
  const patch = (p: Partial<InboxFilters>): void => setFilters((f) => ({ ...f, ...p }));

  const sources = useMemo(() => [...new Set((q.data ?? []).flatMap((r) => r.sources))].sort(), [q.data]);

  const doShortlist = (r: InboxItem): void => {
    setSel(neighbour(rows, r.jobId));
    shortlist.mutate(r.jobId, {
      onSuccess: ({ applicationId }) =>
        toast({
          title: 'Shortlisted',
          description: `${named(r)} is saved as an application.`,
          tone: 'ok',
          action: {
            label: 'Open',
            onClick: () => void navigate({ to: route(`/applications/${applicationId}`) }),
          },
        }),
      onError: (e) => toast({ title: 'Could not shortlist', description: e.message, tone: 'bad' }),
    });
  };
  const doDismiss = (r: InboxItem, reason: string): void => {
    setDismissing(null);
    setSel(neighbour(rows, r.jobId));
    dismiss.mutate(
      { id: r.jobId, reason },
      {
        onSuccess: () => toast({ title: 'Dismissed', description: named(r), tone: 'neutral' }),
        onError: (e) => toast({ title: 'Could not dismiss', description: e.message, tone: 'bad' }),
      },
    );
  };
  const openPosting = (r: InboxItem): void => {
    if (isWebUrl(r.url)) window.open(r.url, '_blank', 'noopener,noreferrer');
  };
  const openWorkspace = (r: InboxItem): void => void navigate({ to: route(`/workspace/${r.jobId}`) });

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    // Only while the table itself has focus: typing in a field or pressing a button keeps its own meaning.
    if (e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return;
    if ((e.target as HTMLElement).getAttribute('role') !== 'grid' || !selected) return;
    const act: Record<string, (r: InboxItem) => void> = {
      s: doShortlist,
      d: setDismissing,
      o: openPosting,
      Enter: openWorkspace,
    };
    const fn = act[e.key.length === 1 ? e.key.toLowerCase() : e.key];
    if (!fn) return;
    e.preventDefault();
    fn(selected);
  };

  const commands = useMemo<Command[]>(
    () => [
      { id: 'inbox.scan', label: 'Scan now', group: 'Inbox', run: () => void startScan() },
      ...(scan.running
        ? [{ id: 'inbox.cancel', label: 'Cancel scan', group: 'Inbox', run: () => void cancelScan() }]
        : []),
    ],
    [scan.running],
  );
  useRegisterCommands('inbox', commands);

  const noProfile = profiles.isSuccess && profiles.data.length === 0;
  const errors = sourceErrors(run.data ?? null);

  return (
    <Page
      title="Inbox"
      subtitle={<span className={s.mono}>{lastScanLine(run.data ?? null, formatWhen)}</span>}
      fill
      actions={
        noProfile ? undefined : scan.running ? (
          <Button onClick={() => void cancelScan()}>Cancel scan</Button>
        ) : (
          <Button variant="primary" onClick={() => void startScan()}>
            Scan now
          </Button>
        )
      }
    >
      {scan.running && (
        <section className={s.scan} aria-label="Scan progress">
          <ProgressLine label="Scanning job sources" />
          <p className={s.mono} role="status">
            scanning · {secs} s
          </p>
          <ul className={s.scanList}>
            {Object.entries(scan.progress).map(([src, v]) => (
              <li key={src}>
                <span>{sourceLabel(src)}</span>
                <span className={s.mono}>
                  {v.fetched} fetched · {v.new} new
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {scan.error && (
        <ErrorState
          title="The scan did not finish"
          message={scan.error}
          action={<Button onClick={() => void startScan()}>Try again</Button>}
        />
      )}
      {!scan.running && run.data?.error && (
        <p className={s.notice} role="status">
          {run.data.error === 'cancelled'
            ? 'The last scan was cancelled. Jobs found before that are listed.'
            : run.data.error}
        </p>
      )}
      {!scan.running && errors.length > 0 && (
        <ul className={s.sourceErrors} aria-label="Source errors">
          {errors.map((e) => (
            <li key={e.source}>
              <StatusDot tone="warn">{sourceLabel(e.source)}</StatusDot>
              <span>
                {e.message}
                {e.more > 0 ? ` (+${String(e.more)} more)` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}

      {profiles.isPending || q.isPending ? (
        <Loading what="Reading the inbox" />
      ) : q.isError ? (
        <ErrorState
          title="Could not read the inbox"
          message={q.error.message}
          action={<Button onClick={() => void q.refetch()}>Try again</Button>}
        />
      ) : noProfile ? (
        <EmptyState
          title="No search profile yet"
          action={
            <Button
              variant="primary"
              onClick={() => void navigate({ to: route('/settings'), search: { section: 'profiles' } })}
            >
              Create a search profile
            </Button>
          }
        >
          A search profile says which roles, places and salary you look for. Add one in Settings, then scan.
        </EmptyState>
      ) : (
        <>
          <div className={s.filters} role="group" aria-label="Filters">
            <Field label="Search">
              {(p) => (
                <Input
                  {...p}
                  size="sm"
                  type="search"
                  value={filters.text}
                  placeholder="Title or company"
                  onChange={(e) => patch({ text: e.target.value })}
                />
              )}
            </Field>
            <Field label="Search profile">
              {(p) => (
                <Select
                  {...p}
                  size="sm"
                  value={filters.profileId}
                  onValueChange={(v) => patch({ profileId: v })}
                  options={[
                    { value: 'any', label: 'All profiles' },
                    ...(profiles.data ?? []).map((x) => ({ value: x.id, label: x.name })),
                  ]}
                />
              )}
            </Field>
            <Field label="Score">
              {(p) => (
                <Select
                  {...p}
                  size="sm"
                  value={filters.band}
                  onValueChange={(v) => patch({ band: v })}
                  options={BANDS.map((b) => ({ value: b.value, label: b.label }))}
                />
              )}
            </Field>
            <Field label="Remote">
              {(p) => (
                <Select
                  {...p}
                  size="sm"
                  value={filters.remote}
                  onValueChange={(v) => patch({ remote: v })}
                  options={REMOTE_FILTERS.map((b) => ({ value: b.value, label: b.label }))}
                />
              )}
            </Field>
            <Field label="Source">
              {(p) => (
                <Select
                  {...p}
                  size="sm"
                  value={filters.source}
                  onValueChange={(v) => patch({ source: v })}
                  options={[
                    { value: 'any', label: 'All sources' },
                    ...sources.map((x) => ({ value: x, label: sourceLabel(x) })),
                  ]}
                />
              )}
            </Field>
            <Switch
              className={s.newOnly}
              label="New since last scan"
              checked={filters.newOnly}
              onCheckedChange={(v) => patch({ newOnly: v })}
            />
            <p className={s.count} role="status">
              {rows.length} {rows.length === 1 ? 'job' : 'jobs'}
            </p>
          </div>
          <div className={s.tableWrap} onKeyDown={onKeyDown}>
            <SplitView
              inspector={
                selected && (
                  <Inspector title="Job" onClose={() => setSel(null)}>
                    <InboxInspector
                      key={selected.jobId}
                      item={selected}
                      onShortlist={() => doShortlist(selected)}
                      onDismiss={() => setDismissing(selected)}
                      onOpenPosting={() => openPosting(selected)}
                      onOpenWorkspace={() => openWorkspace(selected)}
                    />
                  </Inspector>
                )
              }
            >
              <Table
                ariaLabel="Discovered jobs"
                columns={columns}
                rows={rows}
                getRowId={(r) => r.jobId}
                selectedId={sel ?? undefined}
                onSelectedChange={setSel}
                empty={
                  isFiltered(filters) ? (
                    <EmptyState
                      title="No job matches these filters"
                      action={<Button onClick={() => setFilters(NO_FILTERS)}>Clear filters</Button>}
                    />
                  ) : scan.running ? (
                    <EmptyState title="Scan in progress">Jobs appear here when the scan finishes.</EmptyState>
                  ) : (
                    <EmptyState title="No new jobs">
                      Nothing is waiting. The next scan adds what the sources list since the last one.
                    </EmptyState>
                  )
                }
              />
            </SplitView>
          </div>
        </>
      )}
      <DismissDialog
        label={dismissing ? named(dismissing) : null}
        busy={dismiss.isPending}
        onCancel={() => setDismissing(null)}
        onConfirm={(reason) => dismissing && doDismiss(dismissing, reason)}
      />
    </Page>
  );
}
