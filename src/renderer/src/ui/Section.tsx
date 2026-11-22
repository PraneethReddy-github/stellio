import type { ReactNode } from 'react';
import s from './section.module.css';

/** Micro-label section title with optional right-aligned actions. */
export function SectionHeader({
  title,
  actions,
  level = 2,
}: {
  title: string;
  actions?: ReactNode;
  level?: 2 | 3 | 4;
}): React.JSX.Element {
  const H = `h${String(level)}` as 'h2';
  return (
    <header className={s.header}>
      <H className={s.title}>{title}</H>
      {actions && <div className={s.actions}>{actions}</div>}
    </header>
  );
}

export interface KeyValueItem {
  key: string;
  value: ReactNode;
  mono?: boolean;
}

/** Definition list as a two-column grid with hairline rows. */
export function KeyValue({ items }: { items: KeyValueItem[] }): React.JSX.Element {
  return (
    <dl className={s.kv}>
      {items.map((it) => (
        <div key={it.key} className={s.pair}>
          <dt>{it.key}</dt>
          <dd className={it.mono ? s.mono : undefined}>{it.value}</dd>
        </div>
      ))}
    </dl>
  );
}
