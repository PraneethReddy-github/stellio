import { useNavigate, useSearch } from '@tanstack/react-router';
import { useCallback, useMemo, useState, type KeyboardEvent } from 'react';
import { ChevronDown } from 'lucide-react';
import type { InboxItem } from '@shared/discovery/schemas';
import { Page } from '../../app/Page';
import { useRegisterCommands, type Command } from '../../app/commands';
import { isTypingTarget } from '../../app/shortcuts';
import {
  Button,
  DropdownMenu,
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
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Tag,
  useToast,
  type Column,
} from '../../ui';
import { useElapsedSeconds } from '../../lib/hooks';
import {
  cancelRescore,
  cancelScan,
  startRescore,
  startScan,
  useRescoreCounts,
  useRescoreState,
  type RescoreInput,
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
  type InboxKind,
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

  const [list, setList] = useState<'career' | 'side'>('career');
  const profiles = useProfiles();
  const run = useLastRun();
  // The Career | Side jobs switch shows only once a side-job search profile exists.
  const hasSide = (profiles.data ?? []).some((p) => p.kind === 'side');
  const kind: InboxKind = hasSide ? list : 'all';
  const q = useInbox(inboxQuery(filters, kind));
  const rescore = useRescoreState();
  const sideJob = kind === 'all' ? undefined : kind === 'side';
  const counts = useRescoreCounts(sideJob, !scan.running && !rescore.running);
  const busy = scan.running || rescore.running;

  const runRescore = useCallback(
    async (input: RescoreInput): Promise<void> => {
      try {
        const out = await startRescore(input);
        if (!out) return;
        if (out.error && out.scored === 0)
          toast({ title: 'Could not re-score', description: out.error, tone: 'bad' });
        else
          toast({
            title: `Re-scored ${String(out.scored)} ${out.scored === 1 ? 'job' : 'jobs'}`,
            description:
              out.error ??
              (out.scored < out.total ? `${String(out.total - out.scored)} not scored.` : undefined),
            tone: out.error || out.scored < out.total ? 'warn' : 'ok',
          });
      } catch (e) {
        toast({
          title: 'Could not re-score',
          description: e instanceof Error ? e.message : String(e),
          tone: 'bad',
        });
      }
    },
    [toast],
  );
  const rescoreList = useCallback(
    (scope: 'unscored' | 'all' | 'stale'): void =>
      void runRescore({ scope, ...(sideJob === undefined ? {} : { sideJob }) }),
    [runRescore, sideJob],
  );
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
      ...(busy
        ? []
        : [
            {
              id: 'inbox.rescoreUnscored',
              label: 'Re-score unscored jobs',
              group: 'Inbox',
              run: () => rescoreList('unscored'),
            },
            {
              id: 'inbox.rescoreAll',
              label: 'Re-score all jobs',
              group: 'Inbox',
              run: () => rescoreList('all'),
            },
          ]),
      ...(scan.running
        ? [{ id: 'inbox.cancel', label: 'Cancel scan', group: 'Inbox', run: () => void cancelScan() }]
        : []),
    ],
    [scan.running, busy, rescoreList],
  );
  useRegisterCommands('inbox', commands);

  const noProfile = profiles.isSuccess && profiles.data.length === 0;
  const errors = sourceErrors(run.data ?? null);

  const scanButton = scan.running ? (
    <Button onClick={() => void cancelScan()}>Cancel scan</Button>
  ) : (
    <Button variant="primary" disabled={rescore.running} onClick={() => void startScan()}>
      Scan now
    </Button>
  );

  const listBody = (
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
                  rescore={{
                    run: () => void runRescore({ scope: 'job', jobId: selected.jobId }),
                    busy: rescore.running && rescore.jobId === selected.jobId,
                    disabled: busy,
                  }}
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
              ) : kind === 'side' && !scan.running ? (
                <EmptyState title="No side jobs yet">
                  The next scan looks for part-time jobs that fit your side-job search profile.
                </EmptyState>
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
  );

  return (
    <Page
      title="Inbox"
      subtitle={<span className={s.mono}>{lastScanLine(run.data ?? null, formatWhen)}</span>}
      fill
      actions={
        noProfile ? undefined : (
          <>
            <DropdownMenu
              align="end"
              trigger={
                <Button icon={<ChevronDown aria-hidden="true" />} disabled={busy}>
                  Re-score
                </Button>
              }
              items={[
                {
                  label: `Unscored jobs · ${String(counts.data?.unscored ?? 0)}`,
                  disabled: !counts.data?.unscored,
                  onSelect: () => rescoreList('unscored'),
                },
                {
                  label: `All jobs in this list · ${String(counts.data?.all ?? 0)}`,
                  disabled: !counts.data?.all,
                  onSelect: () => rescoreList('all'),
                },
                {
                  label: `Scored before your profile changed · ${String(counts.data?.stale ?? 0)}`,
                  disabled: !counts.data?.stale,
                  onSelect: () => rescoreList('stale'),
                },
              ]}
            />
            {scanButton}
          </>
        )
      }
    >
      {rescore.running && rescore.jobId === null && (
        <section className={s.scan} aria-label="Re-score progress">
          <ProgressLine label="Re-scoring jobs" />
          <p className={s.mono} role="status">
            re-scoring · batch {rescore.done} of {rescore.total}
          </p>
          <Button size="sm" onClick={() => void cancelRescore()}>
            Cancel re-score
          </Button>
        </section>
      )}
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
      ) : hasSide ? (
        <Tabs
          className={s.kinds}
          value={list}
          onValueChange={(v) => setList(v === 'side' ? 'side' : 'career')}
        >
          <TabsList aria-label="Which jobs">
            <TabsTrigger value="career">Career</TabsTrigger>
            <TabsTrigger value="side">Side jobs</TabsTrigger>
          </TabsList>
          {(['career', 'side'] as const).map((v) => (
            <TabsContent key={v} value={v} className={s.kindPanel}>
              {v === list && listBody}
            </TabsContent>
          ))}
        </Tabs>
      ) : (
        listBody
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
