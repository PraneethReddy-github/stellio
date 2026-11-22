import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { createClaudeRunner } from './runner';

export interface ClaudeStatus {
  installed: boolean;
  version?: string;
  loggedIn?: boolean;
  error?: string;
}

export interface PreflightOptions {
  /** Cheap model for the ping (a setting; default alias `haiku`). */
  model?: string;
  /** Run dir outside any project tree. */
  cwd: string;
  env?: Record<string, string>;
}

const exec = promisify(execFile);
const Ping = z.object({ ok: z.boolean() });

/** `claude --version`, then a tiny schema-bound ping to prove the login works. */
export async function checkClaude(bin: string, opts: PreflightOptions): Promise<ClaudeStatus> {
  let version: string;
  try {
    version = (
      await exec(bin, ['--version'], { env: { ...process.env, ...opts.env }, timeout: 15_000 })
    ).stdout.trim();
  } catch (e) {
    return { installed: false, error: e instanceof Error ? e.message : String(e) };
  }

  const runner = createClaudeRunner({
    bin,
    cwd: opts.cwd,
    concurrency: 1,
    maxRetries: 0,
    env: opts.env,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  const res = await runner.run({
    task: 'preflight.ping',
    model: opts.model ?? 'haiku',
    effort: 'low',
    systemPrompt: 'Reply with the JSON object {"ok": true}.',
    input: 'ping',
    schema: Ping,
    jsonSchema: z.toJSONSchema(Ping),
    timeoutMs: 60_000,
    priority: 'user',
  });
  if (res.ok) return { installed: true, version, loggedIn: true };
  if (res.status === 'auth') return { installed: true, version, loggedIn: false, error: res.error };
  return { installed: true, version, error: res.error };
}
