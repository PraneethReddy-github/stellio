import { useRef, useState } from 'react';
import { CANCELLED_MESSAGE } from '@shared/messages';
import {
  Button,
  EmptyState,
  ErrorState,
  Field,
  Inspector,
  Input,
  Loading,
  ProgressLine,
  SplitView,
  Table,
  useToast,
} from '../../ui';
import { useElapsedSeconds } from '../../lib/hooks';
import type { JobGet } from '../../lib/jobs';
import { cancelTask } from '../../lib/jobs';
import { useReferrals, useSearchPeople, useSearchStage, type SearchOutcome } from '../../lib/referrals';
import { formatLocation } from '../workspace/helpers';
import { jobColumns } from './columns';
import { BOUNDARY_LINE, STAGE_LABEL, excludeFor, outcomeLine, peopleCount, splitList } from './helpers';
import { ReferralInspector } from './ReferralInspector';
import s from './referrals.module.css';

/** Find people at the job's company, read where each fact came from, draft a message you send yourself (docs/14). */
export function ReferralsTab({ job }: { job: JobGet['job'] }): React.JSX.Element {
  const list = useReferrals(job.id);
  const all = useReferrals();
  const search = useSearchPeople();
  const { toast } = useToast();
  const [company, setCompany] = useState(job.company);
  const [role, setRole] = useState(job.title);
  const [location, setLocation] = useState(formatLocation(job) ?? '');
  const [team, setTeam] = useState('');
  const [seniority, setSeniority] = useState('');
  const [alumni, setAlumni] = useState('');
  const [languages, setLanguages] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<SearchOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);
  const stage = useSearchStage(requestId);
  const secs = useElapsedSeconds(search.isPending);
  const idRef = useRef<string | null>(null);

  const items = list.data ?? [];
  const selected = items.find((i) => i.id === sel) ?? null;
  const ready = company.trim() !== '' && role.trim() !== '';

  const run = (more: boolean): void => {
    if (search.isPending || !ready) return;
    const id = crypto.randomUUID();
    idRef.current = id;
    setRequestId(id);
    setError(null);
    const hints = {
      team: team.trim() || undefined,
      seniority: seniority.trim() || undefined,
      alumni: splitList(alumni).slice(0, 5),
      languages: splitList(languages).slice(0, 5),
    };
    search.mutate(
      {
        jobId: job.id,
        company: company.trim(),
        role: role.trim(),
        location: location.trim(),
        hints,
        // "Search more" asks for different people than the ones already stored for this company
        exclude: more ? excludeFor(all.data ?? [], company) : undefined,
        requestId: id,
      },
      {
        onSuccess: setOutcome,
        onError: (e) => {
          if (e.message === CANCELLED_MESSAGE) toast({ title: 'Cancelled' });
          else setError(e.message);
        },
      },
    );
  };

  return (
    <div className={s.tab}>
      <form
        className={s.form}
        aria-label="Who to look for"
        onSubmit={(e) => {
          e.preventDefault();
          run(false);
        }}
      >
        <p className={s.boundary}>{BOUNDARY_LINE}</p>
        <div className={s.formGrid}>
          <Field label="Company">
            {(f) => <Input {...f} value={company} onChange={(e) => setCompany(e.target.value)} />}
          </Field>
          <Field label="Role">
            {(f) => <Input {...f} value={role} onChange={(e) => setRole(e.target.value)} />}
          </Field>
          <Field label="Location">
            {(f) => (
              <Input
                {...f}
                value={location}
                placeholder="City, country or remote"
                onChange={(e) => setLocation(e.target.value)}
              />
            )}
          </Field>
          <Field label="Team (optional)">
            {(f) => <Input {...f} value={team} onChange={(e) => setTeam(e.target.value)} />}
          </Field>
          <Field label="Seniority (optional)">
            {(f) => (
              <Input
                {...f}
                value={seniority}
                placeholder="e.g. senior"
                onChange={(e) => setSeniority(e.target.value)}
              />
            )}
          </Field>
          <Field label="Alumni of (optional)" hint="Separate several with commas.">
            {(f) => <Input {...f} value={alumni} onChange={(e) => setAlumni(e.target.value)} />}
          </Field>
          <Field label="Languages (optional)" hint="Separate several with commas.">
            {(f) => <Input {...f} value={languages} onChange={(e) => setLanguages(e.target.value)} />}
          </Field>
        </div>
        <div className={s.row}>
          {search.isPending ? (
            <Button
              onClick={() => {
                if (idRef.current) void cancelTask(idRef.current);
              }}
            >
              Cancel search
            </Button>
          ) : (
            <Button type="submit" variant="primary" disabled={!ready}>
              Find people
            </Button>
          )}
          {search.isPending && (
            <p className={s.mono} role="status">
              {stage ? STAGE_LABEL[stage.stage] : 'Starting'}
              {stage?.stage === 'validating' && stage.count !== undefined
                ? ` · ${String(stage.count)} candidates`
                : ''}{' '}
              · {secs} s
            </p>
          )}
        </div>
        {search.isPending && <ProgressLine label="Searching for people" />}
      </form>

      {error && (
        <ErrorState
          title="The search did not finish"
          message={error}
          action={<Button onClick={() => run(false)}>Try again</Button>}
        />
      )}

      {list.isPending ? (
        <Loading what="Reading people" />
      ) : list.isError ? (
        <ErrorState
          title="Could not read the people"
          message={list.error.message}
          action={<Button onClick={() => void list.refetch()}>Try again</Button>}
        />
      ) : items.length === 0 ? (
        !search.isPending && (
          <EmptyState title="No people yet">
            {outcome
              ? `${outcomeLine(outcome)} Check the company name and the role, or widen the location.`
              : 'Find people searches public pages for people at this company in a similar role.'}
          </EmptyState>
        )
      ) : (
        <section className={s.results} aria-label="People">
          <p className={s.count} role="status">
            {peopleCount(items.length)}
            {outcome && !search.isPending ? ` · ${outcomeLine(outcome)}` : ''}
          </p>
          <div
            className={s.tableWrap}
            style={{
              height: selected
                ? '640px'
                : `calc(var(--row) * ${String(Math.min(items.length, 10) + 1)} + 2px)`,
            }}
          >
            <SplitView
              inspector={
                selected && (
                  <Inspector title="Person" onClose={() => setSel(null)}>
                    <ReferralInspector key={selected.id} item={selected} onDeleted={() => setSel(null)} />
                  </Inspector>
                )
              }
            >
              <Table
                ariaLabel="People at the company"
                columns={jobColumns}
                rows={items}
                getRowId={(r) => r.id}
                selectedId={sel ?? undefined}
                onSelectedChange={setSel}
              />
            </SplitView>
          </div>
          <div className={s.more}>
            <p>
              Found {peopleCount(items.length)}. Search for more?{' '}
              <span className={s.dim}>Each search uses Claude usage.</span>
            </p>
            <Button disabled={!ready} busy={search.isPending} onClick={() => run(true)}>
              Search more
            </Button>
          </div>
        </section>
      )}
    </div>
  );
}
