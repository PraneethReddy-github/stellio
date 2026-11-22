import { useNavigate } from '@tanstack/react-router';
import { ChevronDown, Download } from 'lucide-react';
import { useState, type KeyboardEvent } from 'react';
import {
  APPLICATION_STATUSES,
  type AppStatus,
  type TableFilters,
  type TableRow,
  type TableSort,
} from '@shared/tracker';
import {
  Button,
  Checkbox,
  Dialog,
  DropdownMenu,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Loading,
  Popover,
  ScoreMeter,
  StatusDot,
  Table,
  useToast,
  type Column,
  type MenuEntry,
  type SortState,
} from '../../ui';
import { exportCsv, useTable } from '../../lib/tracker';
import { FIT_THRESHOLDS, isoDay } from '../workspace/helpers';
import {
  BUILT_IN_VIEWS,
  DEFAULT_SORT,
  STATUS_LABEL,
  STATUS_TONE,
  cleanFilters,
  dayOrNull,
  dueText,
  hasFilters,
  isOverdue,
  loadViews,
  saveViews,
  upsertView,
  type SavedView,
} from './helpers';
import s from './applications.module.css';

const dash = <span className={s.dim}>—</span>;
const SORTABLE: Record<string, TableSort['by']> = {
  company: 'company',
  role: 'role',
  status: 'status',
  fit: 'fit',
  appliedAt: 'appliedAt',
  daysSince: 'daysSince',
  nextAction: 'nextActionAt',
};
const sortId = (by: TableSort['by']): string => Object.entries(SORTABLE).find(([, v]) => v === by)?.[0] ?? by;

const columns: Column<TableRow>[] = [
  { id: 'company', header: 'Company', width: 'minmax(140px, 1.2fr)', sortable: true, cell: (r) => r.company },
  { id: 'role', header: 'Role', width: 'minmax(160px, 1.6fr)', sortable: true, cell: (r) => r.role },
  {
    id: 'status',
    header: 'Status',
    width: '140px',
    sortable: true,
    cell: (r) => <StatusDot tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</StatusDot>,
  },
  {
    id: 'fit',
    header: 'Fit',
    width: '112px',
    sortable: true,
    cell: (r) =>
      r.fit === null ? (
        dash
      ) : (
        <ScoreMeter value={r.fit} thresholds={FIT_THRESHOLDS} label={`Fit for ${r.role} at ${r.company}`} />
      ),
  },
  {
    id: 'appliedAt',
    header: 'Applied',
    width: '108px',
    sortable: true,
    mono: true,
    cell: (r) => (r.appliedAt ? isoDay(r.appliedAt) : dash),
  },
  {
    id: 'daysSince',
    header: 'Days',
    width: '64px',
    align: 'right',
    sortable: true,
    mono: true,
    cell: (r) => (r.daysSince === null ? dash : r.daysSince),
  },
  { id: 'source', header: 'Source', width: '96px', cell: (r) => r.source ?? dash },
  { id: 'location', header: 'Location', width: 'minmax(100px, 1fr)', cell: (r) => r.location ?? dash },
  { id: 'salary', header: 'Salary', width: '120px', mono: true, cell: (r) => r.salary ?? dash },
  {
    id: 'resumeVersion',
    header: 'Resume',
    width: '72px',
    mono: true,
    cell: (r) => (r.resumeVersion === null ? dash : `v${String(r.resumeVersion)}`),
  },
  {
    id: 'nextAction',
    header: 'Next action',
    width: 'minmax(160px, 1.4fr)',
    sortable: true,
    cell: (r) =>
      r.nextAction ? (
        <span className={r.nextActionAt && isOverdue(r.nextActionAt, new Date()) ? s.overdue : undefined}>
          {r.nextAction}
          {r.nextActionAt && ` · ${dueText(r.nextActionAt, new Date())}`}
        </span>
      ) : (
        dash
      ),
  },
];

export function TableView({ onSelect }: { onSelect: (id: string) => void }): React.JSX.Element {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [filters, setFilters] = useState<TableFilters>({});
  const [sort, setSort] = useState<TableSort>(DEFAULT_SORT);
  const [views, setViews] = useState<SavedView[]>(loadViews);
  const [naming, setNaming] = useState(false);
  const [viewName, setViewName] = useState('');
  const [exporting, setExporting] = useState(false);
  const [active, setActive] = useState<string>();
  const clean = cleanFilters(filters);
  const query = { filters: clean, sort };
  const q = useTable(query);
  const patch = (p: Partial<TableFilters>): void => setFilters((f) => ({ ...f, ...p }));
  const status = filters.status ?? [];

  const applyView = (v: SavedView): void => {
    setFilters(v.filters);
    setSort(v.sort);
  };
  const viewItems: MenuEntry[] = [
    ...BUILT_IN_VIEWS.map((v) => ({ label: v.name, onSelect: () => applyView(v) })),
    ...(views.length > 0 ? (['separator'] as const) : []),
    ...views.map((v) => ({ label: v.name, onSelect: () => applyView(v) })),
    'separator',
    { label: 'Save current view…', onSelect: () => setNaming(true) },
    ...views.map((v) => ({
      label: `Delete view "${v.name}"`,
      danger: true,
      onSelect: () => {
        const next = views.filter((x) => x.name !== v.name);
        setViews(next);
        saveViews(next);
      },
    })),
  ];
  const saveView = (): void => {
    const name = viewName.trim();
    if (!name) return;
    const next = upsertView(views, { name, filters: clean, sort });
    setViews(next);
    saveViews(next);
    setNaming(false);
    setViewName('');
    toast({ title: `Saved view "${name}"` });
  };

  const doExport = (): void => {
    setExporting(true);
    exportCsv(query).then(
      (r) => {
        setExporting(false);
        if (r.status === 'saved') toast({ title: `Exported ${String(r.rows)} rows`, description: r.path });
      },
      (e: unknown) => {
        setExporting(false);
        toast({
          title: 'Could not export',
          description: e instanceof Error ? e.message : String(e),
          tone: 'bad',
        });
      },
    );
  };

  const rows = q.data?.rows ?? [];
  const tableSort: SortState = { id: sortId(sort.by), dir: sort.dir };
  // Enter on the table opens the full page; a click opens the inspector (Table's own Enter handler is for clicks).
  const onEnter = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'Enter' || !(e.target instanceof HTMLElement) || e.target.getAttribute('role') !== 'grid')
      return;
    if (!active) return;
    e.stopPropagation();
    void navigate({ to: `/applications/${active}` });
  };

  return (
    <div className={s.tableView}>
      <div className={s.toolbar} role="search" aria-label="Filter applications">
        <Input
          size="sm"
          type="search"
          aria-label="Search applications"
          placeholder="Search company or role"
          value={filters.text ?? ''}
          onChange={(e) => patch({ text: e.target.value })}
          className={s.search}
        />
        <Popover
          trigger={
            <Button size="sm" icon={<ChevronDown aria-hidden="true" />}>
              Status{status.length > 0 ? ` · ${String(status.length)}` : ''}
            </Button>
          }
        >
          <div className={s.statusList} role="group" aria-label="Status filter">
            {APPLICATION_STATUSES.map((st: AppStatus) => (
              <Checkbox
                key={st}
                label={STATUS_LABEL[st]}
                checked={status.includes(st)}
                onCheckedChange={(on) =>
                  patch({ status: on === true ? [...status, st] : status.filter((x) => x !== st) })
                }
              />
            ))}
          </div>
        </Popover>
        <Checkbox
          label="Follow-up due"
          checked={filters.hasNextActionDue === true}
          onCheckedChange={(on) => patch({ hasNextActionDue: on === true })}
        />
        <label className={s.dateField}>
          Applied from
          <Input
            size="sm"
            type="date"
            value={filters.appliedFrom ?? ''}
            onChange={(e) => patch({ appliedFrom: dayOrNull(e.target.value) ?? '' })}
          />
        </label>
        <label className={s.dateField}>
          to
          <Input
            size="sm"
            type="date"
            value={filters.appliedTo ?? ''}
            onChange={(e) => patch({ appliedTo: dayOrNull(e.target.value) ?? '' })}
          />
        </label>
        {hasFilters(filters) && (
          <Button size="sm" variant="ghost" onClick={() => setFilters({})}>
            Clear filters
          </Button>
        )}
        <span className={s.spacer} />
        <DropdownMenu
          align="end"
          items={viewItems}
          trigger={
            <Button size="sm" icon={<ChevronDown aria-hidden="true" />}>
              Views
            </Button>
          }
        />
        <Button size="sm" icon={<Download aria-hidden="true" />} busy={exporting} onClick={doExport}>
          Export CSV
        </Button>
      </div>

      <div className={s.tableBody} onKeyDownCapture={onEnter}>
        {q.isPending ? (
          <Loading what="Reading applications" />
        ) : q.isError ? (
          <ErrorState
            title="Could not read the table"
            message={q.error.message}
            action={<Button onClick={() => void q.refetch()}>Try again</Button>}
          />
        ) : (
          <Table
            ariaLabel="Applications"
            columns={columns}
            rows={rows}
            getRowId={(r) => r.id}
            selectedId={active}
            onSelectedChange={setActive}
            onRowClick={(r) => onSelect(r.id)}
            sort={tableSort}
            onSortChange={(next) => {
              const by = SORTABLE[next.id];
              if (by) setSort({ by, dir: next.dir });
            }}
            empty={
              hasFilters(filters) ? (
                <EmptyState title="No application matches">
                  Change or clear the filters to see the others.
                </EmptyState>
              ) : (
                <EmptyState title="No applications yet">
                  An application starts when you shortlist a job or begin a resume for it.
                </EmptyState>
              )
            }
          />
        )}
      </div>

      <Dialog
        open={naming}
        onOpenChange={setNaming}
        title="Save this view"
        size="sm"
        description="The filters and the sort order, under a name you pick. Kept on this computer."
        footer={
          <>
            <Button onClick={() => setNaming(false)}>Cancel</Button>
            <Button variant="primary" disabled={!viewName.trim()} onClick={saveView}>
              Save view
            </Button>
          </>
        }
      >
        <Field label="Name">
          {(p) => (
            <Input
              {...p}
              value={viewName}
              onChange={(e) => setViewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveView();
              }}
              autoFocus
            />
          )}
        </Field>
      </Dialog>
    </div>
  );
}
