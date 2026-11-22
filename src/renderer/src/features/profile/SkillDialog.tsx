import { useEffect, useRef, useState } from 'react';
import { SKILL_CATEGORIES, SKILL_STATUSES, type SkillRow } from '@shared/profile';
import { Button, Dialog, Field, Input, Select } from '../../ui';
import { emptySkillForm, formToRow, rowToForm, type SkillForm, type SkillFormError } from './helpers';
import s from './profile.module.css';

const options = (list: readonly string[]): { value: string; label: string }[] =>
  list.map((v) => ({ value: v, label: v }));

/** Add (row === null) or edit one skill. Mount it only while open so the form starts fresh. */
export function SkillDialog({
  row,
  evidenceIds,
  onSubmit,
  onDelete,
  onClose,
}: {
  row: SkillRow | null;
  evidenceIds: string[];
  /** Returns a message for the Skill field when the row cannot be saved (e.g. the name is taken). */
  onSubmit: (row: SkillRow, previousName: string | null) => string | null;
  /** Omit where deleting needs the Profile screen's draft-and-save step. */
  onDelete?: (name: string) => void;
  onClose: () => void;
}): React.JSX.Element {
  const [form, setForm] = useState<SkillForm>(() => (row ? rowToForm(row) : emptySkillForm()));
  // A new object per failed submit, so the effect below re-focuses even when the message repeats.
  const [error, setError] = useState<SkillFormError | null>(null);
  const formEl = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (error) formEl.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [error]);
  const err = (k: keyof SkillForm): string | undefined => (error?.field === k ? error.message : undefined);
  const set = (k: keyof SkillForm) => (v: string) => setForm((f) => ({ ...f, [k]: v }));
  const input = (k: keyof SkillForm) => ({
    value: form[k],
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => set(k)(e.target.value),
  });

  const submit = (e: React.SyntheticEvent): void => {
    e.preventDefault();
    const res = formToRow(form);
    if ('error' in res) return setError(res.error);
    const message = onSubmit(res.row, row?.skill ?? null);
    if (message) setError({ field: 'skill', message });
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={row ? `Edit skill: ${row.skill}` : 'Add skill'}
      footer={
        <>
          {row && onDelete && (
            <Button variant="danger" className={s.footerSpacer} onClick={() => onDelete(row.skill)}>
              Delete
            </Button>
          )}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="skill-form">
            {row ? 'Update skill' : 'Add skill'}
          </Button>
        </>
      }
    >
      <form ref={formEl} id="skill-form" className={s.formGrid} onSubmit={submit} noValidate>
        <div className={s.wide}>
          <Field label="Skill" error={err('skill')}>
            {(a) => <Input {...a} {...input('skill')} autoFocus />}
          </Field>
        </div>
        <Field label="Category">
          {(a) => (
            <Select
              {...a}
              options={options(SKILL_CATEGORIES)}
              value={form.category}
              onValueChange={set('category')}
            />
          )}
        </Field>
        <Field label="Status">
          {(a) => (
            <Select
              {...a}
              options={options(SKILL_STATUSES)}
              value={form.status}
              onValueChange={set('status')}
            />
          )}
        </Field>
        <Field
          label="Level"
          hint="Required. 1 aware, 2 basic, 3 working, 4 strong, 5 expert."
          error={err('level')}
        >
          {(a) => <Input {...a} {...input('level')} inputMode="numeric" />}
        </Field>
        <Field label="Years" error={err('years')}>
          {(a) => <Input {...a} {...input('years')} inputMode="decimal" />}
        </Field>
        <Field label="Last used" hint='Optional. A year, or "now".' error={err('last_used')}>
          {(a) => <Input {...a} {...input('last_used')} />}
        </Field>
        <Field label="Aliases" hint="Comma-separated.">
          {(a) => <Input {...a} {...input('aliases')} />}
        </Field>
        <div className={s.wide}>
          <Field
            label="Evidence"
            hint={
              evidenceIds.length > 0
                ? `Comma-separated entry ids. Known: ${evidenceIds.join(', ')}`
                : 'Comma-separated entry ids. No experience or project ids yet.'
            }
          >
            {(a) => <Input {...a} {...input('evidence')} />}
          </Field>
        </div>
      </form>
    </Dialog>
  );
}
