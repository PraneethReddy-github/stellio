import { useMemo, useState } from 'react';
import { SKILL_CATEGORIES } from '@shared/profile';
import { Button, Checkbox, Dialog, DiffView, Field, Input, Select } from '../../ui';
import { useSaveProfile } from '../../lib/profile';
import { formatList } from '../profile/helpers';
import { addPreview, addSkillForm, evidenceOptions, profileModel } from './helpers';
import s from './skills.module.css';

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * "I have this, just never listed it": level, years, last used and evidence, with the profile diff for the form
 * as filled in. Nothing is written until Save. `before` and `expectedHash` come from the preview (or the live
 * profile), so a concurrent edit is caught by the save. Mount it only while open.
 */
export function AddSkillDialog({
  skill,
  before,
  expectedHash,
  onSaved,
  regenerate,
  onClose,
}: {
  skill: string;
  before: string;
  expectedHash: string;
  /** Runs after the profile is saved (e.g. recording the approval for a job). A failure is shown, not fatal. */
  onSaved?: () => Promise<unknown>;
  /** Offered once the skill is in the profile. */
  regenerate?: () => void;
  onClose: () => void;
}): React.JSX.Element {
  const save = useSaveProfile();
  const [form, setForm] = useState(() => addSkillForm(skill));
  const [shown, setShown] = useState(false);
  const [phase, setPhase] = useState<'form' | 'saved'>('form');
  const [failure, setFailure] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const options = useMemo(() => evidenceOptions(profileModel(before)), [before]);
  const preview = useMemo(() => addPreview(before, form), [before, form]);
  const evidence = form.evidence ? form.evidence.split(',').map((x) => x.trim()) : [];
  const set = (k: keyof typeof form) => (v: string) => setForm((f) => ({ ...f, [k]: v }));
  const field = (k: keyof typeof form) => ({
    value: form[k],
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => set(k)(e.target.value),
  });
  const err = (k: keyof typeof form): string | undefined =>
    shown && preview.error?.field === k ? preview.error.message : undefined;

  const submit = (e: React.SyntheticEvent): void => {
    e.preventDefault();
    setShown(true);
    if (preview.after === null || save.isPending) return;
    setFailure(null);
    save.mutate(
      { markdown: preview.after, expectedHash, message: `profile: add skill ${skill}` },
      {
        onSuccess: () => {
          setPhase('saved');
          void onSaved?.().catch((e: unknown) => setWarning(errText(e)));
        },
        onError: (e) => setFailure(errText(e)),
      },
    );
  };

  if (phase === 'saved')
    return (
      <Dialog
        open
        onOpenChange={(o) => !o && onClose()}
        title={`${skill} is in your profile`}
        footer={
          <>
            <Button onClick={onClose}>Close</Button>
            {regenerate && (
              <Button
                variant="primary"
                onClick={() => {
                  onClose();
                  regenerate();
                }}
              >
                Regenerate with {skill}
              </Button>
            )}
          </>
        }
      >
        <p>The profile was saved and committed.</p>
        {warning && <p className={s.warn}>Could not record the approval for this job: {warning}</p>}
      </Dialog>
    );

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="lg"
      title={`Add ${skill} to your profile`}
      description="The profile is the only source Stellio writes from. Check the change before you save."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="add-skill-form" busy={save.isPending}>
            Save to profile
          </Button>
        </>
      }
    >
      <form id="add-skill-form" className={s.form} onSubmit={submit} noValidate>
        <Field
          label="Level"
          hint="Required. 1 aware, 2 basic, 3 working, 4 strong, 5 expert."
          error={err('level')}
        >
          {(a) => <Input {...a} {...field('level')} inputMode="numeric" autoFocus />}
        </Field>
        <Field label="Category">
          {(a) => (
            <Select
              {...a}
              options={SKILL_CATEGORIES.map((v) => ({ value: v, label: v }))}
              value={form.category}
              onValueChange={set('category')}
            />
          )}
        </Field>
        <Field label="Years" error={err('years')}>
          {(a) => <Input {...a} {...field('years')} inputMode="decimal" />}
        </Field>
        <Field label="Last used" hint='A year, or "now".' error={err('last_used')}>
          {(a) => <Input {...a} {...field('last_used')} />}
        </Field>
        <fieldset className={s.evidence}>
          <legend className={s.micro}>Evidence</legend>
          {options.length === 0 ? (
            <p className={s.muted}>No experience or project ids in the profile yet.</p>
          ) : (
            options.map((o) => (
              <Checkbox
                key={o.id}
                label={
                  <span>
                    {o.title} <span className={s.mono}>{o.id}</span>
                  </span>
                }
                checked={evidence.includes(o.id)}
                onCheckedChange={(on) =>
                  set('evidence')(
                    formatList(on === true ? [...evidence, o.id] : evidence.filter((x) => x !== o.id)),
                  )
                }
              />
            ))
          )}
        </fieldset>
      </form>
      <h3 className={s.micro}>Profile change</h3>
      {preview.after === null ? (
        <p className={s.muted}>Fill in the level to see the change.</p>
      ) : (
        <div className={s.diff} tabIndex={0} role="region" aria-label="Profile diff">
          <DiffView diff={preview.hunks} ariaLabel="Profile change" leftLabel="Before" rightLabel="After" />
        </div>
      )}
      {failure && (
        <p className={s.warn} role="alert">
          Could not save: {failure}
        </p>
      )}
    </Dialog>
  );
}
