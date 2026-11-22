import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import { Kbd } from '../ui/Kbd';
import { Toaster } from '../ui/Toast';
import { CommandPalette, useCommandPalette } from './CommandPalette';
import { NAV } from './nav';
import { useGlobalShortcuts } from './shortcuts';
import { UsageLimitBanner } from './UsageLimitBanner';
import s from './Shell.module.css';

export function Shell(): React.JSX.Element {
  const palette = useCommandPalette();
  useGlobalShortcuts(palette.setOpen);
  const pathname = useRouterState({ select: (st) => st.location.pathname });
  const current = NAV.find((n) => (n.to === '/' ? pathname === '/' : pathname.startsWith(n.to)));

  return (
    <div className={s.shell}>
      <nav className={s.rail} aria-label="Main">
        <div className={s.railInner}>
          <div className={s.brand}>
            <span className={s.brandMark} aria-hidden="true" />
            <span className={s.brandText}>stellio</span>
          </div>
          <ul className={s.nav}>
            {NAV.slice(0, 8).map((item) => (
              <NavLink key={item.to} item={item} />
            ))}
          </ul>
          <div className={s.navSpacer} />
          <ul className={s.nav}>
            {NAV.slice(8).map((item) => (
              <NavLink key={item.to} item={item} />
            ))}
          </ul>
        </div>
      </nav>

      <header className={s.topbar}>
        <p className={s.crumb} aria-label="Location">
          <span>stellio</span>
          <span aria-hidden="true">/</span>
          <strong>{(current?.label ?? pathname.replace(/^\//, '').replace('/', ' ')).toLowerCase()}</strong>
        </p>
        <div className={s.topSpacer} />
        <button type="button" className={s.search} onClick={() => palette.setOpen(true)}>
          <span>Search or run a command</span>
          <Kbd keys="Ctrl K" />
        </button>
      </header>

      <UsageLimitBanner />

      <main className={s.main} id="main">
        <Outlet />
      </main>

      <CommandPalette {...palette} />
      <Toaster />
    </div>
  );
}

function NavLink({ item }: { item: (typeof NAV)[number] }): React.JSX.Element {
  const Icon = item.icon;
  return (
    <li>
      <Link to={item.to} className={s.navItem} activeOptions={{ exact: item.to === '/' }}>
        <Icon aria-hidden="true" />
        <span className={s.navLabel}>{item.label}</span>
        {item.key && (
          <span className={s.navKbd}>
            <Kbd keys={`G ${item.key.toUpperCase()}`} />
          </span>
        )}
      </Link>
    </li>
  );
}
