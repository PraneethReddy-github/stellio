import { useQuery } from '@tanstack/react-query';
import type { IpcOutput } from '@shared/ipc/contract';
import { call } from './ipc';

export type AiRun = IpcOutput<'ai:runs'>[number];
export type AiRunDetail = IpcOutput<'ai:run'>;

export function useRuns() {
  return useQuery({
    queryKey: ['ai', 'runs'],
    queryFn: () => call('ai:runs', { limit: 200 }),
    refetchOnMount: 'always',
    // a run in flight finishes without any event: poll until nothing is running
    refetchInterval: (q) => (q.state.data?.some((r) => r.status === 'running') ? 2000 : false),
  });
}

/** Keyed by status: a run that finishes gets a fresh read of its (by then written) log. */
export function useRun(id: string | undefined, status: AiRun['status']) {
  return useQuery({
    queryKey: ['ai', 'run', id, status],
    queryFn: () => call('ai:run', { id: id ?? '' }),
    // a running run has no saved prompt and output yet
    enabled: id !== undefined && status !== 'running',
    // finished runs never change
    staleTime: 10_000,
  });
}
