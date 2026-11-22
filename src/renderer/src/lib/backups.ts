import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { NotificationSettings } from '@shared/settings/notifications';
import { call } from './ipc';

const BACKUPS = ['backups'] as const;
const NOTIFICATIONS = ['settings', 'notifications'] as const;

export const useBackups = () =>
  useQuery({
    queryKey: BACKUPS,
    queryFn: () => call('backups:list', undefined),
    refetchOnMount: 'always',
  });

export function useCreateBackup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => call('backups:create', undefined),
    onSuccess: () => qc.invalidateQueries({ queryKey: BACKUPS }),
  });
}

export const useRestoreBackup = () =>
  useMutation({ mutationFn: (name: string) => call('backups:restore', { name }) });

export const useOpenBackupsFolder = () =>
  useMutation({ mutationFn: () => call('backups:openFolder', undefined) });

export const useNotificationSettings = () =>
  useQuery({
    queryKey: NOTIFICATIONS,
    queryFn: () => call('notifications:get', undefined),
    refetchOnMount: 'always',
  });

export function useSetNotificationSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (value: NotificationSettings) => call('notifications:set', value),
    onSuccess: (saved) => qc.setQueryData(NOTIFICATIONS, saved),
  });
}

/** `1.4 MB`, `12 KB`. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${String(n)} B`;
  if (n < 1024 * 1024) return `${String(Math.round(n / 1024))} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
