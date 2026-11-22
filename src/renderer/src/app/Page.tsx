import type { ReactNode } from 'react';
import { cx } from '../ui/cx';
import s from './Page.module.css';

export function Page({
  title,
  subtitle,
  actions,
  fill,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  /** Body takes the remaining height instead of growing the page (editors, split views). */
  fill?: boolean;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <div className={cx(s.page, fill && s.fill)}>
      <div className={s.header}>
        <h2 className={s.title}>{title}</h2>
        {subtitle && <p className={s.subtitle}>{subtitle}</p>}
        {actions && <div className={s.actions}>{actions}</div>}
      </div>
      {fill ? <div className={s.fillBody}>{children}</div> : children}
    </div>
  );
}
