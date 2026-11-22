import { useState } from 'react';
import type { DiscoverySettings } from '@shared/discovery/schemas';
import { Button, ErrorState, Field, Input, Loading, SectionHeader, Switch, useToast } from '../../ui';
import {
  useDiscoverySettings,
  useSetDiscoverySettings,
  useSetSourceEnabled,
  useSources,
} from '../../lib/discovery';
import { buildDiscovery, sameDiscovery, toDiscoveryForm, type DiscoveryForm } from './discoveryHelpers';
import s from './settings.module.css';

export function DiscoverySection(): React.JSX.Element {
  const q = useDiscoverySettings();
  return (
    <section id="settings-discovery" className={s.section} aria-label="Discovery">
      <SectionHeader title="Discovery" level={3} />
      <WebSearch />
      {q.data ? (
        <DiscoveryFields key={JSON.stringify(q.data)} saved={q.data} />
      ) : q.isError ? (
        <ErrorState
          title="Could not read the discovery settings"
          message={q.error.message}
          action={<Button onClick={() => void q.refetch()}>Retry</Button>}
        />
      ) : (
        <Loading what="Reading discovery settings" />
      )}
    </section>
  );
}

function WebSearch(): React.JSX.Element {
  const sources = useSources();
  const toggle = useSetSourceEnabled();
  const { toast } = useToast();
  const web = sources.data?.find((x) => x.id === 'websearch');
  if (!web) return <></>;
  return (
    <div className={s.stack}>
      <Switch
        label="Web search agent"
        checked={web.enabled}
        onCheckedChange={(enabled) =>
          toggle.mutate(
            { id: 'websearch', enabled },
            {
              onError: (e) =>
                toast({ title: 'Could not change the source', description: e.message, tone: 'bad' }),
            },
          )
        }
      />
      <p className={s.quiet}>
        Claude searches the open web for public postings, once a day per search profile, at most 20 results.
        It spends Claude usage on every scan, so it is off by default.
      </p>
    </div>
  );
}

const WEIGHTS: { key: keyof DiscoveryForm; label: string }[] = [
  { key: 'fit', label: 'Fit' },
  { key: 'recency', label: 'Recency' },
  { key: 'source', label: 'Source quality' },
  { key: 'salary', label: 'Salary' },
];

function DiscoveryFields({ saved }: { saved: DiscoverySettings }): React.JSX.Element {
  const set = useSetDiscoverySettings();
  const { toast } = useToast();
  const [f, setF] = useState<DiscoveryForm>(toDiscoveryForm(saved));
  const next = buildDiscovery(f, saved);
  const dirty = next !== null && !sameDiscovery(next, saved);
  const field = (key: keyof DiscoveryForm, label: string, hint?: string, step?: string) => (
    <Field label={label} hint={hint}>
      {(p) => (
        <Input
          {...p}
          type="number"
          inputMode="decimal"
          step={step}
          value={f[key]}
          onChange={(e) => setF((x) => ({ ...x, [key]: e.target.value }))}
        />
      )}
    </Field>
  );
  return (
    <div className={s.stack}>
      <div className={s.fields}>
        {field(
          'threshold',
          'Analysis threshold',
          'A job at or above this triage score (0 to 100) gets the full analysis.',
        )}
        {field('perDay', 'Analyses per day', 'At most this many full analyses a day (0 to 100).')}
      </div>
      <h4 className={s.subTitle}>Ranking weights</h4>
      <div className={s.fields}>{WEIGHTS.map((w) => field(w.key, w.label, undefined, '0.05'))}</div>
      <p className={s.quiet}>
        Each weight is from 0 to 1. They are relative: the inbox sorts by the weighted mix.
      </p>
      {next === null && (
        <p className={s.error} role="alert">
          A value is out of range.
        </p>
      )}
      <div className={s.buttons}>
        <Button
          busy={set.isPending}
          disabled={!dirty}
          onClick={() =>
            next &&
            set.mutate(next, {
              onSuccess: () => toast({ title: 'Discovery settings saved', tone: 'ok' }),
              onError: (e) => toast({ title: 'Could not save', description: e.message, tone: 'bad' }),
            })
          }
        >
          Save discovery settings
        </Button>
        {dirty && (
          <Button variant="ghost" onClick={() => setF(toDiscoveryForm(saved))}>
            Discard changes
          </Button>
        )}
      </div>
    </div>
  );
}
