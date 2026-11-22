import { useState } from 'react';
import { SENIORITY } from '@shared/jobs/schemas';
import type { SearchProfile } from '@shared/discovery/schemas';
import {
  Button,
  Checkbox,
  ConfirmDialog,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Loading,
  SectionHeader,
  StatusDot,
  Switch,
  useToast,
} from '../../ui';
import { useDeleteProfile, useProfiles, useSaveProfile } from '../../lib/discovery';
import {
  EMPTY_PROFILE_FORM,
  formToProfile,
  profileSummary,
  profileToForm,
  type ProfileForm,
} from './discoveryHelpers';
import s from './settings.module.css';

export function ProfilesSection(): React.JSX.Element {
  const q = useProfiles();
  const del = useDeleteProfile();
  const { toast } = useToast();
  // `null` = closed, `'new'` = empty form, otherwise the profile being edited.
  const [editing, setEditing] = useState<SearchProfile | 'new' | null>(null);
  const [removing, setRemoving] = useState<SearchProfile | null>(null);

  return (
    <section id="settings-profiles" className={s.section} aria-label="Search profiles">
      <SectionHeader
        title="Search profiles"
        level={3}
        actions={
          <Button size="sm" onClick={() => setEditing('new')}>
            New search profile
          </Button>
        }
      />
      {q.isPending ? (
        <Loading what="Reading search profiles" />
      ) : q.isError ? (
        <ErrorState
          title="Could not read the search profiles"
          message={q.error.message}
          action={<Button onClick={() => void q.refetch()}>Retry</Button>}
        />
      ) : q.data.length === 0 ? (
        <EmptyState title="No search profile yet">
          A profile says which roles, places and salary a scan looks for. Without one, the first scan builds
          one from your profile preferences.
        </EmptyState>
      ) : (
        <table className={s.rows} aria-label="Search profiles">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Roles</th>
              <th scope="col">Where</th>
              <th scope="col">Status</th>
              <th scope="col">
                <span className={s.srOnly}>Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {q.data.map((p) => (
              <tr key={p.id}>
                <td>{p.name}</td>
                <td className={s.wide}>{profileSummary(p)}</td>
                <td className={s.wide}>
                  {[...p.locations, p.remoteOk ? 'remote ok' : ''].filter(Boolean).join(', ') || '—'}
                </td>
                <td>
                  <StatusDot tone={p.enabled ? 'ok' : 'neutral'}>{p.enabled ? 'On' : 'Off'}</StatusDot>
                </td>
                <td className={s.end}>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Edit ${p.name}`}
                    onClick={() => setEditing(p)}
                  >
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Delete ${p.name}`}
                    onClick={() => setRemoving(p)}
                  >
                    Delete
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editing && (
        <ProfileDialog
          key={editing === 'new' ? 'new' : editing.id}
          profile={editing}
          onClose={() => setEditing(null)}
        />
      )}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title="Delete this search profile?"
        description={removing ? `${removing.name} stops being searched. Jobs already found stay.` : undefined}
        confirmLabel="Delete profile"
        danger
        onConfirm={() => {
          if (removing)
            del.mutate(removing.id, {
              onSuccess: () =>
                toast({ title: 'Search profile deleted', description: removing.name, tone: 'neutral' }),
              onError: (e) => toast({ title: 'Could not delete', description: e.message, tone: 'bad' }),
            });
        }}
      />
    </section>
  );
}

function ProfileDialog({
  profile,
  onClose,
}: {
  profile: SearchProfile | 'new';
  onClose: () => void;
}): React.JSX.Element {
  const save = useSaveProfile();
  const [f, setF] = useState<ProfileForm>(profile === 'new' ? EMPTY_PROFILE_FORM : profileToForm(profile));
  const [error, setError] = useState<string | null>(null);
  const set = (p: Partial<ProfileForm>): void => setF((x) => ({ ...x, ...p }));
  const text = (key: keyof ProfileForm, label: string, hint?: string, placeholder?: string) => (
    <Field label={label} hint={hint}>
      {(p) => (
        <Input
          {...p}
          value={String(f[key])}
          placeholder={placeholder}
          onChange={(e) => set({ [key]: e.target.value })}
        />
      )}
    </Field>
  );

  const submit = (): void => {
    const r = formToProfile(f);
    if (!r.ok) return setError(r.error);
    setError(null);
    save.mutate(
      { ...(profile === 'new' ? {} : { id: profile.id }), profile: r.value },
      { onSuccess: onClose, onError: (e) => setError(e.message) },
    );
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={profile === 'new' ? 'New search profile' : 'Edit search profile'}
      description="Lists take comma-separated entries."
      size="lg"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={save.isPending} onClick={submit}>
            Save profile
          </Button>
        </>
      }
    >
      <form
        className={s.profileForm}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {text('name', 'Name')}
        {text('roles', 'Roles', undefined, 'Data Engineer, Analytics Engineer')}
        {text('keywords', 'Keywords')}
        {text('excludeKeywords', 'Exclude keywords')}
        {text('locations', 'Locations', undefined, 'Germany, Berlin')}
        {text('countries', 'Countries')}
        {text('languages', 'Languages', 'Codes the posting may require, e.g. en, de.')}
        {text('excludedCompanies', 'Excluded companies')}
        {text('salaryFloor', 'Salary floor', 'Per year. Postings that state less are dropped.')}
        {text('currency', 'Currency', undefined, 'EUR')}
        <fieldset className={s.seniority}>
          <legend>Seniority</legend>
          {SENIORITY.map((v) => (
            <Checkbox
              key={v}
              label={v}
              checked={f.seniority.includes(v)}
              onCheckedChange={(on) =>
                set({ seniority: on === true ? [...f.seniority, v] : f.seniority.filter((x) => x !== v) })
              }
            />
          ))}
        </fieldset>
        <div className={s.switches}>
          <Switch label="Remote is fine" checked={f.remoteOk} onCheckedChange={(v) => set({ remoteOk: v })} />
          <Switch label="Profile enabled" checked={f.enabled} onCheckedChange={(v) => set({ enabled: v })} />
        </div>
        {error && (
          <p className={s.error} role="alert">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
