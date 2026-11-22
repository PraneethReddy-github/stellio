import { useState } from 'react';
import type { SourceStatus } from '@shared/discovery/schemas';
import {
  Button,
  Dialog,
  ErrorState,
  Field,
  Input,
  Loading,
  SectionHeader,
  StatusDot,
  Switch,
  useToast,
} from '../../ui';
import {
  useClearApiKey,
  useLastRun,
  useSetApiKey,
  useSetSourceEnabled,
  useSources,
} from '../../lib/discovery';
import { formatWhen } from '../applications/helpers';
import s from './settings.module.css';

export function SourcesSection(): React.JSX.Element {
  const q = useSources();
  const run = useLastRun();
  const toggle = useSetSourceEnabled();
  const clear = useClearApiKey();
  const { toast } = useToast();
  const [keyOpen, setKeyOpen] = useState(false);
  // The web search agent has its own switch under Discovery, next to its usage note.
  const rows = q.data?.filter((x) => x.id !== 'websearch') ?? [];

  return (
    <section id="settings-sources" className={s.section} aria-label="Sources">
      <SectionHeader title="Sources" level={3} />
      {q.isPending ? (
        <Loading what="Reading sources" />
      ) : q.isError ? (
        <ErrorState
          title="Could not read the sources"
          message={q.error.message}
          action={<Button onClick={() => void q.refetch()}>Retry</Button>}
        />
      ) : (
        <>
          <table className={s.rows} aria-label="Job sources">
            <thead>
              <tr>
                <th scope="col">Source</th>
                <th scope="col">Last success</th>
                <th scope="col">Last scan</th>
                <th scope="col">Last error</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((x) => (
                <SourceRow
                  key={x.id}
                  source={x}
                  counts={run.data?.perSource[x.id]}
                  onToggle={(enabled) =>
                    toggle.mutate(
                      { id: x.id, enabled },
                      {
                        onError: (e) =>
                          toast({
                            title: 'Could not change the source',
                            description: e.message,
                            tone: 'bad',
                          }),
                      },
                    )
                  }
                  keyAction={
                    x.needsKey ? (
                      x.keySet ? (
                        <>
                          <StatusDot tone="ok">Key saved</StatusDot>
                          <Button
                            size="sm"
                            variant="ghost"
                            busy={clear.isPending}
                            aria-label="Clear the Adzuna key"
                            onClick={() =>
                              clear.mutate(undefined, {
                                onSuccess: () => toast({ title: 'Adzuna key cleared', tone: 'neutral' }),
                                onError: (e) =>
                                  toast({
                                    title: 'Could not clear the key',
                                    description: e.message,
                                    tone: 'bad',
                                  }),
                              })
                            }
                          >
                            Clear
                          </Button>
                        </>
                      ) : (
                        <Button size="sm" onClick={() => setKeyOpen(true)}>
                          Set API key
                        </Button>
                      )
                    ) : null
                  }
                />
              ))}
            </tbody>
          </table>
          <p className={s.quiet}>
            Adzuna needs a free app id and key from{' '}
            <a
              href="https://developer.adzuna.com"
              target="_blank"
              rel="noreferrer noopener"
              className={s.link}
            >
              developer.adzuna.com
            </a>
            . Stellio stores them encrypted with your system keyring and never shows them again. The other
            sources need no key.
          </p>
        </>
      )}
      {keyOpen && <KeyDialog onClose={() => setKeyOpen(false)} />}
    </section>
  );
}

function SourceRow({
  source: x,
  counts,
  onToggle,
  keyAction,
}: {
  source: SourceStatus;
  counts: { fetched: number; new: number; errors: string[] } | undefined;
  onToggle: (enabled: boolean) => void;
  keyAction: React.ReactNode;
}): React.JSX.Element {
  const blocked = x.needsKey && !x.keySet;
  return (
    <tr>
      <td>
        <div className={s.sourceName}>
          <Switch label={x.label} checked={x.enabled} onCheckedChange={onToggle} />
          {keyAction}
        </div>
        {blocked && x.enabled && <p className={s.quiet}>Skipped until a key is saved.</p>}
      </td>
      <td className={s.mono}>{x.lastSuccessAt ? formatWhen(x.lastSuccessAt) : '—'}</td>
      <td className={s.mono}>
        {counts ? `${String(counts.fetched)} fetched · ${String(counts.new)} new` : '—'}
      </td>
      <td className={s.wide}>{x.lastError ? <span className={s.errorText}>{x.lastError}</span> : '—'}</td>
    </tr>
  );
}

function KeyDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const save = useSetApiKey();
  const { toast } = useToast();
  const [appId, setAppId] = useState('');
  const [appKey, setAppKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const ready = appId.trim() !== '' && appKey.trim() !== '';
  const submit = (): void => {
    if (!ready) return;
    save.mutate(
      { appId: appId.trim(), appKey: appKey.trim() },
      {
        onSuccess: () => {
          toast({ title: 'Adzuna key saved', tone: 'ok' });
          onClose();
        },
        onError: (e) => setError(e.message),
      },
    );
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Adzuna API key"
      description="Get a free app id and key at developer.adzuna.com. They are stored encrypted and never shown again."
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={save.isPending} disabled={!ready} onClick={submit}>
            Save key
          </Button>
        </>
      }
    >
      <form
        className={s.stack}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field label="App id">
          {(p) => (
            <Input
              {...p}
              type="password"
              autoComplete="off"
              value={appId}
              onChange={(e) => setAppId(e.target.value)}
            />
          )}
        </Field>
        <Field label="App key">
          {(p) => (
            <Input
              {...p}
              type="password"
              autoComplete="off"
              value={appKey}
              onChange={(e) => setAppKey(e.target.value)}
            />
          )}
        </Field>
        {error && (
          <p className={s.error} role="alert">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
