import { useId, useState } from 'react';
import {
  AI_TASKS,
  AiSettingsSchema,
  DEFAULT_AI_SETTINGS,
  EFFORTS,
  type AiSettings,
  type AiTask,
  type Effort,
} from '@shared/settings/ai';
import {
  Button,
  ErrorState,
  Field,
  Input,
  Loading,
  SectionHeader,
  Select,
  StatusDot,
  useToast,
} from '../../ui';
import {
  CUSTOM,
  MODEL_PRESETS,
  SECONDS_RANGE,
  modelChoice,
  modelError,
  parseSeconds,
  sameSettings,
  useAiSettings,
  useAiStatus,
  useSetAi,
} from '../../lib/settings';
import s from './settings.module.css';

const MODEL_OPTIONS = [
  ...MODEL_PRESETS.map((m) => ({ value: m, label: m })),
  { value: CUSTOM, label: 'Custom…' },
];
const EFFORT_OPTIONS = EFFORTS.map((e) => ({ value: e, label: e }));
const CONCURRENCY_OPTIONS = [1, 2, 3, 4].map((n) => ({ value: String(n), label: String(n) }));

/** Everything is text or a choice as the user left it; `build` turns it into a validated value. */
interface Form {
  models: Record<AiTask, { model: string; effort: Effort }>;
  custom: Record<AiTask, boolean>;
  concurrency: number;
  def: string;
  gen: string;
}

export const toForm = (v: AiSettings): Form => ({
  models: structuredClone(v.models),
  custom: Object.fromEntries(
    AI_TASKS.map((t) => [t, modelChoice(v.models[t].model) === CUSTOM]),
  ) as Form['custom'],
  concurrency: v.concurrency,
  def: String(v.timeoutsSec.default),
  gen: String(v.timeoutsSec.generation),
});

/** The settings to save, or null while any field is invalid. Per-field messages come from the same helpers. */
export function build(f: Form): AiSettings | null {
  const def = parseSeconds(f.def);
  const gen = parseSeconds(f.gen);
  if (def === null || gen === null) return null;
  const models = Object.fromEntries(
    AI_TASKS.map((t) => [t, { model: f.models[t].model.trim(), effort: f.models[t].effort }]),
  ) as AiSettings['models'];
  const r = AiSettingsSchema.safeParse({
    models,
    concurrency: f.concurrency,
    timeoutsSec: { default: def, generation: gen },
  });
  return r.success ? r.data : null;
}

export function AiSection(): React.JSX.Element {
  const q = useAiSettings();
  return (
    <section id="settings-ai" className={s.section} aria-label="AI">
      <SectionHeader title="AI" level={3} />
      <CliStatus />
      {q.data ? (
        // Remount when the saved value changes, so the form starts clean after a save.
        <AiForm key={JSON.stringify(q.data)} saved={q.data} />
      ) : q.isError ? (
        <ErrorState
          title="Could not read the AI settings"
          message={q.error.message}
          action={<Button onClick={() => void q.refetch()}>Retry</Button>}
        />
      ) : (
        <Loading what="Reading AI settings" />
      )}
    </section>
  );
}

function CliStatus(): React.JSX.Element {
  const q = useAiStatus();
  if (q.isPending) return <Loading what="Checking the Claude CLI" />;
  if (q.isError)
    return (
      <ErrorState
        title="Could not check the Claude CLI"
        message={q.error.message}
        action={<Button onClick={() => void q.refetch()}>Retry</Button>}
      />
    );
  const { installed, version, loggedIn, error } = q.data;
  return (
    <div className={s.stack}>
      <p className={s.statusRow}>
        <span className={s.statusKey}>Claude CLI</span>
        {installed ? (
          <StatusDot tone="ok">
            Installed{version ? <span className={s.mono}> {version}</span> : null}
          </StatusDot>
        ) : (
          <StatusDot tone="bad">Not found</StatusDot>
        )}
      </p>
      {installed && (
        <p className={s.statusRow}>
          <span className={s.statusKey}>Login</span>
          {loggedIn === true ? (
            <StatusDot tone="ok">Logged in</StatusDot>
          ) : loggedIn === false ? (
            <StatusDot tone="bad">Not logged in</StatusDot>
          ) : (
            <StatusDot tone="warn">Unknown</StatusDot>
          )}
        </p>
      )}
      {!installed && (
        <p className={s.quiet}>
          Install Claude Code, then run <code className={s.code}>claude</code> in a terminal and log in.
        </p>
      )}
      {installed && loggedIn === false && (
        <p className={s.quiet}>
          Run <code className={s.code}>claude</code> in a terminal and log in.
        </p>
      )}
      {error && <p className={s.quiet}>{error}</p>}
    </div>
  );
}

function AiForm({ saved }: { saved: AiSettings }): React.JSX.Element {
  const { toast } = useToast();
  const setM = useSetAi();
  const [f, setF] = useState<Form>(() => toForm(saved));
  const next = build(f);
  const dirty = next === null || !sameSettings(next, saved);
  const defError = parseSeconds(f.def) === null ? SECONDS_RANGE : undefined;
  const genError = parseSeconds(f.gen) === null ? SECONDS_RANGE : undefined;

  const setRow = (t: AiTask, patch: Partial<Form['models'][AiTask]>, custom?: boolean): void =>
    setF((cur) => ({
      ...cur,
      models: { ...cur.models, [t]: { ...cur.models[t], ...patch } },
      custom: custom === undefined ? cur.custom : { ...cur.custom, [t]: custom },
    }));

  const save = (): void => {
    if (!next || !dirty) return;
    setM.mutate(next, {
      onSuccess: () => toast({ title: 'AI settings saved', tone: 'ok' }),
      onError: (e) => toast({ title: 'Could not save', description: e.message, tone: 'bad' }),
    });
  };

  return (
    <div className={s.stack}>
      <table className={s.tasks}>
        <caption className="sr-only">Model and effort per task</caption>
        <thead>
          <tr>
            <th scope="col">Task</th>
            <th scope="col">Model</th>
            <th scope="col">Effort</th>
          </tr>
        </thead>
        <tbody>
          {AI_TASKS.map((t) => (
            <TaskRow
              key={t}
              task={t}
              row={f.models[t]}
              custom={f.custom[t]}
              onModelChoice={(v) => (v === CUSTOM ? setRow(t, {}, true) : setRow(t, { model: v }, false))}
              onModelText={(text) => setRow(t, { model: text })}
              onEffort={(e) => setRow(t, { effort: e })}
            />
          ))}
        </tbody>
      </table>
      <div className={s.fields}>
        <Field label="Concurrency" hint="Claude processes at the same time.">
          {(p) => (
            <Select
              {...p}
              options={CONCURRENCY_OPTIONS}
              value={String(f.concurrency)}
              onValueChange={(v) => setF({ ...f, concurrency: Number(v) })}
            />
          )}
        </Field>
        <Field label="Timeout, most tasks (seconds)" error={defError}>
          {(p) => (
            <Input
              {...p}
              inputMode="numeric"
              value={f.def}
              onChange={(e) => setF({ ...f, def: e.target.value })}
            />
          )}
        </Field>
        <Field label="Timeout, drafting and import (seconds)" error={genError}>
          {(p) => (
            <Input
              {...p}
              inputMode="numeric"
              value={f.gen}
              onChange={(e) => setF({ ...f, gen: e.target.value })}
            />
          )}
        </Field>
      </div>
      <div className={s.buttons}>
        <Button variant="primary" disabled={!dirty || next === null} busy={setM.isPending} onClick={save}>
          Save
        </Button>
        {dirty && (
          <Button variant="ghost" onClick={() => setF(toForm(saved))}>
            Discard
          </Button>
        )}
        <Button variant="ghost" onClick={() => setF(toForm(DEFAULT_AI_SETTINGS))}>
          Reset to defaults
        </Button>
      </div>
    </div>
  );
}

function TaskRow({
  task,
  row,
  custom,
  onModelChoice,
  onModelText,
  onEffort,
}: {
  task: AiTask;
  row: { model: string; effort: Effort };
  custom: boolean;
  onModelChoice: (v: string) => void;
  onModelText: (text: string) => void;
  onEffort: (e: Effort) => void;
}): React.JSX.Element {
  const id = useId();
  const err = custom ? modelError(row.model) : null;
  return (
    <tr>
      <th scope="row" className={s.taskName}>
        {task}
      </th>
      <td>
        <label htmlFor={`${id}-m`} className="sr-only">
          Model for {task}
        </label>
        <Select
          id={`${id}-m`}
          size="sm"
          options={MODEL_OPTIONS}
          value={custom ? CUSTOM : row.model}
          onValueChange={onModelChoice}
        />
        {custom && (
          <div className={s.custom}>
            <label htmlFor={`${id}-c`} className="sr-only">
              Custom model id for {task}
            </label>
            <Input
              id={`${id}-c`}
              size="sm"
              value={row.model}
              aria-invalid={err ? true : undefined}
              aria-describedby={err ? `${id}-e` : undefined}
              onChange={(e) => onModelText(e.target.value)}
            />
            {err && (
              <p id={`${id}-e`} className={s.error}>
                {err}
              </p>
            )}
          </div>
        )}
      </td>
      <td>
        <label htmlFor={`${id}-e2`} className="sr-only">
          Effort for {task}
        </label>
        <Select
          id={`${id}-e2`}
          size="sm"
          options={EFFORT_OPTIONS}
          value={row.effort}
          onValueChange={(v) => onEffort(v as Effort)}
        />
      </td>
    </tr>
  );
}
