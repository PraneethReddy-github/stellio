import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createClaudeRunner, type AiRunRecorder, type RunRequest } from '../../../src/main/ai/runner';
import type { Logger } from '../../../src/main/platform/logger';

const FAKE = resolve('tests/fixtures/fake-claude/claude.mjs');
const schema = z.object({ answer: z.string() });
const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {} };

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stellio-runner-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface Call {
  kind: 'call' | 'end';
  argv: string[];
  stdin: string;
  cwd: string;
  env: Record<string, string | null>;
  t: number;
}
const calls = (): Call[] =>
  readFileSync(join(dir, 'cap.ndjson'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Call);

function make(mode: string, extra: Record<string, string> = {}, opts: Record<string, unknown> = {}) {
  const records: { start: unknown[]; finish: [string, unknown][] } = { start: [], finish: [] };
  const recorder: AiRunRecorder = {
    start: (r) => void records.start.push(r),
    finish: (id, r) => void records.finish.push([id, r]),
  };
  const runner = createClaudeRunner({
    bin: FAKE,
    cwd: join(dir, 'ai-cwd'),
    logger: quiet,
    recorder,
    retryDelayMs: 1,
    killGraceMs: 300,
    env: {
      FAKE_CLAUDE_MODE: mode,
      FAKE_CLAUDE_CAPTURE: join(dir, 'cap.ndjson'),
      FAKE_CLAUDE_STATE: join(dir, 'state'),
      FAKE_CLAUDE_PIDFILE: join(dir, 'pid'),
      ...extra,
    },
    ...opts,
  });
  return { runner, records };
}

const req = (over: Partial<RunRequest<{ answer: string }>> = {}): RunRequest<{ answer: string }> => ({
  task: 'test.task',
  model: 'haiku',
  systemPrompt: 'be brief',
  input: 'hello world',
  schema,
  jsonSchema: { type: 'object', properties: { answer: { type: 'string' } } },
  ...over,
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('argv / env / cwd', () => {
  it('follows docs/04 section 1', async () => {
    const { runner } = make('ok');
    // SIMPLE must be stripped even when inherited from the parent env
    process.env.CLAUDE_CODE_SIMPLE = '1';
    try {
      const res = await runner.run(req({ effort: 'low' }));
      expect(res).toMatchObject({ ok: true, status: 'ok', data: { answer: 'hi' } });
    } finally {
      delete process.env.CLAUDE_CODE_SIMPLE;
    }
    const [c] = calls();
    expect(c?.argv).toEqual([
      '-p',
      '--model',
      'haiku',
      '--output-format',
      'json',
      '--json-schema',
      JSON.stringify(req().jsonSchema),
      '--system-prompt',
      'be brief',
      '--tools',
      '',
      '--no-session-persistence',
      '--disable-slash-commands',
      '--setting-sources',
      '',
      '--effort',
      'low',
    ]);
    expect(c?.stdin).toBe('hello world');
    expect(c?.cwd).toBe(join(dir, 'ai-cwd'));
    expect(existsSync(join(dir, 'ai-cwd'))).toBe(true);
    expect(c?.env).toEqual({ CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_CODE_SIMPLE: null });
  });

  it('strips $schema from the JSON schema (the CLI rejects the draft-2020-12 ref)', async () => {
    const { runner } = make('ok');
    await runner.run(
      req({ jsonSchema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object' } }),
    );
    const argv = calls()[0]?.argv ?? [];
    expect(argv[argv.indexOf('--json-schema') + 1]).toBe('{"type":"object"}');
  });

  it('omits --effort when not given and never uses --bare', async () => {
    const { runner } = make('ok');
    await runner.run(req());
    const argv = calls()[0]?.argv ?? [];
    expect(argv).not.toContain('--effort');
    expect(argv).not.toContain('--bare');
  });

  it('streaming adds stream-json flags and reports progress', async () => {
    const { runner } = make('ok');
    const events: string[] = [];
    const res = await runner.run(req({ streaming: true, onProgress: (e) => events.push(e.type) }));
    expect(res.ok).toBe(true);
    const argv = calls()[0]?.argv ?? [];
    expect(argv.slice(argv.indexOf('--output-format'), argv.indexOf('--output-format') + 2)).toEqual([
      '--output-format',
      'stream-json',
    ]);
    expect(argv).toContain('--verbose');
    expect(argv).toContain('--include-partial-messages');
    expect(events).toEqual(['system', 'assistant', 'rate_limit_event', 'result']);
  });
});

describe('result handling', () => {
  it('falls back to JSON.parse(result) when structured_output is missing', async () => {
    const { runner } = make('result_text_only');
    expect(await runner.run(req())).toMatchObject({ ok: true, data: { answer: 'hi' } });
  });

  it('reports cost and tokens', async () => {
    const { runner } = make('ok');
    expect(await runner.run(req())).toMatchObject({
      ok: true,
      costUsd: 0.0012,
      tokens: { input: 100, output: 20 },
    });
  });
});

describe('classification', () => {
  it.each([
    ['auth', 'auth', /Not logged in/],
    ['usage_limit', 'usage_limit', /usage limit/],
    ['bad_model', 'bad_model', /selected model/],
    ['nonzero_with_json', 'error', /boom/],
  ])('%s -> %s (stdout JSON parsed despite exit 1)', async (mode, status, msg) => {
    const { runner, records } = make(mode);
    const res = await runner.run(req());
    expect(res).toMatchObject({ ok: false, status });
    if (!res.ok) expect(res.error).toMatch(msg);
    expect(calls().filter((c) => c.kind === 'call')).toHaveLength(1); // never retried
    expect(records.finish[0]?.[1]).toMatchObject({ status: status });
  });

  it('invalid output after repair retry fails visibly', async () => {
    const { runner } = make('invalid_always');
    const res = await runner.run(req());
    expect(res).toMatchObject({ ok: false, status: 'invalid_output' });
    expect(calls().filter((c) => c.kind === 'call')).toHaveLength(2);
  });

  it('transient failure is retried with backoff, then succeeds', async () => {
    const { runner, records } = make('overloaded_then_ok');
    const res = await runner.run(req());
    expect(res).toMatchObject({ ok: true, attempts: 2 });
    expect(records.finish[0]?.[1]).toMatchObject({ status: 'ok', retries: 1 });
  });

  it('transient failure gives up after 2 retries', async () => {
    const { runner } = make('overloaded');
    const res = await runner.run(req());
    expect(res).toMatchObject({ ok: false, status: 'error' });
    expect(calls().filter((c) => c.kind === 'call')).toHaveLength(3);
  });

  it('missing binary is an error, not a crash', async () => {
    const { runner } = make('ok', {}, { bin: join(dir, 'nope') });
    expect(await runner.run(req())).toMatchObject({ ok: false, status: 'error' });
  });
});

describe('repair retry', () => {
  it('appends the zod issues to the input on the second call', async () => {
    const { runner } = make('invalid_then_ok');
    const res = await runner.run(req());
    expect(res).toMatchObject({ ok: true, data: { answer: 'hi' } });
    const cs = calls().filter((c) => c.kind === 'call');
    expect(cs).toHaveLength(2);
    expect(cs[0]?.stdin).toBe('hello world');
    expect(cs[1]?.stdin).toContain('hello world');
    expect(cs[1]?.stdin).toMatch(/failed validation/i);
    expect(cs[1]?.stdin).toContain('answer');
  });
});

describe('timeout and cancel', () => {
  it('timeout kills the whole process group, no orphan', async () => {
    const { runner } = make('hang', {}, { maxRetries: 0 });
    const res = await runner.run(req({ timeoutMs: 500 }));
    expect(res).toMatchObject({ ok: false, status: 'timeout' });
    const pid = Number(readFileSync(join(dir, 'pid'), 'utf8'));
    await new Promise((r) => setTimeout(r, 100));
    expect(alive(pid)).toBe(false);
  }, 15_000);

  it('escalates to SIGKILL when SIGTERM is ignored', async () => {
    const { runner } = make('hang_stubborn', {}, { maxRetries: 0 });
    const t0 = Date.now();
    const res = await runner.run(req({ timeoutMs: 300 }));
    expect(res).toMatchObject({ ok: false, status: 'timeout' });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(300 + 300);
    const pid = Number(readFileSync(join(dir, 'pid'), 'utf8'));
    await new Promise((r) => setTimeout(r, 100));
    expect(alive(pid)).toBe(false);
  }, 15_000);

  it('abort signal cancels a running task', async () => {
    const { runner, records } = make('hang', {}, { maxRetries: 0 });
    const ac = new AbortController();
    const p = runner.run(req({ signal: ac.signal, timeoutMs: 30_000 }));
    await new Promise((r) => setTimeout(r, 400));
    ac.abort();
    expect(await p).toMatchObject({ ok: false, status: 'cancelled' });
    const pid = Number(readFileSync(join(dir, 'pid'), 'utf8'));
    await new Promise((r) => setTimeout(r, 100));
    expect(alive(pid)).toBe(false);
    expect(records.finish[0]?.[1]).toMatchObject({ status: 'cancelled' });
  }, 15_000);

  it('already-aborted signal never spawns', async () => {
    const { runner } = make('ok');
    const ac = new AbortController();
    ac.abort();
    expect(await runner.run(req({ signal: ac.signal }))).toMatchObject({ status: 'cancelled' });
    expect(existsSync(join(dir, 'cap.ndjson'))).toBe(false);
  });
});

describe('abort between attempts', () => {
  it('abort after attempt 1 finishes never spawns the repair attempt', async () => {
    const { runner, records } = make('ok');
    const ac = new AbortController();
    // Validation fails and aborts in the same tick: the child is already gone, so no abort listener is live.
    const failing = schema.refine(() => {
      ac.abort();
      return false;
    });
    const res = await runner.run(req({ schema: failing, signal: ac.signal }));
    expect(res).toMatchObject({ ok: false, status: 'cancelled' });
    expect(calls().filter((c) => c.kind === 'call')).toHaveLength(1);
    expect(records.finish[0]?.[1]).toMatchObject({ status: 'cancelled' });
  });
});

describe('synchronous failures', () => {
  it('a spawn that throws (NUL in argv) is an error and still finishes the run record', async () => {
    const { runner, records } = make('ok');
    const res = await runner.run(req({ model: 'bad\0model' }));
    expect(res).toMatchObject({ ok: false, status: 'error' });
    expect(records.finish).toHaveLength(1);
    expect(records.finish[0]?.[1]).toMatchObject({ status: 'error' });
  });

  it('an unusable cwd is an error and still finishes the run record', async () => {
    const { runner, records } = make('ok', {}, { cwd: join(dir, 'a\0b') });
    expect(await runner.run(req())).toMatchObject({ ok: false, status: 'error' });
    expect(records.finish[0]?.[1]).toMatchObject({ status: 'error' });
  });
});

describe('queue', () => {
  const order = () =>
    calls()
      .filter((c) => c.kind === 'call')
      .map((c) => c.stdin);

  it('respects the concurrency limit', async () => {
    const { runner } = make('ok', { FAKE_CLAUDE_DELAY_MS: '250' }, { concurrency: 2 });
    await Promise.all([1, 2, 3, 4].map((i) => runner.run(req({ input: `j${i}` }))));
    let cur = 0;
    let max = 0;
    for (const c of calls()) {
      cur += c.kind === 'call' ? 1 : -1;
      max = Math.max(max, cur);
    }
    expect(max).toBe(2);
  });

  const maxConcurrent = (): number => {
    let cur = 0;
    let max = 0;
    for (const c of calls()) {
      cur += c.kind === 'call' ? 1 : -1;
      max = Math.max(max, cur);
    }
    return max;
  };

  it('a throwing concurrency getter falls back to 2 instead of wedging the queue', async () => {
    const concurrency = () => {
      throw new Error('settings unreadable');
    };
    const { runner } = make('ok', { FAKE_CLAUDE_DELAY_MS: '200' }, { concurrency });
    const res = await Promise.all([1, 2, 3].map((i) => runner.run(req({ input: `j${i}` }))));
    expect(res.map((r) => r.status)).toEqual(['ok', 'ok', 'ok']);
    expect(maxConcurrent()).toBe(2);
  });

  it('pump() starts queued runs right away after the limit is raised', async () => {
    let limit = 1;
    const { runner } = make('ok', { FAKE_CLAUDE_DELAY_MS: '400' }, { concurrency: () => limit });
    const all = Promise.all([1, 2, 3].map((i) => runner.run(req({ input: `j${i}` }))));
    await new Promise((r) => setTimeout(r, 100));
    limit = 3;
    runner.pump();
    await all;
    expect(maxConcurrent()).toBe(3);
  });

  it('user-priority tasks jump ahead of queued background tasks', async () => {
    const { runner } = make('ok', { FAKE_CLAUDE_DELAY_MS: '200' }, { concurrency: 1 });
    const ps = [
      runner.run(req({ input: 'first', priority: 'background' })),
      runner.run(req({ input: 'bg1', priority: 'background' })),
      runner.run(req({ input: 'bg2', priority: 'background' })),
      runner.run(req({ input: 'user', priority: 'user' })),
    ];
    await Promise.all(ps);
    expect(order()).toEqual(['first', 'user', 'bg1', 'bg2']);
  });

  it('cancelling a queued task removes it without spawning', async () => {
    const { runner } = make('ok', { FAKE_CLAUDE_DELAY_MS: '200' }, { concurrency: 1 });
    const ac = new AbortController();
    const p1 = runner.run(req({ input: 'a' }));
    const p2 = runner.run(req({ input: 'b', signal: ac.signal }));
    ac.abort();
    expect(await p2).toMatchObject({ status: 'cancelled' });
    await p1;
    expect(order()).toEqual(['a']);
  });
});

describe('recorder and logs', () => {
  it('records start and finish, and writes the full prompt + raw output when logDir is set', async () => {
    const logDir = join(dir, 'logs');
    const { runner, records } = make('ok', {}, { logDir });
    const res = await runner.run(req({ promptVersion: 3 }));
    expect(records.start).toHaveLength(1);
    expect(records.start[0]).toMatchObject({ task: 'test.task', model: 'haiku', promptVersion: 3 });
    expect(records.finish).toHaveLength(1);
    expect(records.finish[0]?.[1]).toMatchObject({ status: 'ok', tokensIn: 100, tokensOut: 20 });
    expect(records.finish[0]?.[0]).toBe(res.runId);
    const log = JSON.parse(readFileSync(join(logDir, `${res.runId}.json`), 'utf8')) as {
      system: string;
      input: string;
      attempts: { stdout: string }[];
    };
    expect(log.system).toBe('be brief');
    expect(log.input).toBe('hello world');
    expect(log.attempts[0]?.stdout).toContain('"structured_output"');
  });

  it('a throwing recorder never breaks the run', async () => {
    const runner = createClaudeRunner({
      bin: FAKE,
      cwd: join(dir, 'ai-cwd'),
      logger: quiet,
      env: { FAKE_CLAUDE_MODE: 'ok' },
      recorder: {
        start: () => {
          throw new Error('db down');
        },
        finish: () => {
          throw new Error('db down');
        },
      },
    });
    expect((await runner.run(req())).ok).toBe(true);
  });
});
