import { useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { setupComplete, setupSteps, type SetupStep } from '@shared/setup';
import { Button, SectionHeader, StatusDot } from '../../ui';
import { useProfiles, useSchedule } from '../../lib/discovery';
import { useLatexStatus } from '../../lib/latex';
import { useProfile } from '../../lib/profile';
import { useSetSetup, useSetup } from '../../lib/setup';
import { useAiStatus } from '../../lib/settings';
import { route } from '../applications/helpers';
import s from './setup.module.css';

const LABEL = { done: 'Done', todo: 'To do', checking: 'Checking' } as const;
const TONE = { done: 'ok', todo: 'neutral', checking: 'neutral' } as const;

/** First-run Setup on Today (docs/10). Shown until dismissed or every required step is done. */
export function SetupChecklist(): React.JSX.Element | null {
  const navigate = useNavigate();
  const setup = useSetup();
  const save = useSetSetup();
  const ai = useAiStatus();
  const profile = useProfile();
  const profiles = useProfiles();
  const latex = useLatexStatus();
  const schedule = useSchedule();

  const steps = setupSteps({
    ai: ai.data,
    profile: profile.data?.model,
    rulesReviewed: setup.data?.rulesReviewed ?? false,
    searchProfiles: profiles.data?.length,
    latex: latex.data,
    scanEnabled: schedule.data?.enabled,
  });
  const loaded = setup.data !== undefined && steps.every((x) => x.status !== 'checking');
  const complete = loaded && setupComplete(steps);
  const remember = setup.data?.completed === false && complete;
  const { mutate } = save;
  useEffect(() => {
    if (remember) mutate({ completed: true });
  }, [remember, mutate]);

  if (!setup.data || setup.data.dismissed || setup.data.completed) return null;

  const firstTodo = steps.find((x) => !x.optional && x.status === 'todo')?.id;
  const go = (step: SetupStep): void =>
    void navigate({
      to: route(step.action.to),
      ...(step.action.section ? { search: { section: step.action.section } } : {}),
    });

  return (
    <section aria-label="Setup" className={s.setup}>
      <SectionHeader
        title="Set up Stellio"
        actions={
          <Button variant="ghost" size="sm" onClick={() => save.mutate({ dismissed: true })}>
            Dismiss
          </Button>
        }
      />
      <p className={s.lead}>
        A few things make Stellio useful. Each shows its real state; nothing here is checked off for you.
      </p>
      <ol className={s.steps}>
        {steps.map((step) => (
          <li key={step.id} className={s.step} data-step={step.id} data-status={step.status}>
            <StatusDot tone={TONE[step.status]}>{LABEL[step.status]}</StatusDot>
            <div className={s.text}>
              <p className={s.title}>{step.title}</p>
              <p className={s.detail}>{step.detail}</p>
            </div>
            {step.status !== 'done' && step.status !== 'checking' && (
              <Button
                size="sm"
                variant={step.id === firstTodo ? 'primary' : 'secondary'}
                onClick={() => go(step)}
              >
                {step.action.label}
              </Button>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
