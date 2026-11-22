import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createFileLogger, redact } from '../../src/main/platform/logger';

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('redact', () => {
  it('keeps ordinary fields that merely contain secret-ish substrings', () => {
    expect(redact({ inputTokens: 5, outputTokens: 7, keywords: ['a'], keySkills: 2 })).toEqual({
      inputTokens: 5,
      outputTokens: 7,
      keywords: ['a'],
      keySkills: 2,
    });
  });

  it('hides secret-looking keys at any depth', () => {
    expect(redact({ apiKey: 'a', nested: { authToken: 'b', ok: 1 }, list: [{ password: 'c' }] })).toEqual({
      apiKey: '[redacted]',
      nested: { authToken: '[redacted]', ok: 1 },
      list: [{ password: '[redacted]' }],
    });
  });
});

describe('createFileLogger', () => {
  it('writes JSON lines, filters by level, redacts', () => {
    dir = mkdtempSync(join(tmpdir(), 'stellio-log-'));
    const file = join(dir, 'logs', 'main.log');
    const log = createFileLogger({ file, level: 'info' });
    log.debug('hidden');
    log.info('shown', { token: 'secret', n: 1 });
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
    expect(entry).toMatchObject({ lvl: 'info', event: 'shown', token: '[redacted]', n: 1 });
  });

  it('never lets fields overwrite the envelope', () => {
    dir = mkdtempSync(join(tmpdir(), 'stellio-log-'));
    const file = join(dir, 'main.log');
    createFileLogger({ file }).info('real', { event: 'fake', lvl: 'error' });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ event: 'real', lvl: 'info' });
  });

  it('rotates when the file exceeds maxBytes and keeps at most `keep` files', () => {
    dir = mkdtempSync(join(tmpdir(), 'stellio-log-'));
    const file = join(dir, 'main.log');
    const log = createFileLogger({ file, maxBytes: 200, keep: 2 });
    for (let i = 0; i < 50; i++) log.info('event', { i, pad: 'x'.repeat(50) });
    expect(existsSync(file)).toBe(true);
    expect(existsSync(`${file}.1`)).toBe(true);
    expect(existsSync(`${file}.2`)).toBe(true);
    expect(existsSync(`${file}.3`)).toBe(false);
  });
});
