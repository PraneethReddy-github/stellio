import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { create } from 'zustand';
import type { UpdateProgress, UpdateSettings } from '@shared/settings/updates';
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

/** The update dialog opens from the banner and from Settings. */
export const useUpdateDialog = create<{ open: boolean; setOpen: (open: boolean) => void }>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));

export function useInstallUpdate() {
  const qc = useQueryClient();
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const m = useMutation({
    mutationFn: (version: string) => call('updates:install', { version }),
    onSuccess: (st) => qc.setQueryData(STATUS, st),
    onSettled: () => setProgress(null),
  });
  useEffect(() => window.stellio.on('updates:progress', setProgress), []);
  return { ...m, progress };
}
export const useRestartForUpdate = () =>
  useMutation({ mutationFn: () => call('updates:restart', undefined) });
export const cancelUpdate = (): Promise<unknown> => call('updates:cancel', undefined).catch(() => undefined);

export const mb = (bytes: number): string => `${(bytes / 1e6).toFixed(0)} MB`;
export function updateProgressText(p: UpdateProgress): string {
  if (p.phase === 'verify') return 'verifying the checksum';
  if (p.phase === 'install') return 'installing (your system may ask for your password)';
  return `downloading ${mb(p.received)} of ${mb(p.total)}`;
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
