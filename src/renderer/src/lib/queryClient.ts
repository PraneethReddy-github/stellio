import { QueryClient } from '@tanstack/react-query';
import { IpcError } from './ipc';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Local IPC: failures are real errors, not flaky networks. Retry once for `internal` only.
      retry: (count, err) => count < 1 && !(err instanceof IpcError && err.code !== 'internal'),
      refetchOnWindowFocus: false,
      staleTime: 30_000,
    },
  },
});
