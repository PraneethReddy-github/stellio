import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { IpcOutput } from '@shared/ipc/contract';
import { call } from './ipc';
import { cancelTask } from './jobs';

export type ProfileSnapshot = IpcOutput<'profile:get'>;
export const PROFILE_PATH = 'profile/praneethreddy.md';

const keys = {
  profile: ['profile'] as const,
  history: ['profile', 'history'] as const,
  changes: (hash: string) => ['profile', 'changes', hash] as const,
};

export function useProfile() {
  return useQuery({
    queryKey: keys.profile,
    queryFn: () => call('profile:get', undefined),
    refetchOnMount: 'always', // the file may have changed while this screen was closed
  });
}

export function useProfileHistory() {
  return useQuery({ queryKey: keys.history, queryFn: () => call('profile:history', { limit: 100 }) });
}

export function useProfileChanges(hash: string | null) {
  return useQuery({
    queryKey: keys.changes(hash ?? ''),
    queryFn: () => call('profile:changes', { hash: hash ?? '' }),
    enabled: hash !== null,
    staleTime: Infinity, // a commit's diff never changes
  });
}

/** Saves and refreshes profile + history. */
export function useSaveProfile() {
  const qc = useQueryClient();
  return useMutation({
    // The hash comes from the cache at call time, not from a render: a second save right after the first
    // would otherwise carry the previous hash and be rejected as a conflict.
    mutationFn: (input: { markdown: string; message?: string; expectedHash?: string | null }) =>
      call('profile:save', {
        ...input,
        // An explicit hash (e.g. from a skills preview) wins over the cache.
        expectedHash: input.expectedHash ?? qc.getQueryData<ProfileSnapshot>(keys.profile)?.hash ?? null,
      }),
    onSuccess: (snap) => {
      qc.setQueryData(keys.profile, snap);
      void qc.invalidateQueries({ queryKey: keys.history });
      void qc.invalidateQueries({ queryKey: ['skills'] }); // ledger and gaps read the profile
    },
  });
}

export function useRevertProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (hash: string) => call('profile:revert', { hash }),
    onSuccess: (snap) => {
      qc.setQueryData(keys.profile, snap);
      void qc.invalidateQueries({ queryKey: keys.history });
    },
  });
}

export function useImportProfile() {
  return useMutation({ mutationFn: () => call('profile:importFromFile', undefined) });
}

/**
 * Calls `onExternalChange` when the profile file is edited outside the app.
 * The screen decides whether to reload silently or warn about unsaved edits.
 */
export function useProfileFileWatch(onExternalChange: () => void): void {
  useEffect(
    () =>
      window.stellio.on('datafolder:changed', ({ relPath }) => {
        if (relPath === PROFILE_PATH) onExternalChange();
      }),
    [onExternalChange],
  );
}

export function useGitAvailable(): boolean {
  const q = useQuery({
    queryKey: ['app', 'info'],
    queryFn: () => call('app:getInfo', undefined),
    staleTime: Infinity,
  });
  return q.data?.gitAvailable ?? true;
}

export type ProfileSuggestionData = IpcOutput<'profile:suggest'>;

/** `profile.suggest`: a preview only. Saving goes through `useSaveProfile` after the user confirms the diff. */
export function useSuggestProfile() {
  const [requestId, setRequestId] = useState<string | null>(null);
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: () => {
      const id = crypto.randomUUID();
      setRequestId(id);
      return call('profile:suggest', { requestId: id });
    },
    onSettled: () => {
      setRequestId(null);
      void qc.invalidateQueries({ queryKey: ['ai', 'runs'] });
    },
  });
  return { ...m, cancel: () => (requestId ? cancelTask(requestId) : Promise.resolve()) };
}

const photoKey = ['photo'] as const;

/** The resume photo (templates/photo.jpg) as a data URL, or none. */
export function usePhoto() {
  return useQuery({ queryKey: photoKey, queryFn: () => call('photo:get', undefined) });
}

/** Main opens the file picker; the answer is the new photo state, or cancelled. */
export function useChoosePhoto() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => call('photo:choose', undefined),
    onSuccess: (r) => {
      if (r.status === 'saved') qc.setQueryData(photoKey, r.photo);
    },
  });
}

export function useClearPhoto() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => call('photo:clear', undefined),
    onSuccess: (r) => qc.setQueryData(photoKey, r),
  });
}
