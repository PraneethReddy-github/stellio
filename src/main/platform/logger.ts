import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const SECRET_KEY =
  /^(api_?key|.*(secret|password|passwd|authorization|cookie|credential).*|(access|refresh|auth|id|bearer|session)_?token|token)$/i;

/** Replaces values of secret-looking keys, recursively. Logs must never contain credentials. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET_KEY.test(k) ? '[redacted]' : redact(v, depth + 1);
  }
  return out;
}

export interface FileLoggerOptions {
  file: string;
  level?: LogLevel;
  maxBytes?: number;
  keep?: number;
  echo?: boolean;
}

/** JSON-lines logger with size-based rotation: file → file.1 → … → file.<keep>. */
export function createFileLogger({
  file,
  level = 'info',
  maxBytes = 5 * 1024 * 1024,
  keep = 3,
  echo = false,
}: FileLoggerOptions): Logger {
  mkdirSync(dirname(file), { recursive: true });

  const rotate = (): void => {
    if (!existsSync(file) || statSync(file).size < maxBytes) return;
    rmSync(`${file}.${keep}`, { force: true });
    for (let i = keep - 1; i >= 1; i--) {
      if (existsSync(`${file}.${i}`)) renameSync(`${file}.${i}`, `${file}.${i + 1}`);
    }
    renameSync(file, `${file}.1`);
  };

  const write = (lvl: LogLevel, event: string, fields?: LogFields): void => {
    if (LEVELS[lvl] < LEVELS[level]) return;
    // Fields first, so a field named `t`/`lvl`/`event` can never overwrite the envelope.
    const line = JSON.stringify({
      ...(redact(fields ?? {}) as LogFields),
      t: new Date().toISOString(),
      lvl,
      event,
    });
    try {
      rotate();
      appendFileSync(file, line + '\n');
    } catch {
      // Logging must never crash the app.
    }
    if (echo) console[lvl === 'debug' ? 'log' : lvl](line);
  };

  return {
    debug: (e, f) => write('debug', e, f),
    info: (e, f) => write('info', e, f),
    warn: (e, f) => write('warn', e, f),
    error: (e, f) => write('error', e, f),
  };
}
