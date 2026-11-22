import {
  ipcContract,
  isIpcChannel,
  type IpcChannel,
  type IpcInput,
  type IpcOutput,
  type IpcResult,
} from '@shared/ipc/contract';
import type { Logger } from '../platform/logger';

/** Throw from a handler for an expected failure; its message is shown to the user as-is. */
export class UserError extends Error {
  override name = 'UserError';
}

export type IpcHandlers = {
  [C in IpcChannel]: (input: IpcInput<C>) => Promise<IpcOutput<C>> | IpcOutput<C>;
};

/**
 * Validates a raw renderer call against the contract and runs its handler.
 * Never throws: every failure becomes an IpcResult error the renderer can show.
 */
export async function dispatch(
  handlers: IpcHandlers,
  channel: unknown,
  rawInput: unknown,
  logger: Logger,
): Promise<IpcResult<unknown>> {
  if (!isIpcChannel(channel)) {
    logger.warn('ipc.unknown_channel', { channel: String(channel).slice(0, 100) });
    return { ok: false, error: { code: 'unknown_channel', message: `Unknown channel` } };
  }
  const parsed = ipcContract[channel].input.safeParse(rawInput);
  if (!parsed.success) {
    logger.warn('ipc.invalid_input', { channel, issues: parsed.error.issues.length });
    return {
      ok: false,
      error: { code: 'invalid_input', message: parsed.error.issues.map((i) => i.message).join('; ') },
    };
  }
  try {
    const handler = handlers[channel] as (input: unknown) => unknown;
    // Output is parsed too: it strips fields the contract doesn't declare, so nothing leaks by accident.
    const data = ipcContract[channel].output.parse(await handler(parsed.data));
    return { ok: true, data };
  } catch (err) {
    if (err instanceof UserError) {
      logger.info('ipc.handler_user_error', { channel, message: err.message });
      return { ok: false, error: { code: 'failed', message: err.message } };
    }
    // Details stay in the log; the renderer gets a generic message (no paths, no stderr).
    logger.error('ipc.handler_failed', {
      channel,
      error: err instanceof Error ? (err.stack ?? err.message) : String(err),
    });
    return {
      ok: false,
      error: { code: 'internal', message: 'Something went wrong. Details are in the log.' },
    };
  }
}
