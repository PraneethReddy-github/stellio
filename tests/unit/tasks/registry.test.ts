import { describe, expect, it } from 'vitest';
import { UserError } from '../../../src/main/ipc/dispatch';
import { createTaskRegistry } from '../../../src/main/services/tasks/registry';

/** A task that resolves when told to, or rejects when its signal fires. */
function pending() {
  let finish: (v: string) => void = () => undefined;
  let signal: AbortSignal | undefined;
  const fn = (s: AbortSignal) =>
    new Promise<string>((resolve, reject) => {
      signal = s;
      finish = resolve;
      s.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  return { fn, finish: (v: string) => finish(v), signal: () => signal };
}

describe('createTaskRegistry', () => {
  it('rejects a duplicate request id while the first is running, then allows it again', async () => {
    const reg = createTaskRegistry();
    const t = pending();
    const first = reg.run('a', t.fn);
    await expect(reg.run('a', () => Promise.resolve('x'))).rejects.toBeInstanceOf(UserError);
    expect(reg.size).toBe(1);
    t.finish('done');
    await expect(first).resolves.toBe('done');
    await expect(reg.run('a', () => Promise.resolve('again'))).resolves.toBe('again');
  });

  it('cancel before the id runs is a no-op and does not pre-cancel a later run', async () => {
    const reg = createTaskRegistry();
    expect(reg.cancel('b')).toBe(false);
    const t = pending();
    const p = reg.run('b', t.fn);
    expect(t.signal()?.aborted).toBe(false);
    t.finish('ok');
    await expect(p).resolves.toBe('ok');
  });

  it('cancel while running aborts the signal; cancel after finishing returns false', async () => {
    const reg = createTaskRegistry();
    const t = pending();
    const p = reg.run('c', t.fn);
    expect(reg.cancel('c')).toBe(true);
    await expect(p).rejects.toThrow('aborted');
    expect(t.signal()?.aborted).toBe(true);
    expect(reg.cancel('c')).toBe(false);
    expect(reg.size).toBe(0);
  });

  it('removes the entry after the task throws', async () => {
    const reg = createTaskRegistry();
    await expect(reg.run('d', () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(reg.size).toBe(0);
    expect(reg.cancel('d')).toBe(false);
    await expect(reg.run('d', () => Promise.resolve(1))).resolves.toBe(1);
  });
});
