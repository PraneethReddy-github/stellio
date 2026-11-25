import { useSearch } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import { Page } from '../../app/Page';
import { AiSection } from './AiSection';
import { BackupsSection } from './BackupsSection';
import { DiscoverySection } from './DiscoverySection';
import { GeneralSection } from './GeneralSection';
import { LatexSection } from './LatexSection';
import { NotificationsSection } from './NotificationsSection';
import { ProfilesSection } from './ProfilesSection';
import { ScheduleSection } from './ScheduleSection';
import { SourcesSection } from './SourcesSection';
import { WatchlistSection } from './WatchlistSection';
import s from './settings.module.css';

const SECTIONS = [
  { id: 'general', title: 'General' },
  { id: 'ai', title: 'AI' },
  { id: 'profiles', title: 'Search profiles' },
  { id: 'sources', title: 'Sources' },
  { id: 'watchlist', title: 'Watchlist' },
  { id: 'schedule', title: 'Schedule' },
  { id: 'discovery', title: 'Discovery' },
  { id: 'latex', title: 'LaTeX' },
  { id: 'notifications', title: 'Notifications' },
  { id: 'backups', title: 'Backups' },
];

const scrollTo = (id: string): void =>
  document.getElementById(`settings-${id}`)?.scrollIntoView({ block: 'start', behavior: 'auto' });

export default function SettingsScreen(): React.JSX.Element {
  // Other screens link to one section (`/settings?section=profiles`).
  const search: { section?: string } = useSearch({ strict: false });
  const sections = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const id = search.section;
    const el = sections.current;
    if (!id || !el) return;
    // The sections above load their data later and push the target down: keep it in place until the user acts.
    const observer = new ResizeObserver(() => scrollTo(id));
    const stop = (): void => observer.disconnect();
    const events = ['wheel', 'keydown', 'pointerdown'] as const;
    observer.observe(el); // also fires once now
    for (const e of events) window.addEventListener(e, stop, { once: true });
    return () => {
      stop();
      for (const e of events) window.removeEventListener(e, stop);
    };
  }, [search.section]);

  return (
    <Page title="Settings">
      <div className={s.layout}>
        <nav className={s.index} aria-label="Settings sections">
          {SECTIONS.map((x) => (
            <button key={x.id} type="button" className={s.indexItem} onClick={() => scrollTo(x.id)}>
              {x.title}
            </button>
          ))}
        </nav>
        <div className={s.sections} ref={sections}>
          <GeneralSection />
          <AiSection />
          <ProfilesSection />
          <SourcesSection />
          <WatchlistSection />
          <ScheduleSection />
          <DiscoverySection />
          <LatexSection />
          <NotificationsSection />
          <BackupsSection />
        </div>
      </div>
    </Page>
  );
}
