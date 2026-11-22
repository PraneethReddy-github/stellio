import {
  Activity,
  ChartColumn,
  CircleDot,
  Columns3,
  FileText,
  Inbox,
  Layers,
  Users,
  ScrollText,
  Settings2,
  User,
  type LucideIcon,
} from 'lucide-react';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Second key of the `G <key>` shortcut. */
  key?: string;
}

/** Rail order per docs/10-screens.md. */
export const NAV: NavItem[] = [
  { to: '/', label: 'Today', icon: CircleDot, key: 't' },
  { to: '/inbox', label: 'Inbox', icon: Inbox, key: 'i' },
  { to: '/applications', label: 'Applications', icon: Columns3, key: 'a' },
  { to: '/referrals', label: 'Referrals', icon: Users, key: 'f' },
  { to: '/workspace', label: 'Workspace', icon: FileText, key: 'w' },
  { to: '/skills', label: 'Skills', icon: Layers, key: 's' },
  { to: '/insights', label: 'Insights', icon: ChartColumn, key: 'n' },
  { to: '/profile', label: 'Profile', icon: User, key: 'p' },
  { to: '/rules', label: 'Rules', icon: ScrollText, key: 'r' },
  { to: '/activity', label: 'Activity', icon: Activity },
  { to: '/settings', label: 'Settings', icon: Settings2 },
];
