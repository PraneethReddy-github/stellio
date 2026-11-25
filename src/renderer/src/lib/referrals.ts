import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { IpcInput, IpcOutput } from '@shared/ipc/contract';
import { call } from './ipc';
import { refreshTracker } from './tracker';

export type ReferralItem = IpcOutput<'referrals:list'>[number];
export type SearchOutcome = IpcOutput<'referrals:search'>;
export type SearchInput = Omit<IpcInput<'referrals:search'>, 'requestId'>;
export type SearchStage = 'searching' | 'validating' | 'saving';

const ROOT = ['referrals'] as const;

/** Requests with their person; for one job, or every job. */
export const useReferrals = (jobId?: string) =>
  useQuery({
    queryKey: [...ROOT, 'list', jobId ?? 'all'],
    queryFn: () => call('referrals:list', { jobId }),
    refetchOnMount: 'always',
  });

/** Contacted requests whose follow-up date has passed: main's clock decides. */
export const useDueReferrals = () =>
  useQuery({
    queryKey: [...ROOT, 'due'],
    queryFn: () => call('referrals:due', undefined),
    refetchOnMount: 'always',
  });

export const useReferralSettings = () =>
  useQuery({ queryKey: [...ROOT, 'settings'], queryFn: () => call('referrals:settings', undefined) });

/** Every list may differ after a change; an outreach status also lands on the application timeline. */
function useChanged<I, O>(fn: (input: I) => Promise<O>, tracker = false) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ROOT });
      if (tracker) void refreshTracker(qc);
    },
    // a cancelled or failed run still left an ai run behind
    onSettled: () => qc.invalidateQueries({ queryKey: ['ai', 'runs'] }),
  });
}

export const useSearchPeople = () =>
  useChanged((i: SearchInput & { requestId: string }) => call('referrals:search', i));
export const useDraftMessage = () =>
  useChanged((i: IpcInput<'referrals:draft'>) => call('referrals:draft', i));
export const useSetReferralStatus = () =>
  useChanged((i: IpcInput<'referrals:setStatus'>) => call('referrals:setStatus', i), true);
export const useDeletePerson = () => useChanged((personId: string) => call('referrals:delete', { personId }));
export const useDeletePeople = () =>
  useChanged((personIds: string[]) => call('referrals:deleteMany', { personIds }));
export const useDeleteAllPeople = () => useChanged(() => call('referrals:deleteAll', undefined));
export const useSetRetention = () =>
  useChanged((retentionDays: number) => call('referrals:setSettings', { retentionDays }));

/** The stage of the search with this request id, while it runs. */
export function useSearchStage(requestId: string | null): { stage: SearchStage; count?: number } | null {
  const [seen, setSeen] = useState<{ id: string; stage: SearchStage; count?: number } | null>(null);
  useEffect(
    () =>
      window.stellio.on('referrals:progress', (p) => {
        if (p.requestId === requestId) setSeen({ id: p.requestId, stage: p.stage, count: p.count });
      }),
    [requestId],
  );
  return seen && seen.id === requestId ? seen : null;
}
