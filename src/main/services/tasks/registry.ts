import { UserError } from '../../ipc/dispatch';

/** In-flight cancellable tasks, keyed by a renderer-supplied request id. */
export function createTaskRegistry() {
  const running = new Map<string, AbortController>();
  return {
    /** Runs `fn` with an AbortSignal that `cancel(requestId)` fires. */
    async run<T>(requestId: string, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
      if (running.has(requestId)) throw new UserError('That request is already running.');
      const ctl = new AbortController();
      running.set(requestId, ctl);
      try {
        return await fn(ctl.signal);
      } finally {
        running.delete(requestId);
      }
    },
    /** True when a running task was signalled. */
    cancel(requestId: string): boolean {
      const ctl = running.get(requestId);
      ctl?.abort();
      return ctl !== undefined;
    },
    get size(): number {
      return running.size;
    },
  };
}
export type TaskRegistry = ReturnType<typeof createTaskRegistry>;
