import type { IpcChannel, IpcErrorCode, IpcInput, IpcOutput } from '@shared/ipc/contract';

export class IpcError extends Error {
  constructor(
    readonly code: IpcErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'IpcError';
  }
}

/** Typed call into the main process. Throws IpcError on failure. */
export async function call<C extends IpcChannel>(channel: C, input: IpcInput<C>): Promise<IpcOutput<C>> {
  const result = await window.stellio.invoke(channel, input);
  if (!result.ok) throw new IpcError(result.error.code, result.error.message);
  return result.data;
}
