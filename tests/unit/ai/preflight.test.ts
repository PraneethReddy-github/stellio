import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkClaude } from '../../../src/main/ai/preflight';

const FAKE = resolve('tests/fixtures/fake-claude/claude.mjs');
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stellio-preflight-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const check = (mode: string, bin = FAKE) =>
  checkClaude(bin, {
    cwd: join(dir, 'cwd'),
    env: { FAKE_CLAUDE_MODE: mode, FAKE_CLAUDE_OUTPUT: '{"ok":true}' },
  });

describe('checkClaude', () => {
  it('installed and logged in', async () => {
    expect(await check('ok')).toEqual({ installed: true, version: '2.1.328 (Claude Code)', loggedIn: true });
  });
  it('installed but logged out', async () => {
    expect(await check('auth')).toMatchObject({ installed: true, loggedIn: false });
  });
  it('other ping failure keeps loggedIn unknown and reports the error', async () => {
    const r = await check('nonzero_with_json');
    expect(r).toMatchObject({ installed: true });
    expect(r.loggedIn).toBeUndefined();
    expect(r.error).toMatch(/boom/);
  });
  it('missing binary', async () => {
    const r = await check('ok', join(dir, 'nope'));
    expect(r.installed).toBe(false);
    expect(r.error).toBeTruthy();
  });
});
