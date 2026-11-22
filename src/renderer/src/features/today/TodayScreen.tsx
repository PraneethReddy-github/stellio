import { Link, useNavigate } from '@tanstack/react-router';
import { Page } from '../../app/Page';
import { Bars, Button, EmptyState, ErrorState, Loading, SectionHeader, Stat, StatusDot } from '../../ui';
import { useToday, type TodayData } from '../../lib/tracker';
import { percentText } from '../skills/helpers';
import { formatWhen, route } from '../applications/helpers';
import { sourceLabel } from '../inbox/helpers';
import { SetupChecklist } from './SetupChecklist';
import { funnelRows, isFresh, needsYouRows, weeklyBars } from './helpers';
import s from './today.module.css';

const dateLine = (d: Date): string =>
  d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });

export default function TodayScreen(): React.JSX.Element {
  const q = useToday();
  return (
    <Page title="Today" subtitle={dateLine(new Date())}>
      {q.isPending ? (
        <Loading what="Reading your applications" />
      ) : q.isError ? (
        <ErrorState
          title="Could not read the dashboard"
          message={q.error.message}
          action={<Button onClick={() => void q.refetch()}>Try again</Button>}
        />
      ) : (
        <Dashboard t={q.data} />
      )}
    </Page>
  );
}

function Dashboard({ t }: { t: TodayData }): React.JSX.Element {
  const navigate = useNavigate();
  const rows = needsYouRows(t.needsYou);
  const funnel = funnelRows(t.funnel.steps);
  const weeklyTotal = t.weekly.reduce((n, w) => n + w.count, 0);
  const noJobs = (t.funnel.steps[0]?.count ?? 0) === 0;

  return (
    <div className={s.today}>
      <SetupChecklist />
      {isFresh(t) && (
        <EmptyState
          title="Nothing tracked yet"
          action={<Button onClick={() => void navigate({ to: route('/workspace') })}>Add a job</Button>}
        >
          Add a job in the Workspace. When you shortlist it or start a resume, it shows up here.
        </EmptyState>
      )}

      <section aria-label="Status line" className={s.block}>
        <SectionHeader
          title="This month"
          actions={
            <Link to={route('/applications')} className={s.link}>
              Open Applications
            </Link>
          }
        />
        <div className={s.statusLine}>
          {t.statusLine.map((x) => (
            <div key={x.key} className={s.tile}>
              <Stat label={x.label} value={x.count} delta={x.delta} deltaLabel="vs last month" />
              <p className={s.now}>{x.current} now</p>
            </div>
          ))}
        </div>
      </section>

      <div className={s.cols}>
        <section aria-label="Needs you" className={s.block}>
          <SectionHeader title="Needs you" />
          {rows.length === 0 ? (
            <p className={s.dim}>Nothing needs you right now.</p>
          ) : (
            <ul className={s.list}>
              {rows.map((r) => (
                <li key={r.key}>
                  <Link to={r.to} className={s.row}>
                    <StatusDot tone={r.tone}>{r.kind}</StatusDot>
                    <span className={s.rowTitle}>{r.title}</span>
                    <span className={s.mono}>{r.detail}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-label="New matches" className={s.block}>
          <SectionHeader
            title="New matches"
            actions={
              <Link to={route('/inbox')} className={s.link}>
                Inbox
              </Link>
            }
          />
          {t.newMatches.length === 0 ? (
            <p className={s.dim}>No new matches. Scan from the Inbox to look for jobs.</p>
          ) : (
            <ul className={s.list}>
              {t.newMatches.map((m) => (
                <li key={m.jobId}>
                  <Link to={route('/inbox')} search={{ job: m.jobId }} className={s.row}>
                    <span className={s.fit}>{m.fit ?? '—'}</span>
                    <span className={s.rowTitle}>
                      {m.company} · {m.title}
                    </span>
                    {m.reason && <span className={s.dim}>{m.reason}</span>}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-label="Funnel" className={s.block}>
          <SectionHeader title={`Funnel, last ${String(t.funnel.windowDays)} days`} />
          {noJobs ? (
            <p className={s.dim}>No jobs stored in the last {t.funnel.windowDays} days.</p>
          ) : (
            <ol className={s.funnel}>
              {funnel.map((f) => (
                <li key={f.key} className={s.step}>
                  <span className={s.stepLabel}>{f.label}</span>
                  <span className={s.track} aria-hidden="true">
                    <span className={s.fill} style={{ width: `${String(f.width * 100)}%` }} />
                  </span>
                  <span className={s.stepCount}>{f.count}</span>
                  <span className={s.stepPct}>{f.pct ?? ''}</span>
                </li>
              ))}
            </ol>
          )}
        </section>

        <section aria-label="Applications per week" className={s.block}>
          <SectionHeader title="Applications per week" />
          {weeklyTotal === 0 ? (
            <p className={s.dim}>No application sent in the last 12 weeks.</p>
          ) : (
            <div className={s.chart}>
              <Bars data={weeklyBars(t.weekly)} ariaLabel="Applications per week" />
              <p className={s.axis}>Weeks start on Monday (MM-DD). The orange bar is this week.</p>
            </div>
          )}
        </section>

        <section aria-label="Skills pulse" className={s.block}>
          <SectionHeader
            title="Skills pulse"
            actions={
              <Link to={route('/skills')} className={s.link}>
                Skills
              </Link>
            }
          />
          {t.skills.missing.length === 0 && t.skills.learning.length === 0 ? (
            <p className={s.dim}>
              Analyze a job and the skills it asks for that you lack show up here, by demand.
            </p>
          ) : (
            <>
              {t.skills.missing.length > 0 && (
                <ul className={s.list} aria-label="Most missing skills">
                  {t.skills.missing.map((m) => (
                    <li key={m.skill} className={s.skill}>
                      <span>{m.skill}</span>
                      <span className={s.mono}>{percentText(m.share)} of jobs</span>
                    </li>
                  ))}
                </ul>
              )}
              {t.skills.learning.length > 0 && (
                <>
                  <h3 className={s.sub}>Learning</h3>
                  <ul className={s.list} aria-label="Learning in progress">
                    {t.skills.learning.map((l) => (
                      <li key={l.id} className={s.skill}>
                        <span>{l.skill}</span>
                        <span className={s.mono}>{l.status}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </>
          )}
        </section>

        <section aria-label="Last scan" className={s.block}>
          <SectionHeader title="Last scan" />
          {t.lastScan === null ? (
            <p className={s.dim}>No scan has run. Scan now from the Inbox.</p>
          ) : (
            <div className={s.scan}>
              <p>
                <span className={s.mono}>{formatWhen(t.lastScan.startedAt)}</span> · {t.lastScan.status} ·{' '}
                {t.lastScan.newJobs} new
              </p>
              <ul className={s.list}>
                {Object.entries(t.lastScan.perSource).map(([src, v]) => (
                  <li key={src} className={s.skill}>
                    <span>{sourceLabel(src)}</span>
                    <span className={s.mono}>
                      {v.fetched} fetched · {v.new} new
                      {v.errors.length > 0 ? ` · ${String(v.errors.length)} errors` : ''}
                    </span>
                  </li>
                ))}
              </ul>
              {t.lastScan.error && <p className={s.dim}>{t.lastScan.error}</p>}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
