import { useState } from 'react';
import { Button, Field, KeyValue, Loading, SectionHeader, Select, Switch, useToast } from '../../ui';
import { applyDensity, readDensity, useAppInfo, type Density } from '../../lib/settings';
import { applyTheme, readThemePref, type ThemePref } from '../../lib/theme';
import {
  useCheckUpdates,
  useSetUpdateSettings,
  useUpdateDialog,
  useUpdateSettings,
  useUpdateStatus,
} from '../../lib/updates';
import s from './settings.module.css';

const THEMES = [
  { value: 'system', label: 'System' },
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
];
const DENSITIES = [
  { value: 'comfortable', label: 'Comfortable' },
  { value: 'compact', label: 'Compact' },
];

export function GeneralSection(): React.JSX.Element {
  const info = useAppInfo();
  const [theme, setTheme] = useState<ThemePref>(readThemePref);
  const [density, setDensity] = useState<Density>(readDensity);
  return (
    <section id="settings-general" className={s.section} aria-label="General">
      <SectionHeader title="General" level={3} />
      {info.data ? (
        <KeyValue
          items={[
            { key: 'Data folder', value: info.data.dataDir, mono: true },
            { key: 'Version', value: info.data.version, mono: true },
          ]}
        />
      ) : info.isError ? (
        <p className={s.error}>Could not read the data folder path: {info.error.message}</p>
      ) : (
        <Loading what="Reading app info" />
      )}
      <div className={s.fields}>
        <Field label="Theme">
          {(p) => (
            <Select
              {...p}
              options={THEMES}
              value={theme}
              onValueChange={(v) => {
                const next = v as ThemePref;
                setTheme(next);
                applyTheme(next);
              }}
            />
          )}
        </Field>
        <Field label="Density" hint="Row height in tables and lists.">
          {(p) => (
            <Select
              {...p}
              options={DENSITIES}
              value={density}
              onValueChange={(v) => {
                const next = v as Density;
                setDensity(next);
                applyDensity(next);
              }}
            />
          )}
        </Field>
      </div>
      <Updates />
    </section>
  );
}

function Updates(): React.JSX.Element {
  const { toast } = useToast();
  const q = useUpdateSettings();
  const set = useSetUpdateSettings();
  const check = useCheckUpdates();
  const update = useUpdateStatus().data?.available;
  const setOpen = useUpdateDialog((st) => st.setOpen);
  return (
    <div className={s.stack}>
      {q.isError && <p className={s.error}>Could not read the update setting: {q.error.message}</p>}
      <Switch
        label="Check for updates automatically"
        disabled={!q.data}
        checked={q.data?.autoCheck ?? false}
        onCheckedChange={(autoCheck) =>
          set.mutate(
            { autoCheck },
            {
              onError: (e) =>
                toast({ title: 'Could not save the update setting', description: e.message, tone: 'bad' }),
            },
          )
        }
      />
      <p className={s.quiet}>
        Asks GitHub for the newest release at start and once a day. Nothing about you is sent. Nothing is
        downloaded until you press Download and install.
      </p>
      <div className={s.statusRow}>
        <Button busy={check.isPending} onClick={() => check.mutate()}>
          Check now
        </Button>
        <p role="status" className={check.isError ? s.error : s.quiet}>
          {check.isError ? (
            check.error.message
          ) : update ? (
            <>
              Version {update.version} is available.{' '}
              <Button size="sm" onClick={() => setOpen(true)}>
                See what is new
              </Button>
            </>
          ) : check.isSuccess ? (
            'You have the newest version.'
          ) : null}
        </p>
      </div>
    </div>
  );
}
