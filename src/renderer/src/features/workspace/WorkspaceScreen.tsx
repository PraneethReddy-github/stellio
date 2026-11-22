import { useNavigate } from '@tanstack/react-router';
import { useMemo } from 'react';
import { Page } from '../../app/Page';
import { useRegisterCommands, type Command } from '../../app/commands';
import { Button, EmptyState, ErrorState, Loading, ScoreMeter, Table, type Column } from '../../ui';
import { useJobs, type JobSummary } from '../../lib/jobs';
import { IntakePanel } from './IntakePanel';
import { FIT_THRESHOLDS, formatLocation, isoDay, WORKSPACE, jobPath } from './helpers';
import { useIntakeIntent } from './intent';
import s from './workspace.module.css';

const columns: Column<JobSummary>[] = [
  { id: 'title', header: 'Title', width: 'minmax(0, 2fr)', cell: (j) => j.title },
  { id: 'company', header: 'Company', cell: (j) => j.company },
  { id: 'location', header: 'Location', cell: (j) => formatLocation(j) ?? <span className={s.dash}>—</span> },
  {
    id: 'fit',
    header: 'Fit',
    width: '140px',
    cell: (j) =>
      j.fitScore === null ? (
        <span className={s.dash}>—</span>
      ) : (
        <ScoreMeter value={j.fitScore} thresholds={FIT_THRESHOLDS} label={`Fit for ${j.title}`} />
      ),
  },
  { id: 'added', header: 'Added', width: '104px', cell: (j) => isoDay(j.firstSeenAt), mono: true },
];

const MAX_VISIBLE_ROWS = 10;

/** `useRegisterCommands` for "add a job" actions; shared by the intake and job pages. */
export function useIntakeCommands(): void {
  const navigate = useNavigate();
  const ask = useIntakeIntent((st) => st.ask);
  const commands = useMemo<Command[]>(
    () => [
      {
        id: 'workspace.link',
        label: 'New job from link',
        group: 'Workspace',
        run: () => {
          void navigate({ to: WORKSPACE });
          ask('link');
        },
      },
      {
        id: 'workspace.paste',
        label: 'Paste a job description',
        group: 'Workspace',
        run: () => {
          void navigate({ to: WORKSPACE });
          ask('text');
        },
      },
    ],
    [navigate, ask],
  );
  useRegisterCommands('workspace.intake', commands);
}

export default function WorkspaceScreen(): React.JSX.Element {
  const navigate = useNavigate();
  const jobs = useJobs();
  useIntakeCommands();
  const rows = jobs.data?.items ?? [];

  return (
    <Page title="Workspace" subtitle="Add a job, check your fit, then build the resume and cover letter.">
      <div className={s.screen}>
        <IntakePanel />
        <section aria-label="Recent jobs" className={s.recent}>
          <h3 className={s.sectionTitle}>Recent jobs</h3>
          {jobs.isPending ? (
            <Loading what="Reading jobs" />
          ) : jobs.isError ? (
            <ErrorState
              title="Could not read your jobs"
              message={jobs.error.message}
              action={<Button onClick={() => void jobs.refetch()}>Retry</Button>}
            />
          ) : rows.length === 0 ? (
            <EmptyState title="No jobs yet">Paste a link or a job description above.</EmptyState>
          ) : (
            <div
              className={s.table}
              style={{
                height: `calc(var(--row) * ${String(Math.min(rows.length, MAX_VISIBLE_ROWS) + 1)} + 2px)`,
              }}
            >
              <Table
                ariaLabel="Recent jobs"
                columns={columns}
                rows={rows}
                getRowId={(j) => j.id}
                onRowClick={(j) => void navigate({ to: jobPath(j.id) })}
              />
            </div>
          )}
        </section>
      </div>
    </Page>
  );
}
