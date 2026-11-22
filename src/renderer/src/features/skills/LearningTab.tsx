import { useState } from 'react';
import { matchesSkill } from '@shared/profile';
import { LEARNING_STATUSES, type LearningItem } from '@shared/skills/schemas';
import { parseResourcesMd } from '@shared/skills/resources';
import {
  Button,
  Checkbox,
  EmptyState,
  ErrorState,
  Loading,
  SectionHeader,
  Select,
  Tag,
  useToast,
} from '../../ui';
import { useProfile, type ProfileSnapshot } from '../../lib/profile';
import {
  useRoadmap,
  useSuggestResources,
  useUpdateLearning,
  useWhatIf,
  type RoadmapRow,
} from '../../lib/skills';
import { useElapsedSeconds } from '../../lib/hooks';
import { AddSkillDialog } from './AddSkillDialog';
import { MAX_WHAT_IF, profileModel, toggleWhatIf, whatIfLine } from './helpers';
import s from './skills.module.css';

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The roadmap (docs/07 §5): items by priority with "unlocks N jobs", a what-if line, and resources on demand. */
export function LearningTab(): React.JSX.Element {
  const { toast } = useToast();
  const q = useRoadmap();
  const profile = useProfile();
  const update = useUpdateLearning();
  const [picked, setPicked] = useState<string[]>([]);
  const [learned, setLearned] = useState<{ skill: string; snapshot: ProfileSnapshot } | null>(null);

  if (q.isPending) return <Loading what="Ranking the learning list" />;
  if (q.isError)
    return (
      <ErrorState
        title="Could not read the learning list"
        message={q.error.message}
        action={<Button onClick={() => void q.refetch()}>Try again</Button>}
      />
    );
  const { items, openJobs } = q.data;
  if (items.length === 0)
    return (
      <EmptyState title="Nothing to learn yet.">
        Press Learn on a skill in Gaps, or on a row in a resume's Skills tab. The list is ranked here by
        demand, effort and the jobs a skill unlocks.
      </EmptyState>
    );

  const active = items.filter((i) => i.status === 'todo' || i.status === 'doing');
  const inProfileAsHave = (skill: string): boolean =>
    !!profile.data &&
    !!profileModel(profile.data.markdown).skills.find((r) => matchesSkill(r, skill) && r.status === 'have');
  const setStatus = (l: RoadmapRow, status: LearningItem['status']): void =>
    update.mutate(
      { id: l.id, status },
      {
        onError: (e) => toast({ title: `Could not update ${l.skill}`, description: errText(e), tone: 'bad' }),
      },
    );

  return (
    <div className={s.screen}>
      <WhatIf active={active} picked={picked} onToggle={(k) => setPicked((p) => toggleWhatIf(p, k))} />
      <p className={s.hint}>
        Ranked by demand (required counts double) times the share of your {String(openJobs)} open{' '}
        {openJobs === 1 ? 'job' : 'jobs'} it unlocks, divided by the hours estimate. Hours are estimates.
      </p>
      <ol className={s.roadmap} aria-label="Learning roadmap">
        {items.map((l) => (
          <li key={l.id} className={s.roadItem}>
            <span className={s.prio} aria-label={`Priority ${String(l.priority)}`}>
              {l.priority}
            </span>
            <div className={s.roadMain}>
              <h3 className={s.roadTitle}>{l.skill}</h3>
              <p className={s.roadSummary}>{l.summary}</p>
              <Resources item={l} />
            </div>
            <div className={s.roadSide}>
              <Select
                size="sm"
                aria-label={`Status of ${l.skill}`}
                value={l.status}
                options={LEARNING_STATUSES.map((v) => ({ value: v, label: v }))}
                onValueChange={(v) => setStatus(l, v as LearningItem['status'])}
              />
              {l.unlocks > 0 && <Tag tone="info">{`unlocks ${String(l.unlocks)}`}</Tag>}
              {l.status === 'done' && !inProfileAsHave(l.skill) && (
                <Button
                  size="sm"
                  disabled={!profile.data}
                  onClick={() => profile.data && setLearned({ skill: l.skill, snapshot: profile.data })}
                >
                  Mark learned
                </Button>
              )}
            </div>
          </li>
        ))}
      </ol>
      {learned && (
        <AddSkillDialog
          skill={learned.skill}
          before={learned.snapshot.markdown}
          expectedHash={learned.snapshot.hash}
          onClose={() => setLearned(null)}
        />
      )}
    </div>
  );
}

function WhatIf({
  active,
  picked,
  onToggle,
}: {
  active: RoadmapRow[];
  picked: string[];
  onToggle: (skill: string) => void;
}): React.JSX.Element {
  const r = useWhatIf(picked);
  return (
    <section aria-label="What if" className={s.whatIf}>
      <SectionHeader title="What if" />
      {active.length === 0 ? (
        <p className={s.hint}>Start an item (todo or doing) to see what it would change.</p>
      ) : (
        <>
          <fieldset className={s.picker}>
            <legend className={s.hint}>Pick up to {MAX_WHAT_IF} skills you would learn</legend>
            {active.map((l) => (
              <Checkbox
                key={l.id}
                label={l.skill}
                checked={picked.includes(l.skill)}
                disabled={!picked.includes(l.skill) && picked.length >= MAX_WHAT_IF}
                onCheckedChange={() => onToggle(l.skill)}
              />
            ))}
          </fieldset>
          <p className={s.whatIfLine} role="status">
            {picked.length === 0
              ? 'Nothing picked.'
              : r.isError
                ? `Could not compute: ${r.error.message}`
                : r.data
                  ? whatIfLine(r.data)
                  : 'Counting…'}
          </p>
          {r.data && r.data.moved.length > 0 && (
            <ul className={s.moved} aria-label="Jobs that would move to apply">
              {r.data.moved.map((m) => (
                <li key={m.jobId}>
                  {m.company} · {m.title}{' '}
                  <span className={s.mono}>{`${String(m.before)} → ${String(m.after)}`}</span>
                </li>
              ))}
            </ul>
          )}
          {picked.length > 0 && (
            <p className={s.hint}>
              Approximation from the structured postings: +6 score for each required and +3 for each preferred
              skill covered; 70 or more is apply. A direction, not a promise.
            </p>
          )}
        </>
      )}
    </section>
  );
}

function Resources({ item }: { item: RoadmapRow }): React.JSX.Element | null {
  const { toast } = useToast();
  const suggest = useSuggestResources();
  const secs = useElapsedSeconds(suggest.isPending);
  const list = parseResourcesMd(item.resourcesMd);
  if (item.status === 'dropped') return null;
  const ask = (): void =>
    suggest.mutate(item.id, {
      onError: (e) =>
        toast({ title: `No resources for ${item.skill}`, description: errText(e), tone: 'bad' }),
    });
  return (
    <div className={s.resources}>
      {list.length > 0 && (
        <>
          <p className={s.micro}>Suggested resources (from Claude, not verified)</p>
          <ul className={s.resList} aria-label={`Resources for ${item.skill}`}>
            {list.map((r) => (
              <li key={r.url}>
                <a href={r.url} target="_blank" rel="noreferrer">
                  {r.title}
                </a>{' '}
                <span className={s.mono}>{r.kind.replace('_', ' ')}</span>
                <span className={s.resWhy}> {r.why}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <span className={s.resActions}>
        <Button size="sm" variant="ghost" busy={suggest.isPending} onClick={ask}>
          {suggest.isPending
            ? `Asking · ${String(secs)} s`
            : list.length > 0
              ? 'Suggest again'
              : 'Suggest resources'}
        </Button>
        {suggest.isPending && (
          <Button size="sm" variant="ghost" onClick={() => void suggest.cancel()}>
            Cancel
          </Button>
        )}
      </span>
    </div>
  );
}
