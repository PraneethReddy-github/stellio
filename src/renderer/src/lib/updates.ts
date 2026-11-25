import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UpdateSettings } from '@shared/settings/updates';
import { call } from './ipc';

const SETTINGS = ['settings', 'updates'] as const;
const STATUS = ['updates', 'status'] as const;
const HOUR_MS = 60 * 60_000;

export const useUpdateSettings = () =>
  useQuery({ queryKey: SETTINGS, queryFn: () => call('updates:get', undefined), refetchOnMount: 'always' });

export function useSetUpdateSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (value: UpdateSettings) => call('updates:set', value),
    onSuccess: (saved) => {
      qc.setQueryData(SETTINGS, saved);
      void qc.invalidateQueries({ queryKey: STATUS });
    },
  });
}

/** Main decides whether a check is due; asking hourly keeps a long-running window current. */
export const useUpdateStatus = () =>
  useQuery({
    queryKey: STATUS,
    queryFn: () => call('updates:status', undefined),
    refetchInterval: HOUR_MS,
    refetchIntervalInBackground: true,
  });

export function useCheckUpdates() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => call('updates:check', undefined),
    onSuccess: (st) => qc.setQueryData(STATUS, st),
  });
}

// ---- A dismissed version stays quiet; the next one shows again (per-viewer convenience, so localStorage) ----
const DISMISSED = 'stellio.update.dismissed';

export function readDismissedUpdate(): string | null {
  try {
    return localStorage.getItem(DISMISSED);
  } catch {
    return null;
  }
}
export function dismissUpdate(version: string): void {
  try {
    localStorage.setItem(DISMISSED, version);
  } catch {
    // Not persisted; the banner stays closed for this session.
  }
}
