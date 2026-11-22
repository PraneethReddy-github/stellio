import { describe, expect, it, vi } from 'vitest';
import type { AppContext } from '../../src/main/bootstrap';
import { createHandlers } from '../../src/main/ipc/handlers';

vi.mock('electron', () => ({ app: {}, BrowserWindow: {}, dialog: {} }));

describe('settings:setAi', () => {
  it('saves first, then pumps the AI queue so a new concurrency limit applies at once', async () => {
    const order: string[] = [];
    const saved = { concurrency: 3 };
    const ctx = {
      aiSettings: { set: vi.fn(() => (order.push('set'), saved)) },
      runner: { pump: vi.fn(() => order.push('pump')) },
    } as unknown as AppContext;
    const handlers = createHandlers(ctx, () => undefined);
    expect(await handlers['settings:setAi']({ concurrency: 3 } as never)).toBe(saved);
    expect(order).toEqual(['set', 'pump']);
  });
});
