import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ulid } from 'ulid';
import { z, type ZodType } from 'zod';
import type { Logger } from '../platform/logger';

export type RunStatus =
  'ok' | 'auth' | 'usage_limit' | 'bad_model' | 'timeout' | 'cancelled' | 'invalid_output' | 'error';

export type StreamEvent = { type: string } & Record<string, unknown>;

export interface RunRequest<T> {
  task: string;
  /** Model id or alias. A setting, never hard-coded in task code. */
  model: string;
  effort?: 'low' | 'medium' | 'high';
  systemPrompt: string;
  /** Prompt body, piped on stdin. */
  input: string;
  schema: ZodType<T>;
  jsonSchema: object;
  timeoutMs?: number;
  signal?: AbortSignal;
  priority?: 'user' | 'background';
  /** stream-json output; `onProgress` receives each event. */
  streaming?: boolean;
  onProgress?: (event: StreamEvent) => void;
  promptVersion?: number;
  /** Built-in tools the run may use (`--tools`). Default none; only web discovery asks for `WebSearch,WebFetch`. */
  tools?: string;
}

interface RunMeta {
  runId: string;
  durationMs: number;
  /** Number of CLI processes spawned (retries and repair included). */
  attempts: number;
  costUsd?: number;
  tokens?: { input: number; output: number };
  /** Model the CLI reports it actually used. */
  model?: string;
}
export type RunResult<T> = RunMeta &
  ({ ok: true; status: 'ok'; data: T } | { ok: false; status: Exclude<RunStatus, 'ok'>; error: string });

export interface AiRunStart {
  id: string;
  task: string;
  model: string;
  promptVersion?: number;
  priority: 'user' | 'background';
  startedAt: string;
  /** First 16 hex chars of SHA-256 of the input. */
  inputHash: string;
}
export interface AiRunFinish {
  status: RunStatus;
  durationMs: number;
  exitCode?: number | null;
  error?: string;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  retries: number;
}
/** Implemented by the caller (the lead wires it to the `ai_runs` table). Errors are swallowed and logged. */
export interface AiRunRecorder {
  start(run: AiRunStart): void | Promise<void>;
  finish(id: string, result: AiRunFinish): void | Promise<void>;
}

export interface ClaudeRunnerOptions {
  /** Defaults to `process.env.STELLIO_CLAUDE_BIN ?? 'claude'`. */
  bin?: string;
  /** Must be outside any project tree (docs/04 §1). Created if missing. */
  cwd: string;
  /** A getter lets a settings change apply to the next queued run. */
  concurrency?: number | (() => number);
  recorder?: AiRunRecorder;
  logger: Logger;
  /** When set, `<logDir>/<runId>.json` gets the full prompt and raw output. */
  logDir?: string;
  /** Extra env, applied on top of `process.env` (tests). */
  env?: Record<string, string>;
  /** Transient-failure retries (default 2). */
  maxRetries?: number;
  /** Base of the exponential backoff (default 2000 ms). */
  retryDelayMs?: number;
  /** SIGTERM to SIGKILL escalation delay (default 5000 ms). */
  killGraceMs?: number;
}

export interface ClaudeRunner {
  run<T>(req: RunRequest<T>): Promise<RunResult<T>>;
  /** Re-reads the concurrency limit and starts queued runs that now fit (call after settings change). */
  pump(): void;
}

const Envelope = z.looseObject({
  is_error: z.boolean().optional(),
  api_error_status: z.unknown().optional(),
  result: z.string().optional(),
  structured_output: z.unknown().optional(),
  total_cost_usd: z.number().optional(),
  usage: z
    .looseObject({ input_tokens: z.number().optional(), output_tokens: z.number().optional() })
    .optional(),
  modelUsage: z.record(z.string(), z.unknown()).optional(),
});
type Envelope = z.infer<typeof Envelope>;

interface Attempt {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  spawnError?: string;
}

interface Outcome {
  status: RunStatus;
  error?: string;
  data?: unknown;
  issues?: string;
  transient?: boolean;
  envelope?: Envelope;
}

const USAGE_LIMIT = /usage limit|limit reached|hit your (?:\w+ )?limit|out of (?:extra )?usage/i;
const TRANSIENT_TEXT = /overload|rate.?limit|try again|temporar|econnreset|socket hang up|etimedout/i;
const TRANSIENT_STATUS = new Set([429, 500, 502, 503, 504, 529]);

function parseEnvelope(stdout: string): Envelope | undefined {
  const text = stdout.trim();
  // json mode: one object. stream-json: the last `result` event line.
  const candidates = [text, ...text.split('\n').reverse()];
  for (const c of candidates) {
    try {
      const parsed = Envelope.safeParse(JSON.parse(c));
      if (parsed.success && (parsed.data as { type?: unknown }).type === 'result') return parsed.data;
    } catch {
      // not JSON, try the next candidate
    }
  }
  return undefined;
}

function formatIssues(error: z.ZodError): string {
  return error.issues.map((i) => `- ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
}

function classify<T>(a: Attempt, schema: ZodType<T>): Outcome {
  if (a.aborted) return { status: 'cancelled', error: 'cancelled' };
  // Not retried: a hung run would hold its queue slot for timeoutMs × (1 + retries).
  if (a.timedOut) return { status: 'timeout', error: 'timed out', transient: false };
  if (a.spawnError) return { status: 'error', error: a.spawnError };

  const env = parseEnvelope(a.stdout);
  const text = env?.result ?? '';
  const httpStatus = typeof env?.api_error_status === 'number' ? env.api_error_status : undefined;
  const failed = env?.is_error === true || httpStatus !== undefined || a.exitCode !== 0;

  if (failed) {
    const msg = text || a.stderr.trim() || `exit ${String(a.exitCode)} with no output`;
    if (/^Not logged in/i.test(text)) return { status: 'auth', error: msg, envelope: env };
    if (httpStatus === 404 || a.stderr.includes('unrecognized_model'))
      return { status: 'bad_model', error: msg, envelope: env };
    if (USAGE_LIMIT.test(text)) return { status: 'usage_limit', error: msg, envelope: env };
    const transient =
      TRANSIENT_TEXT.test(msg) || (httpStatus !== undefined && TRANSIENT_STATUS.has(httpStatus));
    return { status: 'error', error: msg, transient, envelope: env };
  }
  if (!env) return { status: 'error', error: 'CLI produced no result envelope' };

  let raw: unknown = env.structured_output;
  if (raw === undefined) {
    try {
      raw = JSON.parse(text);
    } catch {
      return {
        status: 'invalid_output',
        error: 'result is not JSON',
        issues: '- (root): not JSON',
        envelope: env,
      };
    }
  }
  const parsed = schema.safeParse(raw);
  if (parsed.success) return { status: 'ok', data: parsed.data, envelope: env };
  const issues = formatIssues(parsed.error);
  return { status: 'invalid_output', error: `output failed validation:\n${issues}`, issues, envelope: env };
}

const repairInput = (input: string, issues: string): string =>
  `${input}\n\n<validation_error>\nYour previous output failed validation:\n${issues}\nReturn corrected JSON that matches the schema exactly.\n</validation_error>`;

export function createClaudeRunner(opts: ClaudeRunnerOptions): ClaudeRunner {
  const { logger, recorder } = opts;
  const concurrency = (): number => {
    if (typeof opts.concurrency !== 'function') return opts.concurrency ?? 2;
    try {
      return opts.concurrency();
    } catch (e) {
      // A throw here would escape release() and leave queued runs waiting forever.
      logger.warn('ai.concurrency_unreadable', { error: String(e) });
      return 2;
    }
  };
  const maxRetries = opts.maxRetries ?? 2;
  const retryDelayMs = opts.retryDelayMs ?? 2000;
  const killGraceMs = opts.killGraceMs ?? 5000;

  // ---- queue: user priority first, FIFO within a priority
  interface Waiter {
    prio: number;
    seq: number;
    grant: () => void;
  }
  let active = 0;
  let seq = 0;
  const pending: Waiter[] = [];
  const pump = () => {
    while (active < concurrency() && pending.length > 0) {
      pending.sort((x, y) => x.prio - y.prio || x.seq - y.seq);
      active++;
      pending.shift()?.grant();
    }
  };
  /** Resolves a release function, or null when cancelled while waiting. */
  const acquire = (priority: 'user' | 'background', signal?: AbortSignal): Promise<(() => void) | null> =>
    new Promise((resolve) => {
      if (signal?.aborted) return resolve(null);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        active--;
        pump();
      };
      const waiter: Waiter = {
        prio: priority === 'user' ? 0 : 1,
        seq: seq++,
        grant: () => resolve(release),
      };
      pending.push(waiter);
      signal?.addEventListener(
        'abort',
        () => {
          const i = pending.indexOf(waiter);
          if (i >= 0) {
            pending.splice(i, 1);
            resolve(null);
          }
        },
        { once: true },
      );
      pump();
    });

  const safely = async (what: string, fn: (() => void | Promise<void>) | undefined) => {
    try {
      await fn?.();
    } catch (e) {
      logger.warn('ai.recorder_failed', { what, error: String(e) });
    }
  };

  const killGroup = (pid: number | undefined, sig: NodeJS.Signals) => {
    if (pid === undefined) return;
    try {
      process.kill(-pid, sig); // detached child leads its own group
    } catch {
      // group already gone
    }
  };

  function spawnOnce(argv: string[], input: string, req: RunRequest<unknown>): Promise<Attempt> {
    return new Promise((resolve) => {
      const env: NodeJS.ProcessEnv = { ...process.env, ...opts.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' };
      delete env.CLAUDE_CODE_SIMPLE; // forces API-key auth: "Not logged in" on subscription logins
      const att: Attempt = { stdout: '', stderr: '', exitCode: null, timedOut: false, aborted: false };
      let settled = false;
      let timers: NodeJS.Timeout[] = [];
      const done = () => {
        if (settled) return;
        settled = true;
        timers.forEach(clearTimeout);
        timers = [];
        req.signal?.removeEventListener('abort', onAbort);
        resolve(att);
      };

      const child = spawn(opts.bin ?? process.env.STELLIO_CLAUDE_BIN ?? 'claude', argv, {
        cwd: opts.cwd,
        env,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const stop = () => {
        killGroup(child.pid, 'SIGTERM');
        timers.push(setTimeout(() => killGroup(child.pid, 'SIGKILL'), killGraceMs));
      };
      const onAbort = () => {
        att.aborted = true;
        stop();
      };
      req.signal?.addEventListener('abort', onAbort, { once: true });
      timers.push(
        setTimeout(() => {
          att.timedOut = true;
          stop();
        }, req.timeoutMs ?? 180_000),
      );

      let lineBuf = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        att.stdout += chunk;
        if (!req.streaming || !req.onProgress) return;
        lineBuf += chunk;
        const lines = lineBuf.split('\n');
        lineBuf = lines.pop() ?? '';
        for (const l of lines) {
          try {
            const ev = JSON.parse(l) as StreamEvent;
            req.onProgress(ev);
          } catch {
            // partial or non-JSON line: not progress
          }
        }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (c: string) => (att.stderr += c));
      child.stdin.on('error', () => undefined); // EPIPE when the child dies early
      child.on('error', (e) => {
        att.spawnError = `failed to start ${opts.bin ?? 'claude'}: ${e.message}`;
        done();
      });
      child.on('close', (code) => {
        att.exitCode = code;
        // reap anything that outlived the leader (tool/MCP grandchildren)
        if (att.timedOut || att.aborted) killGroup(child.pid, 'SIGKILL');
        if (lineBuf.trim() && req.streaming && req.onProgress) {
          try {
            req.onProgress(JSON.parse(lineBuf) as StreamEvent);
          } catch {
            // ignore
          }
        }
        done();
      });
      child.stdin.end(input);
    });
  }

  const sleep = (ms: number, signal?: AbortSignal): Promise<boolean> =>
    new Promise((resolve) => {
      if (signal?.aborted) return resolve(true);
      const t = setTimeout(() => resolve(false), ms);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(t);
          resolve(true);
        },
        { once: true },
      );
    });

  function buildArgv(req: RunRequest<unknown>): string[] {
    // z.toJSONSchema adds "$schema" (draft 2020-12); the CLI cannot resolve it and rejects the schema.
    const jsonSchema = { ...req.jsonSchema } as Record<string, unknown>;
    delete jsonSchema.$schema;
    const argv = [
      '-p',
      '--model',
      req.model,
      '--output-format',
      req.streaming ? 'stream-json' : 'json',
      '--json-schema',
      JSON.stringify(jsonSchema),
      '--system-prompt',
      req.systemPrompt,
      '--tools',
      req.tools ?? '',
      '--no-session-persistence',
      '--disable-slash-commands',
      '--setting-sources',
      '',
    ];
    // Without this, -p refuses every tool call ("permission denied") and a tool run just comes back empty.
    if (req.tools) argv.push('--allowedTools', req.tools);
    if (req.effort) argv.push('--effort', req.effort);
    if (req.streaming) argv.push('--verbose', '--include-partial-messages');
    return argv;
  }

  async function run<T>(req: RunRequest<T>): Promise<RunResult<T>> {
    const runId = ulid();
    const priority = req.priority ?? 'background';
    await safely('start', () =>
      recorder?.start({
        id: runId,
        task: req.task,
        model: req.model,
        promptVersion: req.promptVersion,
        priority,
        startedAt: new Date().toISOString(),
        inputHash: createHash('sha256').update(req.input).digest('hex').slice(0, 16),
      }),
    );

    const release = await acquire(priority, req.signal);
    const t0 = Date.now();
    const attempts: Attempt[] = [];
    let outcome: Outcome = { status: 'cancelled', error: 'cancelled' };
    let retries = 0;

    if (release) {
      try {
        mkdirSync(opts.cwd, { recursive: true });
        const argv = buildArgv(req);
        let input = req.input;
        let repaired = false;
        for (;;) {
          // The abort listener only lives while a child runs: re-check between attempts.
          if (req.signal?.aborted) {
            outcome = { status: 'cancelled', error: 'cancelled' };
            break;
          }
          const att = await spawnOnce(argv, input, req);
          attempts.push(att);
          outcome = classify(att, req.schema);
          if (outcome.status === 'invalid_output' && !repaired) {
            repaired = true;
            input = repairInput(req.input, outcome.issues ?? '');
            continue;
          }
          if (outcome.transient && retries < maxRetries) {
            retries++;
            logger.warn('ai.retry', { task: req.task, runId, retries, error: outcome.error });
            if (await sleep(retryDelayMs * 2 ** (retries - 1), req.signal)) {
              outcome = { status: 'cancelled', error: 'cancelled' };
              break;
            }
            continue;
          }
          break;
        }
      } catch (e) {
        // sync throws (bad cwd, NUL in argv) must not skip recorder.finish
        outcome = {
          status: 'error',
          error: `failed to run claude: ${e instanceof Error ? e.message : String(e)}`,
        };
      } finally {
        release();
      }
    }

    const env = outcome.envelope;
    const meta: RunMeta = {
      runId,
      durationMs: Date.now() - t0,
      attempts: attempts.length,
      costUsd: env?.total_cost_usd,
      tokens: env?.usage
        ? { input: env.usage.input_tokens ?? 0, output: env.usage.output_tokens ?? 0 }
        : undefined,
      model: env?.modelUsage ? Object.keys(env.modelUsage)[0] : undefined,
    };
    await safely('finish', () =>
      recorder?.finish(runId, {
        status: outcome.status,
        durationMs: meta.durationMs,
        exitCode: attempts.at(-1)?.exitCode,
        error: outcome.status === 'ok' ? undefined : outcome.error,
        tokensIn: meta.tokens?.input,
        tokensOut: meta.tokens?.output,
        costUsd: meta.costUsd,
        retries,
      }),
    );
    if (opts.logDir) {
      try {
        mkdirSync(opts.logDir, { recursive: true });
        await writeFile(
          join(opts.logDir, `${runId}.json`),
          JSON.stringify({
            runId,
            task: req.task,
            model: req.model,
            promptVersion: req.promptVersion,
            system: req.systemPrompt,
            input: req.input,
            attempts,
            status: outcome.status,
            error: outcome.error,
          }),
        );
      } catch (e) {
        logger.warn('ai.log_write_failed', { runId, error: String(e) });
      }
    }
    logger.info('ai.run', { task: req.task, runId, status: outcome.status, durationMs: meta.durationMs });

    if (outcome.status === 'ok') return { ...meta, ok: true, status: 'ok', data: outcome.data as T };
    return { ...meta, ok: false, status: outcome.status, error: outcome.error ?? 'unknown error' };
  }

  return { run, pump };
}
