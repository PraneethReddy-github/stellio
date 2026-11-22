import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import { create } from 'zustand';
import type { IpcInput, IpcOutput } from '@shared/ipc/contract';
import { call } from './ipc';
import { queryClient } from './queryClient';

export type Sources = IpcOutput<'discovery:sources'>;
export type Profiles = IpcOutput<'discovery:profiles'>;
export type InboxQuery = IpcInput<'jobs:inbox'>;
export type InboxRows = IpcOutput<'jobs:inbox'>;
export type ScanOutcome = IpcOutput<'discovery:scanNow'>;
export type TimerPreview = IpcOutput<'discovery:timerPreview'>;

const ROOT = ['discovery'] as const;

/** A scan or a job change makes every discovery view, job list and Today stale. */
const refreshAll = (qc: QueryClient): Promise<unknown> =>
  Promise.all(['discovery', 'jobs', 'tracker'].map((k) => qc.invalidateQueries({ queryKey: [k] })));

type Plain =
  | 'discovery:sources'
  | 'discovery:profiles'
  | 'discovery:watchlist'
  | 'discovery:schedule'
  | 'discovery:settings'
  | 'discovery:timerStatus';
const plain = <T>(channel: Plain, fn: () => Promise<T>) => ({
  queryKey: [...ROOT, channel],
  queryFn: fn,
  refetchOnMount: 'always' as const,
});

export const useSources = () =>
  useQuery(plain('discovery:sources', () => call('discovery:sources', undefined)));
export const useProfiles = () =>
  useQuery(plain('discovery:profiles', () => call('discovery:profiles', undefined)));
export const useWatchlist = () =>
  useQuery(plain('discovery:watchlist', () => call('discovery:watchlist', undefined)));
export const useSchedule = () =>
  useQuery(plain('discovery:schedule', () => call('discovery:schedule', undefined)));
export const useDiscoverySettings = () =>
  useQuery(plain('discovery:settings', () => call('discovery:settings', undefined)));
export const useTimerStatus = () =>
  useQuery(plain('discovery:timerStatus', () => call('discovery:timerStatus', undefined)));

export const useInbox = (query: InboxQuery) =>
  useQuery({
    queryKey: [...ROOT, 'inbox', query],
    queryFn: () => call('jobs:inbox', query),
    placeholderData: keepPreviousData,
    refetchOnMount: 'always',
  });

export const useLastRun = () =>
  useQuery({
    queryKey: [...ROOT, 'runs'],
    queryFn: () => call('discovery:scanRuns', { limit: 1 }).then((r) => r[0] ?? null),
    refetchOnMount: 'always',
  });

/** Mutation whose answer replaces one cached query. */
function useSetting<
  C extends 'discovery:setSourceEnabled' | 'discovery:setSchedule' | 'discovery:setSettings',
>(channel: C, key: Plain) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: IpcInput<C>) => call(channel, input),
    onSuccess: (data) => qc.setQueryData([...ROOT, key], data),
  });
}
export const useSetSourceEnabled = () => useSetting('discovery:setSourceEnabled', 'discovery:sources');
export const useSetSchedule = () => useSetting('discovery:setSchedule', 'discovery:schedule');
export const useSetDiscoverySettings = () => useSetting('discovery:setSettings', 'discovery:settings');

function useRefreshing<I, O>(fn: (input: I) => Promise<O>) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: () => refreshAll(qc) });
}
export const useSaveProfile = () =>
  useRefreshing((i: IpcInput<'discovery:saveProfile'>) => call('discovery:saveProfile', i));
export const useDeleteProfile = () => useRefreshing((id: string) => call('discovery:deleteProfile', { id }));
export const useSetApiKey = () =>
  useRefreshing((i: { appId: string; appKey: string }) =>
    call('discovery:setApiKey', { id: 'adzuna', ...i }),
  );
export const useClearApiKey = () => useRefreshing(() => call('discovery:clearApiKey', { id: 'adzuna' }));
export const useWatchAdd = () =>
  useRefreshing((i: { url: string; name?: string }) =>
    call('discovery:watchAdd', { ...i, requestId: crypto.randomUUID() }),
  );
export const useWatchRemove = () => useRefreshing((id: string) => call('discovery:watchRemove', { id }));
export const useTimerPreview = (enabled: boolean) =>
  useQuery({
    queryKey: [...ROOT, 'timerPreview'],
    queryFn: () => call('discovery:timerPreview', undefined),
    enabled,
    gcTime: 0,
  });
export const useTimerInstall = () => useRefreshing(() => call('discovery:timerInstall', undefined));
export const useTimerRemove = () => useRefreshing(() => call('discovery:timerRemove', undefined));
export const useShortlist = () => useRefreshing((id: string) => call('jobs:shortlist', { id }));
export const useDismiss = () => useRefreshing((i: { id: string; reason: string }) => call('jobs:dismiss', i));

// ---- scan: lives outside React so leaving the Inbox does not lose it ----

export interface ScanState {
  running: boolean;
  requestId: string | null;
  startedAt: number | null;
  /** Per source: how far it got. */
  progress: Record<string, { fetched: number; new: number }>;
  error: string | null;
}
const IDLE: ScanState = {
  running: false,
  requestId: null,
  startedAt: null,
  progress: {},
  error: null,
};
export const useScanState = create<ScanState>(() => IDLE);

export async function startScan(): Promise<ScanOutcome | null> {
  if (useScanState.getState().running) return null;
  const requestId = crypto.randomUUID();
  useScanState.setState({ ...IDLE, running: true, requestId, startedAt: Date.now() });
  const off = window.stellio.on('discovery:progress', (p) => {
    if (p.requestId === requestId)
      useScanState.setState((st) => ({
        progress: { ...st.progress, [p.source]: { fetched: p.fetched, new: p.new } },
      }));
  });
  try {
    const out = await call('discovery:scanNow', { requestId });
    useScanState.setState({ running: false });
    return out;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    useScanState.setState({ running: false, error: message });
    return null;
  } finally {
    off();
    void refreshAll(queryClient);
  }
}

export const cancelScan = (): Promise<unknown> => {
  const id = useScanState.getState().requestId;
  return id ? call('tasks:cancel', { requestId: id }).catch(() => undefined) : Promise.resolve();
};
