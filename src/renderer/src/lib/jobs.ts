import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { IpcInput, IpcOutput } from '@shared/ipc/contract';
import { call } from './ipc';

export type JobList = IpcOutput<'jobs:list'>;
export type JobSummary = JobList['items'][number];
export type JobGet = IpcOutput<'jobs:get'>;
export type IntakeResult = IpcOutput<'jobs:intakeUrl'>;
type JobState = IpcInput<'jobs:setState'>['state'];

const keys = {
  all: ['jobs'] as const,
  list: ['jobs', 'list'] as const,
  job: (id: string) => ['jobs', 'job', id] as const,
};

/** The list and every opened job may have changed (intake, analysis, state, delete). */
const refresh = (qc: QueryClient): Promise<void> => qc.invalidateQueries({ queryKey: keys.all });

export function useJobs(limit = 100) {
  return useQuery({
    queryKey: [...keys.list, limit],
    queryFn: () => call('jobs:list', { limit, offset: 0 }),
    refetchOnMount: 'always',
  });
}

export function useJob(id: string) {
  return useQuery({
    queryKey: keys.job(id),
    queryFn: () => call('jobs:get', { id }),
    refetchOnMount: 'always', // profileStale depends on the profile file, which may have changed
    retry: false,
  });
}

export function useIntake() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (
      input:
        | { kind: 'url'; url: string; requestId: string }
        | { kind: 'text'; text: string; url?: string; requestId: string },
    ) =>
      input.kind === 'url'
        ? call('jobs:intakeUrl', { url: input.url, requestId: input.requestId })
        : call('jobs:intakeText', { text: input.text, url: input.url, requestId: input.requestId }),
    onSuccess: () => refresh(qc),
  });
}

export function useAnalyze(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (requestId: string) => call('jobs:analyze', { id, requestId }),
    onSuccess: () => refresh(qc),
    // a cancelled or failed run still left an ai run behind
    onSettled: () => qc.invalidateQueries({ queryKey: ['ai', 'runs'] }),
  });
}

export function useDeleteJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => call('jobs:delete', { id }),
    // only the list: refetching the deleted job while its page is still open would flash an error
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.list }),
  });
}

export function useSetJobState() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; state: JobState }) => call('jobs:setState', input),
    onSuccess: () => refresh(qc),
  });
}

/** Asks main to abort the task started with this requestId. Resolves quietly: the task's own promise reports the outcome. */
export const cancelTask = (requestId: string): Promise<unknown> =>
  call('tasks:cancel', { requestId }).catch(() => undefined);
