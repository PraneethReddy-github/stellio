import { useState } from 'react';
import { Field, KeyValue, Loading, SectionHeader, Select } from '../../ui';
import { applyDensity, readDensity, useAppInfo, type Density } from '../../lib/settings';
import { applyTheme, readThemePref, type ThemePref } from '../../lib/theme';
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
    </section>
  );
}
