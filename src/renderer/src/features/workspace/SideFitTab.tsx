import type { SideFitRecord } from '@shared/jobs/schemas';
import { Button, ErrorState, Loading, ScoreMeter, Stat, StatusDot, Tag } from '../../ui';
import type { Tone } from '../../ui/StatusDot';
import { FIT_THRESHOLDS, isoDay } from './helpers';
import s from './workspace.module.css';

type Check = SideFitRecord['result']['checks'][number];

const ASPECT: Record<Check['aspect'], string> = {
  pay: 'Pay',
  hours: 'Hours',
  place: 'Place',
  language: 'Language',
  needs: 'Needs',
  schedule: 'Schedule',
  extras: 'Extras',
};
// The word carries the meaning; the dot only repeats it (docs/09: never colour alone).
const STATUS: Record<Check['status'], { tone: Tone; word: string }> = {
  ok: { tone: 'ok', word: 'OK' },
  warn: { tone: 'warn', word: 'Check' },
  bad: { tone: 'bad', word: 'Fails' },
  info: { tone: 'neutral', word: 'Info' },
};
const VERDICT: Record<SideFitRecord['result']['verdict'], { tone: Tone; label: string }> = {
  take: { tone: 'ok', label: 'Take it' },
  maybe: { tone: 'warn', label: 'Maybe' },
  skip: { tone: 'bad', label: 'Skip' },
};

/** The Fit tab of a side job: pay, hours, place, language and needs, each with the posting's own words. */
export function SideFitTab({
  sideFit,
  running,
  secs,
  error,
  onCancel,
  onCheck,
}: {
  sideFit: SideFitRecord | null;
  running: boolean;
  secs: number;
  error: string | null;
  onCancel: () => void;
  onCheck: () => void;
}): React.JSX.Element {
  const r = sideFit?.result;
  const stale = sideFit && (sideFit.profileStale || sideFit.postingStale);
  return (
    <div className={s.stack}>
      {running && (
        <div className={s.running}>
          <Loading what={`Checking the side job with Claude · ${String(secs)} s`} />
          <Button size="sm" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      )}
      {error && (
        <ErrorState
          title="Could not check this side job"
          message={error}
          action={<Button onClick={onCheck}>Try again</Button>}
        />
      )}
      {!sideFit || !r ? (
        !running &&
        !error && (
          <div className={s.emptyFit} role="status">
            <h3 className={s.emptyTitle}>No side-job check yet</h3>
            <p className={s.prose}>
              Check side job looks at pay, hours, place, language and what the job asks for, against your
              side-job limits, and quotes the posting for each.
            </p>
          </div>
        )
      ) : (
        <>
          {stale && (
            <div className={s.banner} role="status">
              <p>
                {sideFit.postingStale
                  ? 'Posting text changed since this check.'
                  : 'Profile changed since this check.'}
              </p>
              <Button size="sm" busy={running} onClick={onCheck}>
                Re-check
              </Button>
            </div>
          )}
          <div className={s.score}>
            <Stat label="Side-job score" value={r.side_score} />
            <div className={s.meter}>
              <ScoreMeter
                value={r.side_score}
                thresholds={FIT_THRESHOLDS}
                label="Side-job score"
                showValue={false}
              />
            </div>
            <Tag tone={VERDICT[r.verdict].tone}>{VERDICT[r.verdict].label}</Tag>
            <p className={s.meta}>
              {isoDay(sideFit.createdAt)} · {sideFit.model}
            </p>
          </div>
          <p className={s.prose}>{r.summary}</p>
          <ul className={s.list} aria-label="Side-job checks">
            {r.checks.map((c) => (
              <li key={c.aspect} className={s.sideCheck}>
                <span className={s.lead}>{ASPECT[c.aspect]}</span>
                <StatusDot tone={STATUS[c.status].tone}>{STATUS[c.status].word}</StatusDot>
                <span>
                  {c.finding}
                  {c.quote && <q className={s.quote}>{c.quote}</q>}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
