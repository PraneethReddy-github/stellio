import { useNavigate, useParams } from '@tanstack/react-router';
import { ChevronDown } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { CANCELLED_MESSAGE } from '@shared/messages';
import { Page } from '../../app/Page';
import { useRegisterCommands, type Command } from '../../app/commands';
import {
  Button,
  ConfirmDialog,
  DropdownMenu,
  ErrorState,
  Loading,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Tag,
  useToast,
  type MenuEntry,
} from '../../ui';
import { useAppForJob } from '../../lib/tracker';
import { statusMenuItems, useStatusFlow, type StatusRef } from '../applications/StatusFlow';
import { STATUS_LABEL } from '../applications/helpers';
import { ReferralsTab } from '../referrals/ReferralsTab';
import { ApplyTab } from './ApplyTab';
import { useElapsedSeconds } from '../../lib/hooks';
import {
  cancelTask,
  useAnalyze,
  useDeleteJob,
  useJob,
  useSetJobState,
  useSideFit,
  type JobGet,
} from '../../lib/jobs';
import { FitTab } from './FitTab';
import { SideFitTab } from './SideFitTab';
import { JobTab } from './JobTab';
import { ResumeTab } from './resume/ResumeTab';
import { useIntakeCommands } from './WorkspaceScreen';
import {
  REMOTE_LABEL,
  VERDICT_LABEL,
  VERDICT_TONE,
  formatLocation,
  formatSalary,
  isWebUrl,
  isoDay,
  WORKSPACE,
} from './helpers';
import s from './workspace.module.css';

export default function JobScreen(): React.JSX.Element {
  const params: { jobId?: string } = useParams({ strict: false });
  const navigate = useNavigate();
  const q = useJob(params.jobId ?? '');
  useIntakeCommands();
  if (!q.data) {
    return (
      <Page title="Job">
        {q.isError ? (
          <ErrorState
            title="Could not open this job"
            message={q.error.message}
            action={<Button onClick={() => void navigate({ to: WORKSPACE })}>Back to Workspace</Button>}
          />
        ) : (
          <Loading what="Reading job" />
        )}
      </Page>
    );
  }
  return <JobView key={q.data.job.id} data={q.data} />;
}

function JobView({ data }: { data: JobGet }): React.JSX.Element {
  const { job, analysis, sideFit } = data;
  // A side job's Fit tab is the side-job check: pay, hours, place, language, needs.
  const side = job.sideJob;
  const navigate = useNavigate();
  const { toast } = useToast();
  const fullFit = useAnalyze(job.id);
  const sideCheck = useSideFit(job.id);
  const analyze = side ? sideCheck : fullFit;
  const checked = side ? sideFit !== null : analysis !== null;
  const del = useDeleteJob();
  const setState = useSetJobState();
  const [tab, setTab] = useState('job');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);
  const requestId = useRef<string | null>(null);
  const running = analyze.isPending;
  const secs = useElapsedSeconds(running);

  const startAnalyze = (): void => {
    if (analyze.isPending) return;
    const id = crypto.randomUUID();
    requestId.current = id;
    setAnalyzeError(null);
    setTab('fit');
    const onError = (e: Error): void => {
      if (e.message === CANCELLED_MESSAGE) toast({ title: 'Cancelled' });
      else setAnalyzeError(e.message);
    };
    if (side) sideCheck.mutate(id, { onError });
    else fullFit.mutate(id, { onError });
  };
  const cancel = (): void => {
    if (requestId.current) void cancelTask(requestId.current);
  };

  const act = useRef(startAnalyze);
  useEffect(() => {
    act.current = startAnalyze;
  });
  const commands = useMemo<Command[]>(
    () => [
      {
        id: 'workspace.analyze',
        label: side ? 'Check side job' : 'Analyze fit',
        group: 'Workspace',
        run: () => act.current(),
      },
    ],
    [side],
  );
  useRegisterCommands('workspace.job', commands);

  const archive = (): void => {
    const previous = job.state;
    setState.mutate(
      { id: job.id, state: 'archived' },
      {
        onSuccess: () =>
          toast({
            title: 'Marked archived',
            action: { label: 'Undo', onClick: () => setState.mutate({ id: job.id, state: previous }) },
          }),
        onError: (e) => toast({ title: 'Could not archive the job', description: e.message, tone: 'bad' }),
      },
    );
  };

  // The Status menu is the application's status (docs/08 §1); the first change creates the application.
  const appQ = useAppForJob(job.id);
  const flow = useStatusFlow();
  const ref: StatusRef = {
    id: appQ.data?.id ?? null,
    jobId: job.id,
    status: appQ.data?.status ?? null,
    company: job.company,
  };
  const stateItems: MenuEntry[] = statusMenuItems(ref.status, (to) => flow.request(ref, to));
  if (job.state !== 'archived') stateItems.push('separator', { label: 'Archive job', onSelect: archive });
  stateItems.push('separator', { label: 'Delete job', danger: true, onSelect: () => setConfirmDelete(true) });

  const location = formatLocation(job);
  const remote = REMOTE_LABEL[job.remote];
  const salary = formatSalary(job.salaryMin, job.salaryMax, job.salaryCurrency, job.salaryPeriod);
  const link = job.applyUrl ?? job.url;

  return (
    <Page
      title={job.title}
      subtitle={[job.company, location].filter(Boolean).join(' · ')}
      actions={
        <>
          {checked ? (
            <Button busy={running} onClick={startAnalyze}>
              {running ? (side ? 'Checking…' : 'Analyzing…') : side ? 'Re-check' : 'Re-analyze'}
            </Button>
          ) : (
            <Button variant="primary" busy={running} onClick={startAnalyze}>
              {running ? (side ? 'Checking…' : 'Analyzing…') : side ? 'Check side job' : 'Analyze fit'}
            </Button>
          )}
          <DropdownMenu
            align="end"
            items={stateItems}
            trigger={
              <Button icon={<ChevronDown aria-hidden="true" />}>
                Status: {ref.status ? STATUS_LABEL[ref.status] : 'Not started'}
              </Button>
            }
          />
        </>
      }
    >
      <div className={s.meta} aria-label="Job details">
        {remote && <Tag>{remote}</Tag>}
        {salary && <span className={s.mono}>{salary}</span>}
        {analysis && (
          <Tag tone={VERDICT_TONE[analysis.result.verdict]}>
            {VERDICT_LABEL[analysis.result.verdict]} · {String(analysis.result.fit_score)}
          </Tag>
        )}
        {job.postedAt && <span className={s.mono}>posted {isoDay(job.postedAt)}</span>}
        {isWebUrl(link) && (
          <a href={link} target="_blank" rel="noreferrer noopener" className={s.link}>
            View posting
          </a>
        )}
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="job">Job</TabsTrigger>
          <TabsTrigger value="fit">Fit</TabsTrigger>
          <TabsTrigger value="resume">Resume</TabsTrigger>
          <TabsTrigger value="cover">Cover letter</TabsTrigger>
          <TabsTrigger value="apply">Apply</TabsTrigger>
          <TabsTrigger value="referrals">Referrals</TabsTrigger>
        </TabsList>
        <TabsContent value="job">
          <JobTab job={job} />
        </TabsContent>
        <TabsContent value="fit">
          {side ? (
            <SideFitTab
              sideFit={sideFit}
              running={running}
              secs={secs}
              error={analyzeError}
              onCancel={cancel}
              onCheck={startAnalyze}
            />
          ) : (
            <FitTab
              analysis={analysis}
              running={running}
              secs={secs}
              error={analyzeError}
              onCancel={cancel}
              onAnalyze={startAnalyze}
            />
          )}
        </TabsContent>
        {/* forceMount skips Radix's own hiding, hence `hidden`. Kept mounted so a running draft survives a tab switch and the palette commands work from any tab. */}
        <TabsContent value="resume" forceMount hidden={tab !== 'resume'}>
          <ResumeTab jobId={job.id} analyzed={analysis !== null} onActivate={() => setTab('resume')} />
        </TabsContent>
        <TabsContent value="cover" forceMount hidden={tab !== 'cover'}>
          <ResumeTab
            kind="cover"
            jobId={job.id}
            analyzed={analysis !== null}
            onActivate={() => setTab('cover')}
          />
        </TabsContent>
        <TabsContent value="apply">
          <ApplyTab job={job} onOpenResume={() => setTab('resume')} />
        </TabsContent>
        {/* Kept mounted so a running search survives a tab switch. */}
        <TabsContent value="referrals" forceMount hidden={tab !== 'referrals'}>
          <ReferralsTab job={job} />
        </TabsContent>
      </Tabs>

      {flow.dialogs}
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete "${job.title}"?`}
        description="The job, its analysis and its notes are removed. This cannot be undone."
        confirmLabel="Delete"
        danger
        onConfirm={() =>
          del.mutate(job.id, {
            onSuccess: () => {
              toast({ title: 'Job deleted' });
              void navigate({ to: WORKSPACE });
            },
            onError: (e) => toast({ title: 'Could not delete the job', description: e.message, tone: 'bad' }),
          })
        }
      />
    </Page>
  );
}
