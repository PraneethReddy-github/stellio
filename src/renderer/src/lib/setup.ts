import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { IpcInput } from '@shared/ipc/contract';
import { call } from './ipc';

const KEY = ['setup'] as const;

export const useSetup = () =>
  useQuery({ queryKey: KEY, queryFn: () => call('setup:get', undefined), refetchOnMount: 'always' });

export function useSetSetup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: IpcInput<'setup:set'>) => call('setup:set', patch),
    onSuccess: (state) => qc.setQueryData(KEY, state),
  });
}
