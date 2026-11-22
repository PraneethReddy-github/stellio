import { useState } from 'react';
import {
  Button,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Loading,
  SectionHeader,
  Tag,
  useToast,
} from '../../ui';
import { useWatchAdd, useWatchRemove, useWatchlist } from '../../lib/discovery';
import { ATS_LABEL, isCareersUrl } from './discoveryHelpers';
import s from './settings.module.css';

export function WatchlistSection(): React.JSX.Element {
  const q = useWatchlist();
  const add = useWatchAdd();
  const remove = useWatchRemove();
  const { toast } = useToast();
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = (): void => {
    if (!isCareersUrl(url)) return setError('Enter the careers page address, starting with https://.');
    setError(null);
    add.mutate(
      { url: url.trim(), ...(name.trim() ? { name: name.trim() } : {}) },
      {
        onSuccess: (entry) => {
          setUrl('');
          setName('');
          toast({
            title: 'Added to the watchlist',
            description: `${entry.company} · ${entry.atsType ? (ATS_LABEL[entry.atsType] ?? entry.atsType) : 'no board found'}`,
            tone: 'ok',
          });
        },
        onError: (e) => setError(e.message),
      },
    );
  };

  return (
    <section id="settings-watchlist" className={s.section} aria-label="Watchlist">
      <SectionHeader title="Watchlist" level={3} />
      <p className={s.quiet}>
        Add a company by its careers page. Stellio finds the job board behind it (Greenhouse, Lever, Ashby,
        SmartRecruiters or Workable) and checks it on every scan.
      </p>
      <form
        className={s.addRow}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field label="Careers page URL" error={error ?? undefined}>
          {(p) => (
            <Input
              {...p}
              value={url}
              placeholder="https://boards.greenhouse.io/acme"
              onChange={(e) => setUrl(e.target.value)}
            />
          )}
        </Field>
        <Field label="Company name (optional)">
          {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} />}
        </Field>
        <Button type="submit" busy={add.isPending}>
          {add.isPending ? 'Checking the board…' : 'Add company'}
        </Button>
      </form>
      {q.isPending ? (
        <Loading what="Reading the watchlist" />
      ) : q.isError ? (
        <ErrorState
          title="Could not read the watchlist"
          message={q.error.message}
          action={<Button onClick={() => void q.refetch()}>Retry</Button>}
        />
      ) : q.data.length === 0 ? (
        <EmptyState title="No companies watched">
          Boards of companies you care about give the freshest postings, with a direct apply link.
        </EmptyState>
      ) : (
        <table className={s.rows} aria-label="Watched companies">
          <thead>
            <tr>
              <th scope="col">Company</th>
              <th scope="col">Board</th>
              <th scope="col">Careers page</th>
              <th scope="col">
                <span className={s.srOnly}>Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {q.data.map((w) => (
              <tr key={w.id}>
                <td>{w.company}</td>
                <td>
                  {w.atsType ? (
                    <Tag>
                      {ATS_LABEL[w.atsType] ?? w.atsType}
                      {w.atsSlug ? ` · ${w.atsSlug}` : ''}
                    </Tag>
                  ) : (
                    '—'
                  )}
                </td>
                <td className={`${s.mono} ${s.wide}`}>{w.careersUrl ?? '—'}</td>
                <td className={s.end}>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Remove ${w.company}`}
                    onClick={() =>
                      remove.mutate(w.id, {
                        onError: (e) =>
                          toast({ title: 'Could not remove', description: e.message, tone: 'bad' }),
                      })
                    }
                  >
                    Remove
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
