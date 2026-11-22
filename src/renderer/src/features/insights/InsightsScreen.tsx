import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import type { InsightWindow } from '@shared/insights';
import { Page } from '../../app/Page';
import {
  Button,
  EmptyState,
  ErrorState,
  HBars,
  Loading,
  RadioGroup,
  SectionHeader,
  Stat,
  Textarea,
} from '../../ui';
import { useElapsedSeconds } from '../../lib/hooks';
import { useAskInsights, useInsights, type InsightsData } from '../../lib/insights';
import { route } from '../applications/helpers';
import { dimensionRows, ghostingText, medianText, pct, SUGGESTED_QUESTIONS, WINDOW_OPTIONS } from './helpers';
import s from './insights.module.css';

export default function InsightsScreen(): React.JSX.Element {
  const [window, setWindow] = useState<InsightWindow>('90d');
  const q = useInsights(window);
  return (
    <Page
      title="Insights"
      subtitle="Counted from the applications you sent. Claude only ever sees these tables."
      actions={
        <RadioGroup
          horizontal
          aria-label="Time window"
          value={window}
          onValueChange={(v) => setWindow(v as InsightWindow)}
          options={[...WINDOW_OPTIONS]}
        />
      }
    >
      {q.isPending ? (
        <Loading what="Counting your applications" />
      ) : q.isError ? (
        <ErrorState
          title="Could not read the insights"
          message={q.error.message}
          action={<Button onClick={() => void q.refetch()}>Try again</Button>}
        />
      ) : (
        <Body data={q.data} />
      )}
    </Page>
  );
}

function Body({ data }: { data: InsightsData }): React.JSX.Element {
  const none = data.totals.applications === 0;
  return (
    <div className={s.insights}>
      {none ? (
        <EmptyState
          title="No application sent in this window"
          action={
            <Link to={route('/applications')} className={s.link}>
              Open Applications
            </Link>
          }
        >
          Rates appear once you mark applications as applied. A segment needs {data.minSample} applications
          before it shows a rate.
        </EmptyState>
      ) : (
        <>
          <section aria-label="Totals" className={s.totals}>
            <Stat label="Applications" value={data.totals.applications} />
            <Stat label="Reply rate" value={pct(data.totals.responseRate)} />
            <Stat label="Interview rate" value={pct(data.totals.interviewRate)} />
            <Stat label="Median days to reply" value={medianText(data.timeToResponse)} />
            <Stat label="Ghosted" value={ghostingText(data.ghosting)} />
          </section>
          <p className={s.note}>
            A reply is any answer from the company, a rejection included. Ghosted = no answer within 30 days,
            among applications at least 30 days old
            {data.ghosting.insufficient ? ` (${String(data.ghosting.eligible)} so far)` : ''}. A segment with
            fewer than {data.minSample} applications shows no rate.
          </p>
        </>
      )}

      <Ask />

      {!none && (
        <section aria-label="Segments" className={s.tables}>
          {data.dimensions.map((d) => (
            <div key={d.key} className={s.table}>
              <HBars
                caption={d.title}
                countLabel="Sent"
                series={['Reply rate', 'Interview rate']}
                rows={dimensionRows(d)}
              />
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

function Ask(): React.JSX.Element {
  const [question, setQuestion] = useState('');
  const ask = useAskInsights();
  const secs = useElapsedSeconds(ask.isPending);
  const send = (text: string): void => {
    const t = text.trim();
    if (t.length >= 3 && !ask.isPending) ask.mutate(t);
  };
  return (
    <section aria-label="Ask" className={s.ask}>
      <SectionHeader title="Ask" />
      <p className={s.note}>
        Claude answers from the aggregated tables, your skill demand and your learning list, over all your
        applications. It never sees your documents. Every number in the answer is checked against the data.
      </p>
      <form
        className={s.form}
        onSubmit={(e) => {
          e.preventDefault();
          send(question);
        }}
      >
        <Textarea
          aria-label="Your question"
          rows={2}
          maxLength={500}
          placeholder="Which roles should I prioritize?"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              send(question);
            }
          }}
        />
        <div className={s.row}>
          <Button type="submit" variant="primary" busy={ask.isPending} disabled={question.trim().length < 3}>
            {ask.isPending ? 'Asking…' : 'Ask'}
          </Button>
          {ask.isPending && <Button onClick={() => void ask.cancel()}>Cancel</Button>}
          {SUGGESTED_QUESTIONS.map((x) => (
            <Button
              key={x}
              variant="ghost"
              size="sm"
              disabled={ask.isPending}
              onClick={() => {
                setQuestion(x);
                send(x);
              }}
            >
              {x}
            </Button>
          ))}
        </div>
      </form>
      {ask.isPending && <Loading what={`Reading the tables · ${String(secs)} s`} />}
      {ask.isError && (
        <ErrorState
          title="No answer"
          message={ask.error.message}
          action={<Button onClick={() => send(question)}>Try again</Button>}
        />
      )}
      {ask.data && (
        <div className={s.answer} aria-live="polite">
          {ask.data.warning && (
            <p className={s.warn} role="alert">
              {ask.data.warning}
            </p>
          )}
          <p className={s.answerText}>{ask.data.answer}</p>
          <h3 className={s.micro}>Numbers used</h3>
          {ask.data.numbersUsed.length === 0 ? (
            <p className={s.note}>The answer uses no numbers.</p>
          ) : (
            <dl className={s.numbers} aria-label="Numbers used">
              {ask.data.numbersUsed.map((n, i) => (
                <div key={`${n.label}-${String(i)}`} className={s.number}>
                  <dt>{n.label}</dt>
                  <dd>{n.value}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      )}
    </section>
  );
}
