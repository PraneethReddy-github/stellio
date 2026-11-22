import { useMemo, type RefObject } from 'react';
import type { ProfileSuggestionData } from '../../lib/profile';
import { Button, DiffView, Dialog, ErrorState, diffLines } from '../../ui';
import s from './profile.module.css';

/**
 * Review step for `profile.suggest`: what the edits rest on, each edit with its reason, and the file as a
 * Before / After diff. Nothing is written until "Save these changes".
 */
export function SuggestDialog({
  result,
  saving,
  error,
  returnFocus,
  onSave,
  onClose,
}: {
  result: ProfileSuggestionData;
  saving: boolean;
  error: string | null;
  returnFocus: RefObject<HTMLElement | null>;
  onSave: () => void;
  onClose: () => void;
}): React.JSX.Element {
  const diff = useMemo(() => diffLines(result.before, result.after), [result.before, result.after]);
  const unchanged = result.before === result.after;
  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      size="lg"
      returnFocus={returnFocus}
      title="Suggested profile updates"
      description="Your profile is kept in history. Setting the review date is part of every confirmed change."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={saving} disabled={unchanged} onClick={onSave}>
            {saving ? 'Saving…' : 'Save these changes'}
          </Button>
        </>
      }
    >
      <div className={s.reviewBody}>
        {error && <ErrorState title="Could not save the profile" message={error} />}
        <p>{result.summary || 'No explanation was given.'}</p>
        {result.items.length === 0 ? (
          <p className={s.suggestNote}>No skill edits are suggested.</p>
        ) : (
          <ul className={s.suggestList} aria-label="Suggested edits">
            {result.items.map((i) => (
              <li key={i.skill}>
                <strong>{i.skill}</strong> <span className={s.mono}>{i.change}</span>
                <span className={s.suggestNote}> {i.reason}</span>
              </li>
            ))}
          </ul>
        )}
        {result.dropped.length > 0 && (
          <p className={s.suggestNote}>
            Not applied: {result.dropped.map((d) => `${d.skill} (${d.why})`).join('; ')}.
          </p>
        )}
        <div className={s.reviewDiff} role="region" aria-label="Diff" tabIndex={0}>
          <DiffView
            diff={diff}
            leftLabel="Before"
            rightLabel="After"
            ariaLabel="Profile before and after the suggested updates"
          />
        </div>
      </div>
    </Dialog>
  );
}
