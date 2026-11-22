import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import type { IpcInput, IpcOutput } from '@shared/ipc/contract';
import { call } from './ipc';

export type TrackerDetail = IpcOutput<'tracker:get'>;
export type TodayData = IpcOutput<'today:summary'>;
export type StatusInput = IpcInput<'apps:setStatus'>;
export type TableQuery = IpcInput<'tracker:table'>;

const ROOT = ['tracker'] as const;

/** Every tracker view (board, table, timeline, detail, Today, forJob) may differ after any change. */
export const refreshTracker = (qc: QueryClient): Promise<void> => qc.invalidateQueries({ queryKey: ROOT });

export const useBoard = () =>
  useQuery({
    queryKey: [...ROOT, 'board'],
    queryFn: () => call('tracker:board', undefined),
    refetchOnMount: 'always', // a deleted job removes its application without touching this cache
  });

export const useTable = (q: TableQuery) =>
  useQuery({
    queryKey: [...ROOT, 'table', q],
    queryFn: () => call('tracker:table', q),
    placeholderData: keepPreviousData,
    refetchOnMount: 'always',
  });

export const useTimeline = (from: string, to: string) =>
  useQuery({
    queryKey: [...ROOT, 'timeline', from, to],
    queryFn: () => call('tracker:timeline', { from, to }),
  });

export const useApplication = (id: string | null) =>
  useQuery({
    queryKey: [...ROOT, 'get', id],
    queryFn: () => call('tracker:get', { id: id ?? '' }),
    enabled: id !== null,
    retry: false,
  });

export const useAppForJob = (jobId: string) =>
  useQuery({ queryKey: [...ROOT, 'forJob', jobId], queryFn: () => call('apps:forJob', { jobId }) });

export const useToday = () =>
  useQuery({
    queryKey: [...ROOT, 'today'],
    queryFn: () => call('today:summary', undefined),
    refetchOnMount: 'always',
  });

export const useContacts = (applicationId: string) =>
  useQuery({
    queryKey: [...ROOT, 'contacts', applicationId],
    queryFn: () => call('apps:contact:list', { applicationId }),
  });

/** A change refreshes every tracker view, and the jobs caches (a job page shows its application's status). */
function useTracked<I, O>(fn: (input: I) => Promise<O>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['jobs'] });
      return refreshTracker(qc);
    },
  });
}

export const useSetStatus = () => useTracked((i: StatusInput) => call('apps:setStatus', i));
export const useCreateApp = () => useTracked((jobId: string) => call('apps:create', { jobId }));
export const useUpdateApp = () => useTracked((i: IpcInput<'apps:update'>) => call('apps:update', i));
export const useAddNote = () => useTracked((i: IpcInput<'apps:note'>) => call('apps:note', i));
export const useAddInterview = () =>
  useTracked((i: IpcInput<'apps:interview:add'>) => call('apps:interview:add', i));
export const useUpdateInterview = () =>
  useTracked((i: IpcInput<'apps:interview:update'>) => call('apps:interview:update', i));
export const useDeleteInterview = () => useTracked((id: string) => call('apps:interview:delete', { id }));
export const useAddContact = () =>
  useTracked((i: IpcInput<'apps:contact:add'>) => call('apps:contact:add', i));
export const useUpdateContact = () =>
  useTracked((i: IpcInput<'apps:contact:update'>) => call('apps:contact:update', i));
export const useDeleteContact = () => useTracked((id: string) => call('apps:contact:delete', { id }));
export const useLinkContact = () =>
  useTracked((i: IpcInput<'apps:contact:link'>) => call('apps:contact:link', i));
export const useUnlinkContact = () =>
  useTracked((i: IpcInput<'apps:contact:unlink'>) => call('apps:contact:unlink', i));
export const openFolder = (id: string) => call('apps:openFolder', { id });
export const exportCsv = (q: TableQuery) => call('tracker:exportCsv', q);
