import type { InboxItem } from '@shared/discovery/schemas';
import { Button, ErrorState, Kbd, Loading, SectionHeader, StatusDot, Tag } from '../../ui';
import { useJob, type JobGet } from '../../lib/jobs';
import {
  REMOTE_LABEL,
  VERDICT_LABEL,
  VERDICT_TONE,
  formatSalary,
  isWebUrl,
  isoDay,
} from '../workspace/helpers';
import { scoreTone, sourceLabel } from './helpers';
import s from './inbox.module.css';

const SUMMARY_CHARS = 700;

/** JD summary: the parsed "about", else the start of the posting text. */
export function jdSummary(job: JobGet['job']): string {
  const about = job.structured?.about?.trim();
  if (about) return about;
  const text = job.descriptionMd.replace(/\s+/g, ' ').trim();
  return text.length > SUMMARY_CHARS ? `${text.slice(0, SUMMARY_CHARS).trimEnd()}…` : text;
}

export function InboxInspector({
  item,
  onShortlist,
  onDismiss,
  onOpenPosting,
  onOpenWorkspace,
  rescore,
}: {
  item: InboxItem;
  /** Re-score this job; `busy` while it runs, `disabled` while a scan or another re-score runs. */
  rescore: { run: () => void; busy: boolean; disabled: boolean };
  onShortlist: () => void;
  onDismiss: () => void;
  onOpenPosting: () => void;
  onOpenWorkspace: () => void;
}): React.JSX.Element {
  const q = useJob(item.jobId);
  const job = q.data?.job;
  const analysis = q.data?.analysis ?? null;
  const required = job?.structured?.requirements.filter((r) => r.kind === 'required').slice(0, 6) ?? [];
  const flags = analysis?.result.red_flags ?? [];

  return (
    <div className={s.inspectorBody}>
      <div>
        <h3 className={s.jobTitle}>{item.title}</h3>
        <p className={s.jobCompany}>{item.company}</p>
        <p className={s.jobMeta}>
          {[item.locationText, REMOTE_LABEL[item.remote], item.salaryText].filter(Boolean).join(' · ')}
        </p>
        <p className={s.mono}>
          {item.postedAt ? `posted ${isoDay(item.postedAt)} · ` : ''}found {isoDay(item.firstSeenAt)}
        </p>
      </div>

      <div className={s.actions}>
        <Button size="sm" onClick={onShortlist} aria-keyshortcuts="S">
          Shortlist <Kbd keys="S" />
        </Button>
        <Button size="sm" onClick={onDismiss} aria-keyshortcuts="D">
          Dismiss <Kbd keys="D" />
        </Button>
        <Button size="sm" onClick={onOpenPosting} disabled={!isWebUrl(item.url)} aria-keyshortcuts="O">
          Open posting <Kbd keys="O" />
        </Button>
        <Button size="sm" onClick={onOpenWorkspace}>
          Open in Workspace <Kbd keys="Enter" />
        </Button>
      </div>

      <section className={s.block} aria-label="Score">
        <SectionHeader
          title={item.scoreKind === 'fit' ? 'Fit analysis' : item.sideJob ? 'Side job' : 'Triage'}
          level={3}
          actions={
            // A fit analysis wins over triage in the Inbox, so re-triaging it would change nothing you see.
            item.scoreKind !== 'fit' && (
              <Button
                size="sm"
                variant="ghost"
                busy={rescore.busy}
                disabled={rescore.disabled}
                onClick={rescore.run}
              >
                {item.score === null ? 'Score now' : 'Re-score'}
              </Button>
            )
          }
        />
        {item.score === null ? (
          <p className={s.dim}>Not scored yet. The next scan scores it, or use Score now.</p>
        ) : (
          <>
            <StatusDot tone={scoreTone(item.score)}>
              <span className={s.mono}>{item.score}</span>
              {item.scoreKind === 'fit' ? ' fit score' : item.sideJob ? ' side-job score' : ' triage score'}
            </StatusDot>
            {item.reason && <p className={s.prose}>{item.reason}</p>}
          </>
        )}
        {analysis && (
          <p className={s.prose}>
            <StatusDot tone={VERDICT_TONE[analysis.result.verdict]}>
              Verdict: {VERDICT_LABEL[analysis.result.verdict]}
            </StatusDot>
          </p>
        )}
      </section>

      {q.isPending ? (
        <Loading what="Reading the posting" />
      ) : q.isError ? (
        <ErrorState
          title="Could not read this posting"
          message={q.error.message}
          action={<Button onClick={() => void q.refetch()}>Try again</Button>}
        />
      ) : (
        <>
          {analysis && analysis.result.verdict_reason && (
            <p className={s.prose}>{analysis.result.verdict_reason}</p>
          )}
          <section className={s.block} aria-label="Red flags">
            <SectionHeader title="Red flags" level={3} />
            {flags.length > 0 ? (
              <ul className={s.flags}>
                {flags.map((f, i) => (
                  <li key={`${String(i)}-${f}`}>{f}</li>
                ))}
              </ul>
            ) : (
              <p className={s.dim}>
                {analysis ? 'The analysis found none.' : 'Listed once the full analysis has run.'}
              </p>
            )}
          </section>
          <section className={s.block} aria-label="Job description">
            <SectionHeader title="Job description" level={3} />
            <p className={s.prose}>{job ? jdSummary(job) : ''}</p>
            {required.length > 0 && (
              <ul className={s.reqs} aria-label="Required">
                {required.map((r, i) => (
                  <li key={`${String(i)}-${r.text}`}>{r.text}</li>
                ))}
              </ul>
            )}
            {job && formatSalary(job.salaryMin, job.salaryMax, job.salaryCurrency, job.salaryPeriod) && (
              <p className={s.mono}>
                {formatSalary(job.salaryMin, job.salaryMax, job.salaryCurrency, job.salaryPeriod)}
              </p>
            )}
          </section>
        </>
      )}

      <section className={s.block} aria-label="Sources">
        <SectionHeader title="Found on" level={3} />
        <div className={s.tags}>
          {item.sources.map((x) => (
            <Tag key={x}>{sourceLabel(x)}</Tag>
          ))}
        </div>
      </section>
    </div>
  );
}
