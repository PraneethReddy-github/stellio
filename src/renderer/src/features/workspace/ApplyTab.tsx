import { useNavigate } from '@tanstack/react-router';
import { Check, Circle, Copy, FolderOpen, Minus } from 'lucide-react';
import { useState } from 'react';
import type { JobGet } from '../../lib/jobs';
import { useProfile } from '../../lib/profile';
import {
  openFolder,
  useAppForJob,
  useApplication,
  useCreateApp,
  useUpdateApp,
  type TrackerDetail,
} from '../../lib/tracker';
import {
  Button,
  EmptyState,
  ErrorState,
  IconButton,
  Input,
  Loading,
  SectionHeader,
  useToast,
} from '../../ui';
import { ApplyDialog } from '../applications/StatusFlow';
import { STATUS_LABEL, route } from '../applications/helpers';
import { isWebUrl, isoDay } from './helpers';
import s from './apply.module.css';

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The checklist, the copy-ready fields and "I applied" (docs/10 Workspace, Apply). */
export function ApplyTab({
  job,
  onOpenResume,
}: {
  job: JobGet['job'];
  /** Switches the page to the Resume tab, where a version is marked final. */
  onOpenResume: () => void;
}): React.JSX.Element {
  const q = useAppForJob(job.id);
  const create = useCreateApp();
  const { toast } = useToast();
  if (q.isPending) return <Loading what="Reading application" />;
  if (q.isError)
    return (
      <ErrorState
        title="Could not read the application"
        message={q.error.message}
        action={<Button onClick={() => void q.refetch()}>Try again</Button>}
      />
    );
  if (!q.data)
    return (
      <EmptyState
        title="No application yet"
        action={
          <Button
            variant="primary"
            busy={create.isPending}
            onClick={() =>
              create.mutate(job.id, {
                onError: (e) =>
                  toast({ title: 'Could not start the application', description: errorText(e), tone: 'bad' }),
              })
            }
          >
            Start application
          </Button>
        }
      >
        Shortlist the job or start a resume and it appears here. You can also start it now.
      </EmptyState>
    );
  return <Checklist job={job} appId={q.data.id} onOpenResume={onOpenResume} />;
}

type Mark = 'done' | 'todo' | 'skip';
function Item({
  mark,
  label,
  children,
}: {
  mark: Mark;
  label: string;
  children?: React.ReactNode;
}): React.JSX.Element {
  return (
    <li className={s.item}>
      <span className={s.mark} data-mark={mark}>
        {mark === 'done' ? (
          <Check aria-hidden="true" />
        ) : mark === 'todo' ? (
          <Circle aria-hidden="true" />
        ) : (
          <Minus aria-hidden="true" />
        )}
        <span className="sr-only">
          {mark === 'done' ? 'Done: ' : mark === 'skip' ? 'Optional: ' : 'To do: '}
        </span>
      </span>
      <span className={s.itemLabel}>{label}</span>
      <span className={s.itemBody}>{children}</span>
    </li>
  );
}

function Checklist({
  job,
  appId,
  onOpenResume,
}: {
  job: JobGet['job'];
  appId: string;
  onOpenResume: () => void;
}): React.JSX.Element {
  const q = useApplication(appId);
  const profile = useProfile();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [confirming, setConfirming] = useState(false);
  if (!q.data)
    return q.isError ? (
      <ErrorState title="Could not read the application" message={q.error.message} />
    ) : (
      <Loading what="Reading application" />
    );
  const d: TrackerDetail = q.data;
  const app = d.application;
  const resume = d.documents.resume.find((v) => v.isFinal);
  const cover = d.documents.cover.find((v) => v.isFinal);
  const link = job.applyUrl ?? job.url;
  const fm = profile.data?.model.frontMatter;
  const floor = fm?.preferences.salary_floor;
  const fields: { label: string; value: string }[] = [
    { label: 'Name', value: fm?.name ?? '' },
    { label: 'Email', value: fm?.email ?? '' },
    { label: 'Phone', value: fm?.phone ?? '' },
    { label: 'LinkedIn', value: fm?.links.linkedin ?? '' },
    { label: 'Notice period', value: fm?.notice_period ?? '' },
    { label: 'Work authorization', value: fm?.work_authorization ?? '' },
  ];
  const salary =
    app.salaryExpectation ??
    (floor != null ? `${String(floor)} ${fm?.preferences.currency ?? ''}`.trim() : '');
  const applied = app.appliedAt !== null;

  return (
    <div className={s.apply}>
      <section aria-label="Checklist" className={s.block}>
        <SectionHeader title="Checklist" />
        <ul className={s.list}>
          <Item mark={resume ? 'done' : 'todo'} label="Final resume">
            {resume ? (
              `Version ${String(resume.version)} is final`
            ) : (
              <Button size="sm" onClick={onOpenResume}>
                Mark a version final first
              </Button>
            )}
          </Item>
          <Item mark={cover ? 'done' : 'skip'} label="Cover letter">
            {cover ? `Version ${String(cover.version)} is final` : 'None. A cover letter is optional.'}
          </Item>
          <Item mark={isWebUrl(link) ? 'done' : 'todo'} label="Apply link">
            {isWebUrl(link) ? (
              <>
                <a href={link} target="_blank" rel="noreferrer noopener" className={s.link}>
                  Open the application page
                </a>
                <CopyButton label="Apply link" value={link} />
              </>
            ) : (
              'This job has no link saved.'
            )}
          </Item>
        </ul>
      </section>

      <section aria-label="Copy-ready fields" className={s.block}>
        <SectionHeader title="Copy-ready fields" />
        {profile.isError && <p className={s.dim}>Could not read your profile: {profile.error.message}</p>}
        <ul className={s.list}>
          {fields.map((f) => (
            <li key={f.label} className={s.field}>
              <span className={s.fieldLabel}>{f.label}</span>
              {f.value ? (
                <span className={s.fieldValue}>{f.value}</span>
              ) : (
                <span className={s.dim}>
                  Not in your profile.{' '}
                  <button
                    type="button"
                    className={s.textLink}
                    onClick={() => void navigate({ to: route('/profile') })}
                  >
                    Open Profile
                  </button>
                </span>
              )}
              <CopyButton label={f.label} value={f.value} />
            </li>
          ))}
          <SalaryField
            key={salary} // the profile may arrive after the first render
            appId={app.id}
            value={app.salaryExpectation ?? ''}
            fallback={salary}
          />
        </ul>
      </section>

      <section aria-label="Apply" className={s.block}>
        {applied ? (
          <div className={s.done}>
            <p>
              <span className={s.strong}>{STATUS_LABEL[app.status]}</span>
              {app.appliedAt && <span className={s.dim}> since {isoDay(app.appliedAt)}</span>}
            </p>
            {d.frozen && (
              <p className={s.mono}>
                {d.frozen.folder} · {d.frozen.files.length} files
              </p>
            )}
            <div className={s.actions}>
              {d.frozen && (
                <Button
                  icon={<FolderOpen aria-hidden="true" />}
                  onClick={() => {
                    openFolder(app.id).catch((e: unknown) =>
                      toast({ title: 'Could not open the folder', description: errorText(e), tone: 'bad' }),
                    );
                  }}
                >
                  Open folder
                </Button>
              )}
              <Button onClick={() => void navigate({ to: `/applications/${app.id}` })}>
                Open application
              </Button>
            </div>
          </div>
        ) : (
          <div className={s.actions}>
            <Button variant="primary" onClick={() => setConfirming(true)}>
              I applied
            </Button>
            <span className={s.dim}>Freezes the final documents as what you sent.</span>
          </div>
        )}
      </section>

      {confirming && (
        <ApplyDialog
          ref_={{ id: app.id, jobId: job.id, status: app.status, company: job.company }}
          onClose={() => setConfirming(false)}
          onMarkFinal={onOpenResume}
        />
      )}
    </div>
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

/** Saved on the application when you leave the field; shows the profile's salary floor until you set one. */
function SalaryField({
  appId,
  value,
  fallback,
}: {
  appId: string;
  value: string;
  fallback: string;
}): React.JSX.Element {
  const update = useUpdateApp();
  const { toast } = useToast();
  const [text, setText] = useState(value || fallback);
  return (
    <li className={s.field}>
      <label htmlFor="salary-expectation" className={s.fieldLabel}>
        Salary expectation
      </label>
      <Input
        id="salary-expectation"
        size="sm"
        value={text}
        placeholder="e.g. EUR 70,000"
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          const next = text.trim();
          if (next === value) return;
          update.mutate(
            { id: appId, patch: { salaryExpectation: next || null } },
            { onError: (e) => toast({ title: 'Could not save', description: errorText(e), tone: 'bad' }) },
          );
        }}
      />
      <CopyButton label="Salary expectation" value={text.trim()} />
    </li>
  );
}
