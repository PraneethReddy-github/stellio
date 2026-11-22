// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiRun } from '@renderer/lib/activity';
import { RunDetail } from '@renderer/features/activity/RunDetail';

afterEach(cleanup);

const run: AiRun = {
  id: '01JABCDEFGHJKMNPQRSTVWXYZ0',
  task: 'job.analyze',
  model: 'm',
  promptVersion: 'v1',
  startedAt: '2026-11-19T21:57:03.123Z',
  durationMs: null,
  status: 'running',
  exitCode: null,
  tokens: null,
  error: null,
  relatedType: null,
  relatedId: null,
};
const log = {
  system: 'SYS',
  input: 'IN',
  attempts: [{ stdout: 'OUT', stderr: '', exitCode: 0, timedOut: false, aborted: false }],
};

function setup(): { invoke: ReturnType<typeof vi.fn>; ui: (r: AiRun) => React.JSX.Element } {
  const invoke = vi.fn(() => Promise.resolve({ ok: true, data: { run, log } }));
  Object.assign(window, { stellio: { invoke } });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    invoke,
    ui: (r) => (
      <QueryClientProvider client={qc}>
        <RunDetail run={r} />
      </QueryClientProvider>
    ),
  };
}

describe('RunDetail', () => {
  it('says a running run is still running, without reading the log or claiming it was pruned', () => {
    const { invoke, ui } = setup();
    render(ui(run));
    expect(screen.getByText('Running — prompt and output are saved when it finishes.')).toBeTruthy();
    expect(screen.queryByText(/pruned/)).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('reads the log once the list sees the run finish', async () => {
    const { invoke, ui } = setup();
    const view = render(ui(run));
    view.rerender(ui({ ...run, status: 'ok' }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Output' })).toBeTruthy());
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/saved when it finishes/)).toBeNull();
  });
});
