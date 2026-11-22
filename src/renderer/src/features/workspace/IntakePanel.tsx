import { useNavigate } from '@tanstack/react-router';
import { CANCELLED_MESSAGE } from '@shared/messages';
import { useEffect, useRef, useState } from 'react';
import {
  Button,
  ErrorState,
  Field,
  Input,
  Loading,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  useToast,
} from '../../ui';
import { useElapsedSeconds } from '../../lib/hooks';
import { cancelTask, useIntake } from '../../lib/jobs';
import { freshIntent, useIntakeIntent } from './intent';
import { jobPath } from './helpers';
import s from './workspace.module.css';

type Mode = 'link' | 'text';

/** Paste a link or the job text. Both paths end on the job page. */
export function IntakePanel(): React.JSX.Element {
  const navigate = useNavigate();
  const { toast } = useToast();
  const intake = useIntake();
  const [mode, setMode] = useState<Mode>(() => freshIntent() ?? 'link');
  const [url, setUrl] = useState('');
  const [text, setText] = useState('');
  const [textUrl, setTextUrl] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);
  const urlRef = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const secs = useElapsedSeconds(intake.isPending);
  const pending = intake.isPending;
  // The label follows the run in flight, whatever the tabs show meanwhile.
  const [runMode, setRunMode] = useState<Mode>('link');
  const pendingRef = useRef(false);
  useEffect(() => {
    pendingRef.current = pending;
  });

  // Opened by a palette command from another page: the request came just before this mounted.
  useEffect(() => {
    if (freshIntent() !== null)
      setTimeout(() => (freshIntent() === 'link' ? urlRef : textRef).current?.focus(), 0);
  }, []);

  // A palette command picks the mode and puts the cursor there.
  useEffect(
    () =>
      useIntakeIntent.subscribe((st) => {
        if (pendingRef.current) return; // the form is locked while a run is in flight
        setMode(st.mode);
        setTimeout(() => (st.mode === 'link' ? urlRef : textRef).current?.focus(), 0);
      }),
    [],
  );

  const run = (input: Parameters<typeof intake.mutate>[0]): void => {
    setError(null);
    setNotice(null);
    setRequestId(input.requestId);
    setRunMode(input.kind === 'url' ? 'link' : 'text');
    intake.mutate(input, {
      onSuccess: (r) => {
        if (r.status === 'needs_text') {
          setMode('text');
          setTextUrl(input.kind === 'url' ? input.url : '');
          setNotice(r.reason);
          setTimeout(() => textRef.current?.focus(), 0);
          return;
        }
        if (r.duplicate) toast({ title: 'Already in your jobs' });
        void navigate({ to: jobPath(r.jobId) });
      },
      onError: (e) => {
        if (e.message === CANCELLED_MESSAGE) toast({ title: 'Cancelled' });
        else setError(e.message);
      },
    });
  };

  const fetchUrl = (): void => {
    const u = url.trim();
    if (u !== '') run({ kind: 'url', url: u, requestId: crypto.randomUUID() });
  };
  const readText = (): void => {
    const t = text.trim();
    if (t !== '')
      run({ kind: 'text', text: t, url: textUrl.trim() || undefined, requestId: crypto.randomUUID() });
  };

  return (
    <section className={s.intake} aria-label="Add a job">
      <Tabs value={mode} onValueChange={(v) => setMode(v as Mode)}>
        <TabsList>
          <TabsTrigger value="link" disabled={pending}>
            Job link
          </TabsTrigger>
          <TabsTrigger value="text" disabled={pending}>
            Paste text
          </TabsTrigger>
        </TabsList>
        <TabsContent value="link">
          <form
            className={s.form}
            onSubmit={(e) => {
              e.preventDefault();
              fetchUrl();
            }}
          >
            <Field label="Posting URL" hint="Stellio fetches the page and reads it into a structured job.">
              {(p) => (
                <Input
                  {...p}
                  ref={urlRef}
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://company.example/jobs/data-engineer"
                  inputMode="url"
                  disabled={pending}
                  autoFocus
                />
              )}
            </Field>
            <div className={s.row}>
              <Button type="submit" variant="primary" busy={pending} disabled={url.trim() === ''}>
                {pending ? 'Fetching…' : 'Fetch job'}
              </Button>
            </div>
          </form>
        </TabsContent>
        <TabsContent value="text">
          <form
            className={s.form}
            onSubmit={(e) => {
              e.preventDefault();
              readText();
            }}
          >
            {notice && (
              <p className={s.notice} role="status">
                {notice} Paste the job description instead.
              </p>
            )}
            <Field label="Job description">
              {(p) => (
                <Textarea
                  {...p}
                  ref={textRef}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  rows={10}
                  placeholder="Paste the full posting text here."
                  disabled={pending}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                      e.preventDefault();
                      readText();
                    }
                  }}
                />
              )}
            </Field>
            <Field label="Posting URL (optional)" hint="Kept as the link back to the original posting.">
              {(p) => (
                <Input
                  {...p}
                  value={textUrl}
                  onChange={(e) => setTextUrl(e.target.value)}
                  inputMode="url"
                  disabled={pending}
                />
              )}
            </Field>
            <div className={s.row}>
              <Button type="submit" variant="primary" busy={pending} disabled={text.trim() === ''}>
                {pending ? 'Reading…' : 'Read job'}
              </Button>
            </div>
          </form>
        </TabsContent>
      </Tabs>

      {pending && (
        <div className={s.running}>
          <Loading
            what={
              runMode === 'link'
                ? `Fetching the posting · ${String(secs)} s`
                : `Reading the job description with Claude · ${String(secs)} s`
            }
          />
          <Button size="sm" onClick={() => requestId && void cancelTask(requestId)}>
            Cancel
          </Button>
        </div>
      )}
      {error && (
        <ErrorState
          title="Could not add the job"
          message={error}
          action={<Button onClick={mode === 'link' ? fetchUrl : readText}>Try again</Button>}
        />
      )}
    </section>
  );
}
