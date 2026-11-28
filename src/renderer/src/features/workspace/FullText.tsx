import { useState } from 'react';
import { looksCutOff } from '@shared/jobs/text';
import { Button, Dialog, Field, Textarea, useToast } from '../../ui';
import { useFullText } from '../../lib/jobs';
import { isWebUrl } from './helpers';
import s from './workspace.module.css';

interface Props {
  job: { id: string; descriptionMd: string; url: string | null };
  /** `note`: only when the text looks cut off. `button`: always, as one quiet "Replace text" action. */
  mode: 'note' | 'button';
}

/** Fetch or paste the full posting text when the source sent only part of it. */
export function FullText({ job, mode }: Props): React.JSX.Element | null {
  const full = useFullText(job.id);
  const { toast } = useToast();
  const [pasting, setPasting] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const cut = looksCutOff(job.descriptionMd);
  if (mode === 'note' && !cut) return null;

  const done = (rescored: boolean): void => {
    toast({
      title: 'Full text saved',
      description: rescored ? 'The job was scored again on the full text.' : 'The posting text was replaced.',
      tone: 'ok',
    });
  };
  const fetchIt = (): void =>
    full.mutate(
      { kind: 'fetch' },
      {
        onSuccess: (r) => {
          if (r.status === 'replaced') done(r.rescored);
          else toast({ title: 'No full text found', description: r.reason ?? undefined, tone: 'warn' });
        },
        onError: (e) => toast({ title: 'Could not fetch the posting', description: e.message, tone: 'bad' }),
      },
    );
  const save = (): void => {
    setError(null);
    full.mutate(
      { kind: 'paste', text },
      {
        onSuccess: (r) => {
          setPasting(false);
          setText('');
          done(r.rescored);
        },
        onError: (e) => setError(e.message),
      },
    );
  };
  const busyFetch = full.isPending && full.variables.kind === 'fetch';

  return (
    <>
      {mode === 'note' ? (
        <div className={s.banner} role="status">
          <p>The source sent only part of this posting. Scores only see this text.</p>
          <span className={s.bannerActions}>
            {isWebUrl(job.url) && (
              <Button size="sm" busy={busyFetch} disabled={full.isPending} onClick={fetchIt}>
                Fetch full text
              </Button>
            )}
            <Button size="sm" disabled={full.isPending} onClick={() => setPasting(true)}>
              Paste full text
            </Button>
          </span>
        </div>
      ) : (
        <Button size="sm" variant="ghost" disabled={full.isPending} onClick={() => setPasting(true)}>
          Replace text
        </Button>
      )}
      <Dialog
        open={pasting}
        onOpenChange={(open) => {
          if (!open && !full.isPending) setPasting(false);
        }}
        title="Paste full text"
        description="Copy the whole posting from its page and paste it here. It replaces the saved text, and the job is read and scored again."
        size="lg"
        footer={
          <>
            <Button disabled={full.isPending} onClick={() => setPasting(false)}>
              Cancel
            </Button>
            <Button variant="primary" busy={full.isPending} disabled={text.trim() === ''} onClick={save}>
              Save text
            </Button>
          </>
        }
      >
        <Field label="Posting text" error={error ?? undefined}>
          {(p) => <Textarea {...p} rows={14} value={text} onChange={(e) => setText(e.target.value)} />}
        </Field>
      </Dialog>
    </>
  );
}
