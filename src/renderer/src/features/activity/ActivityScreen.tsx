import { useId, useState } from 'react';
import { Page } from '../../app/Page';
import { isTypingTarget } from '../../app/shortcuts';
import {
  Button,
  EmptyState,
  ErrorState,
  Inspector,
  Loading,
  Select,
  SplitView,
  StatusDot,
  Table,
  type Column,
} from '../../ui';
import { useRuns, type AiRun } from '../../lib/activity';
import { RunDetail } from './RunDetail';
import { RUN_LABEL, RUN_TONE, formatDuration, formatTime, isFailure } from './helpers';
import s from './activity.module.css';

const columns: Column<AiRun>[] = [
  { id: 'time', header: 'Time', width: '188px', cell: (r) => formatTime(r.startedAt), mono: true },
  { id: 'task', header: 'Task', width: '120px', cell: (r) => r.task, mono: true },
  { id: 'model', header: 'Model', cell: (r) => r.model },
  {
    id: 'duration',
    header: 'Duration',
    width: '96px',
    cell: (r) => formatDuration(r.durationMs),
    mono: true,
    align: 'right',
  },
  {
    id: 'status',
    header: 'Status',
    width: '140px',
    cell: (r) => <StatusDot tone={RUN_TONE[r.status]}>{RUN_LABEL[r.status]}</StatusDot>,
  },
];

export default function ActivityScreen(): React.JSX.Element {
  const runs = useRuns();
  const filterId = useId();
  const [filter, setFilter] = useState('all');
  const [selected, setSelected] = useState<string>();
  const all = runs.data ?? [];
  const rows = filter === 'failures' ? all.filter(isFailure) : all;
  const run = rows.find((r) => r.id === selected);

  return (
    <Page
      fill
      title="Activity"
      subtitle="Every AI run, with its prompt and raw output."
      actions={
        <div className={s.filter}>
          <label htmlFor={filterId} className="micro">
            Show
          </label>
          <Select
            id={filterId}
            size="sm"
            value={filter}
            onValueChange={setFilter}
            options={[
              { value: 'all', label: 'All runs' },
              { value: 'failures', label: 'Failures only' },
            ]}
          />
        </div>
      }
    >
      {runs.isPending ? (
        <Loading what="Reading AI runs" />
      ) : runs.isError ? (
        <ErrorState
          title="Could not read the AI runs"
          message={runs.error.message}
          action={<Button onClick={() => void runs.refetch()}>Retry</Button>}
        />
      ) : all.length === 0 ? (
        <EmptyState title="No AI runs yet.">
          Runs appear here when Stellio reads a job or analyzes your fit.
        </EmptyState>
      ) : (
        <div
          className={s.split}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && !isTypingTarget(e.target)) setSelected(undefined);
          }}
        >
          <SplitView
            inspector={
              run ? (
                <Inspector
                  title={`${run.task} · ${formatTime(run.startedAt)}`}
                  onClose={() => setSelected(undefined)}
                >
                  <RunDetail run={run} />
                </Inspector>
              ) : undefined
            }
          >
            <Table
              ariaLabel="AI runs"
              columns={columns}
              rows={rows}
              getRowId={(r) => r.id}
              selectedId={run?.id}
              onSelectedChange={setSelected}
              onRowClick={(r) => setSelected(r.id)}
              empty={<EmptyState title="No failed runs.">Every run in the list finished.</EmptyState>}
            />
          </SplitView>
        </div>
      )}
    </Page>
  );
}
