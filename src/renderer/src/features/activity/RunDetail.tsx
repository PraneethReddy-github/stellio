import {
  CodeEditor,
  ErrorState,
  KeyValue,
  Loading,
  SectionHeader,
  StatusDot,
  type KeyValueItem,
} from '../../ui';
import { useRun, type AiRun } from '../../lib/activity';
import { RUN_LABEL, RUN_TONE, formatDuration, formatTime } from './helpers';
import s from './activity.module.css';

const CODE_HEIGHT = 200;

export function RunDetail({ run }: { run: AiRun }): React.JSX.Element {
  const q = useRun(run.id, run.status);
  const tokens = run.tokens;
  const meta: KeyValueItem[] = [
    { key: 'Status', value: <StatusDot tone={RUN_TONE[run.status]}>{RUN_LABEL[run.status]}</StatusDot> },
    { key: 'Run', value: run.id, mono: true },
    { key: 'Task', value: run.task, mono: true },
    { key: 'Model', value: run.model, mono: true },
    { key: 'Prompt', value: run.promptVersion, mono: true },
    { key: 'Started', value: formatTime(run.startedAt), mono: true },
    { key: 'Duration', value: formatDuration(run.durationMs), mono: true },
    { key: 'Exit code', value: run.exitCode === null ? '—' : String(run.exitCode), mono: true },
    ...(tokens
      ? [
          {
            key: 'Tokens',
            value: `${String(tokens.input ?? '—')} in · ${String(tokens.output ?? '—')} out`,
            mono: true,
          },
        ]
      : []),
    ...(run.relatedType && run.relatedId
      ? [{ key: 'Related', value: `${run.relatedType} ${run.relatedId}`, mono: true }]
      : []),
  ];
  const log = q.data?.log;

  return (
    <div className={s.detail}>
      <KeyValue items={meta} />
      {run.error && <ErrorState title="Run failed" message={run.error} />}
      {run.status === 'running' ? (
        <p className={s.note}>Running — prompt and output are saved when it finishes.</p>
      ) : q.isPending ? (
        <Loading what="Reading the saved prompt and output" />
      ) : q.isError ? (
        <ErrorState title="Could not read this run" message={q.error.message} />
      ) : !log ? (
        <p className={s.note}>The saved prompt and output are gone: logs are pruned after 30 days.</p>
      ) : (
        <>
          <Block title="System prompt" value={log.system} />
          <Block title="Input" value={log.input} />
          {log.attempts.map((a, i) => (
            <div key={i} className={s.attempt}>
              <Block
                title={log.attempts.length > 1 ? `Output, attempt ${String(i + 1)}` : 'Output'}
                value={a.stdout}
              />
              {a.stderr.trim() !== '' && <Block title="Errors (stderr)" value={a.stderr} />}
            </div>
          ))}
        </>
      )}
    </div>
  );
}

function Block({ title, value }: { title: string; value: string }): React.JSX.Element {
  return (
    <section className={s.block}>
      <SectionHeader title={title} level={3} />
      <CodeEditor language="markdown" readOnly ariaLabel={title} value={value} height={CODE_HEIGHT} />
    </section>
  );
}
