import { describe, expect, it, vi } from 'vitest';
import { dispatch, UserError, type IpcHandlers } from '../../src/main/ipc/dispatch';
import type { Logger } from '../../src/main/platform/logger';

const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const info = {
  name: 'Stellio',
  version: '0.0.0',
  electron: '1',
  chrome: '1',
  node: '1',
  platform: 'linux',
  dataDir: '/d',
  gitAvailable: true,
};
// Only the channels under test; dispatch looks handlers up by name.
const handlers = {
  'app:getInfo': () => info,
  'app:ping': ({ message }: { message: string }) => ({ echo: message, at: 'now' }),
} as unknown as IpcHandlers;

describe('dispatch', () => {
  it('runs the handler for valid input', async () => {
    await expect(dispatch(handlers, 'app:ping', { message: 'hi' }, logger)).resolves.toEqual({
      ok: true,
      data: { echo: 'hi', at: 'now' },
    });
  });

  it('rejects unknown channels, including prototype keys', async () => {
    for (const channel of ['nope', 'toString', '__proto__', 42, null]) {
      const res = await dispatch(handlers, channel, undefined, logger);
      expect(res).toMatchObject({ ok: false, error: { code: 'unknown_channel' } });
    }
  });

  it('rejects invalid input without calling the handler', async () => {
    const spy = vi.fn();
    const res = await dispatch({ ...handlers, 'app:ping': spy }, 'app:ping', { message: 5 }, logger);
    expect(res).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects oversized input per schema', async () => {
    const res = await dispatch(handlers, 'app:ping', { message: 'x'.repeat(201) }, logger);
    expect(res).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
  });

  it('strips output fields the contract does not declare', async () => {
    const leaky = { ...handlers, 'app:getInfo': () => ({ ...info, apiKey: 'secret' }) } as IpcHandlers;
    const res = await dispatch(leaky, 'app:getInfo', undefined, logger);
    expect(res).toEqual({ ok: true, data: info });
  });

  it('hides internal error details from the renderer', async () => {
    const failing = {
      ...handlers,
      'app:ping': () => {
        throw new Error('ENOENT /home/someone/secret/path');
      },
    } as IpcHandlers;
    const res = await dispatch(failing, 'app:ping', { message: 'x' }, logger);
    expect(res).toMatchObject({ ok: false, error: { code: 'internal' } });
    expect(JSON.stringify(res)).not.toContain('/home/someone');
  });

  it('passes UserError messages through as failed', async () => {
    const failing = {
      ...handlers,
      'app:ping': () => {
        throw new UserError('Profile has 2 errors');
      },
    } as IpcHandlers;
    await expect(dispatch(failing, 'app:ping', { message: 'x' }, logger)).resolves.toEqual({
      ok: false,
      error: { code: 'failed', message: 'Profile has 2 errors' },
    });
  });
});
