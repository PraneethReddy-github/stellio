import { useNavigate, useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { Page } from '../../app/Page';
import {
  Button,
  ErrorState,
  KeyValue,
  Loading,
  ScoreMeter,
  StatusDot,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '../../ui';
import { useApplication, type TrackerDetail } from '../../lib/tracker';
import { FIT_THRESHOLDS, isWebUrl, isoDay } from '../workspace/helpers';
import { AnalysisTab, DocumentsTab, OverviewTab } from './DetailTabs';
import { ContactsTab, InterviewsTab } from './PeopleTabs';
import { STATUS_LABEL, STATUS_TONE, route } from './helpers';
import { StatusMenu, useStatusFlow, type StatusRef } from './StatusFlow';
import s from './applications.module.css';

export const refOf = (d: TrackerDetail): StatusRef => ({
  id: d.application.id,
  jobId: d.job.id,
  status: d.application.status,
  company: d.job.company,
});

/** `/applications/$id`: the full application. */
export default function ApplicationDetail(): React.JSX.Element {
  const params: { id?: string } = useParams({ strict: false });
  const navigate = useNavigate();
  const q = useApplication(params.id ?? null);
  if (!q.data)
    return (
      <Page title="Application">
        {q.isError ? (
          <ErrorState
            title="Could not open this application"
            message={q.error.message}
            action={
              <Button onClick={() => void navigate({ to: route('/applications') })}>
                Back to Applications
              </Button>
            }
          />
        ) : (
          <Loading what="Reading application" />
        )}
      </Page>
    );
  return <DetailView key={q.data.application.id} data={q.data} />;
}

function DetailView({ data }: { data: TrackerDetail }): React.JSX.Element {
  const { application: app, job } = data;
  const navigate = useNavigate();
  const flow = useStatusFlow();
  const [tab, setTab] = useState('overview');
  const link = job.applyUrl ?? job.url;
  return (
    <Page
      title={job.title}
      subtitle={job.company}
      actions={
        <>
          <Button onClick={() => void navigate({ to: `/workspace/${job.id}` })}>Open in Workspace</Button>
          <StatusMenu current={app.status} onPick={(to) => flow.request(refOf(data), to)} />
        </>
      }
    >
      <div className={s.meta} aria-label="Application details">
        <StatusDot tone={STATUS_TONE[app.status]}>{STATUS_LABEL[app.status]}</StatusDot>
        {job.fitScore !== null && (
          <span className={s.metaMeter}>
            <ScoreMeter value={job.fitScore} thresholds={FIT_THRESHOLDS} label="Fit score" />
          </span>
        )}
        {app.appliedAt && <span className={s.mono}>applied {isoDay(app.appliedAt)}</span>}
        {isWebUrl(link) && (
          <a href={link} target="_blank" rel="noreferrer noopener" className={s.link}>
            View posting
          </a>
        )}
      </div>
      {app.status === 'ready' && (
        <p className={s.callout}>
          Ready, not sent.{' '}
          <Button size="sm" variant="primary" onClick={() => void navigate({ to: `/workspace/${job.id}` })}>
            Go to the Apply tab
          </Button>
        </p>
      )}
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="documents">Documents</TabsTrigger>
          <TabsTrigger value="analysis">Analysis</TabsTrigger>
          <TabsTrigger value="interviews">Interviews</TabsTrigger>
          <TabsTrigger value="contacts">Contacts</TabsTrigger>
        </TabsList>
        <TabsContent value="overview">
          <OverviewTab data={data} />
        </TabsContent>
        <TabsContent value="documents">
          <DocumentsTab data={data} />
        </TabsContent>
        <TabsContent value="analysis">
          <AnalysisTab data={data} />
        </TabsContent>
        <TabsContent value="interviews">
          <InterviewsTab data={data} />
        </TabsContent>
        <TabsContent value="contacts">
          <ContactsTab data={data} />
        </TabsContent>
      </Tabs>
      {flow.dialogs}
    </Page>
  );
}

/** Inspector body: the short version of the detail, with the way to the full page. */
export function ApplicationSummary({ id }: { id: string }): React.JSX.Element {
  const navigate = useNavigate();
  const q = useApplication(id);
  const flow = useStatusFlow();
  if (q.isPending) return <Loading what="Reading application" />;
  if (q.isError) return <ErrorState title="Could not open this application" message={q.error.message} />;
  const d = q.data;
  const { application: app, job } = d;
  return (
    <div className={s.summary}>
      <div>
        <p className={s.strong}>{job.title}</p>
        <p className={s.dim}>{job.company}</p>
      </div>
      <div className={s.statusRow}>
        <StatusMenu current={app.status} onPick={(to) => flow.request(refOf(d), to)} size="sm" />
      </div>
      <KeyValue
        items={[
          { key: 'Status', value: STATUS_LABEL[app.status] },
          { key: 'Fit', value: job.fitScore === null ? '—' : String(job.fitScore), mono: true },
          { key: 'Applied', value: app.appliedAt ? isoDay(app.appliedAt) : '—', mono: true },
          { key: 'Next action', value: app.nextAction ?? '—' },
          { key: 'Interviews', value: String(d.interviews.length), mono: true },
        ]}
      />
      <div className={s.rowActions}>
        <Button variant="primary" size="sm" onClick={() => void navigate({ to: `/applications/${app.id}` })}>
          Open details
        </Button>
        <Button size="sm" onClick={() => void navigate({ to: `/workspace/${job.id}` })}>
          Open in Workspace
        </Button>
      </div>
      {flow.dialogs}
    </div>
  );
}
