import { createHashHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { lazy } from 'react';
import { Shell } from './Shell';

const ProfileScreen = lazy(() => import('../features/profile/ProfileScreen'));
const WorkspaceScreen = lazy(() => import('../features/workspace/WorkspaceScreen'));
const JobScreen = lazy(() => import('../features/workspace/JobScreen'));
const ActivityScreen = lazy(() => import('../features/activity/ActivityScreen'));
const RulesScreen = lazy(() => import('../features/rules/RulesScreen'));
const SettingsScreen = lazy(() => import('../features/settings/SettingsScreen'));
const SkillsScreen = lazy(() => import('../features/skills/SkillsScreen'));
const InsightsScreen = lazy(() => import('../features/insights/InsightsScreen'));
const TodayScreen = lazy(() => import('../features/today/TodayScreen'));
const ApplicationsScreen = lazy(() => import('../features/applications/ApplicationsScreen'));
const ApplicationDetail = lazy(() => import('../features/applications/ApplicationDetail'));
const InboxScreen = lazy(() => import('../features/inbox/InboxScreen'));
const ReferralsScreen = lazy(() => import('../features/referrals/ReferralsScreen'));
// The UI kit page ships only in dev builds; e2e builds opt in (`npm run build:e2e`), release builds never.
const DevUi =
  import.meta.env.DEV || import.meta.env.VITE_DEV_UI === '1'
    ? lazy(() => import('../features/dev/DevUi'))
    : null;

const root = createRootRoute({ component: Shell });

const page = (path: string, component: () => React.JSX.Element) =>
  createRoute({ getParentRoute: () => root, path, component });

const routes = [
  page('/', () => <TodayScreen />),
  page('/inbox', () => <InboxScreen />),
  page('/applications', () => <ApplicationsScreen />),
  page('/applications/$id', () => <ApplicationDetail />),
  page('/referrals', () => <ReferralsScreen />),
  page('/workspace', () => <WorkspaceScreen />),
  page('/workspace/$jobId', () => <JobScreen />),
  page('/skills', () => <SkillsScreen />),
  page('/insights', () => <InsightsScreen />),
  page('/profile', () => <ProfileScreen />),
  page('/rules', () => <RulesScreen />),
  page('/activity', () => <ActivityScreen />),
  page('/settings', () => <SettingsScreen />),
  ...(DevUi ? [page('/dev/ui', () => <DevUi />)] : []),
];

export const router = createRouter({
  routeTree: root.addChildren(routes),
  history: createHashHistory(),
  defaultPendingMs: 0,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
