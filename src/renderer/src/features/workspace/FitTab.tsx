import { Button, ErrorState, Loading, ScoreMeter, SectionHeader, Stat, Tag } from '../../ui';
import type { JobGet } from '../../lib/jobs';
import { useProfile } from '../../lib/profile';
import { FIT_THRESHOLDS, isoDay, removedCitationsNote } from './helpers';
import s from './workspace.module.css';

type Analysis = NonNullable<JobGet['analysis']>;

export function FitTab({
  analysis,
  running,
  secs,
  error,
  onCancel,
  onAnalyze,
}: {
  analysis: Analysis | null;
  running: boolean;
  secs: number;
  error: string | null;
  onCancel: () => void;
  onAnalyze: () => void;
}): React.JSX.Element {
  const profile = useProfile();
  // evidence id -> entry title, so the mono ids can be read; unresolved ids still show as ids
  const titles = new Map(
    [...(profile.data?.model.experience ?? []), ...(profile.data?.model.projects ?? [])].map((e) => [
      e.id,
      e.title,
    ]),
  );

  return (
    <div className={s.stack}>
      {running && (
        <div className={s.running}>
          <Loading what={`Analyzing fit with Claude · ${String(secs)} s`} />
          <Button size="sm" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      )}
      {error && (
        <ErrorState
          title="Could not analyze this job"
          message={error}
          action={<Button onClick={onAnalyze}>Try again</Button>}
        />
      )}
      {analysis === null ? (
        !running &&
        !error && (
          <div className={s.emptyFit} role="status">
            <h3 className={s.emptyTitle}>No fit analysis yet</h3>
            <p className={s.prose}>
              Analyze fit scores this job against your profile and lists what matches and what is missing.
            </p>
          </div>
        )
      ) : (
        <Result analysis={analysis} titles={titles} onAnalyze={onAnalyze} busy={running} />
      )}
    </div>
  );
}

function Result({
  analysis,
  titles,
  onAnalyze,
  busy,
}: {
  analysis: Analysis;
  titles: Map<string, string>;
  onAnalyze: () => void;
  busy: boolean;
}): React.JSX.Element {
  const r = analysis.result;
  const removed = removedCitationsNote(r.warnings);
  return (
    <>
      {(analysis.profileStale || analysis.postingStale) && (
        <div className={s.banner} role="status">
          <p>
            {analysis.postingStale && analysis.profileStale
              ? 'Profile and posting text changed since this analysis.'
              : analysis.postingStale
                ? 'Posting text changed since this analysis.'
                : 'Profile changed since this analysis.'}
          </p>
          <Button size="sm" busy={busy} onClick={onAnalyze}>
            Re-analyze
          </Button>
        </div>
      )}
      <div className={s.score}>
        <Stat label="Fit score" value={r.fit_score} />
        <div className={s.meter}>
          <ScoreMeter value={r.fit_score} thresholds={FIT_THRESHOLDS} label="Fit score" showValue={false} />
        </div>
        <p className={s.meta}>
          {isoDay(analysis.createdAt)} · {analysis.model} · prompt {analysis.promptVersion}
        </p>
      </div>
      <p className={s.prose}>{r.summary}</p>
      <p className={s.prose}>
        <span className={s.lead}>Verdict. </span>
        {r.verdict_reason}
      </p>

      {r.matched.length > 0 && (
        <section className={s.block}>
          <SectionHeader title={`Matched (${String(r.matched.length)})`} level={3} />
          <ul className={s.list}>
            {r.matched.map((m, i) => (
              <li key={`${String(i)}-${m.requirement}`} className={s.item}>
                <span>
                  {m.requirement}
                  {m.note && <span className={s.muted}> — {m.note}</span>}
                </span>
                {m.evidence_ids.length > 0 && (
                  <span className={s.tags}>
                    {m.evidence_ids.map((id) => (
                      <span key={id} className={s.mono} title={titles.get(id)}>
                        <Tag>{id}</Tag>
                      </span>
                    ))}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {r.missing_skills.length > 0 && (
        <section className={s.block}>
          <SectionHeader title={`Missing skills (${String(r.missing_skills.length)})`} level={3} />
          <ul className={s.list}>
            {r.missing_skills.map((m) => (
              <li key={m.skill} className={s.item}>
                <span>
                  {m.skill}
                  {m.have_adjacent && <span className={s.muted}> — you have {m.have_adjacent}</span>}
                </span>
                <Tag tone={m.importance === 'required' ? 'warn' : 'neutral'}>{m.importance}</Tag>
              </li>
            ))}
          </ul>
        </section>
      )}

      <Plain title="Missing experience" items={r.missing_experience} />
      <Plain title="Red flags" items={r.red_flags} tone="bad" />
      <Plain title="Strengths" items={r.strengths} />

      {removed && <p className={s.note}>{removed}</p>}
    </>
  );
}

function Plain({
  title,
  items,
  tone,
}: {
  title: string;
  items: string[];
  tone?: 'bad';
}): React.JSX.Element | null {
  if (items.length === 0) return null;
  return (
    <section className={s.block}>
      <SectionHeader title={`${title} (${String(items.length)})`} level={3} />
      <ul className={s.list}>
        {items.map((t, i) => (
          <li key={`${String(i)}-${t}`} className={tone === 'bad' ? `${s.item} ${s.flag}` : s.item}>
            {t}
          </li>
        ))}
      </ul>
    </section>
  );
}
