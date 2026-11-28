import type { IpcChannel, IpcEventName, IpcEvents, IpcInput, IpcOutput, IpcResult } from './contract';

/** The one Electron IPC channel; the logical channel name travels as the first argument. */
export const IPC_INVOKE = 'stellio:invoke';
/** Prefix for main → renderer events. */
export const IPC_EVENT_PREFIX = 'stellio:event:';

/** Events the preload lets the renderer subscribe to (kept here, not in contract.ts, so the preload stays zod-free). */
export const ipcEventNames: readonly IpcEventName[] = [
  'datafolder:changed',
  'latex:installProgress',
  'updates:progress',
  'ai:usageLimit',
  'resume:progress',
  'cover:progress',
  'discovery:progress',
  'jobs:rescoreProgress',
  'referrals:progress',
];

/** Shape of `window.stellio`, exposed by the preload script. */
export interface StellioBridge {
  invoke<C extends IpcChannel>(channel: C, input: IpcInput<C>): Promise<IpcResult<IpcOutput<C>>>;
  /** Subscribes to a main → renderer event. Returns the unsubscribe function. */
  on<E extends IpcEventName>(event: E, listener: (payload: IpcEvents[E]) => void): () => void;
}
