import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pruneAiLogs } from '../../../src/main/ai/logs';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stellio-logs-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const DAY = 86_400_000;
const touch = (name: string, ageDays: number) => {
  const f = join(dir, name);
  writeFileSync(f, '{}');
  const t = new Date(Date.now() - ageDays * DAY);
  utimesSync(f, t, t);
};

describe('pruneAiLogs', () => {
  it('deletes json logs older than maxAgeDays, keeps newer ones, returns the count', async () => {
    touch('old.json', 31);
    touch('new.json', 29);
    touch('old.txt', 90);
    expect(await pruneAiLogs(dir)).toBe(1);
    expect(existsSync(join(dir, 'old.json'))).toBe(false);
    expect(existsSync(join(dir, 'new.json'))).toBe(true);
    expect(existsSync(join(dir, 'old.txt'))).toBe(true);
  });

  it('honours a custom maxAgeDays', async () => {
    touch('a.json', 8);
    touch('b.json', 6);
    expect(await pruneAiLogs(dir, 7)).toBe(1);
    expect(existsSync(join(dir, 'b.json'))).toBe(true);
  });

  it('a missing directory is not an error', async () => {
    expect(await pruneAiLogs(join(dir, 'nope'))).toBe(0);
  });
});
