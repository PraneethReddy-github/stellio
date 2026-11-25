import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareDatabase, type Db } from '../../../src/main/db/database';
import { createUpdatesService } from '../../../src/main/services/updates/service';
import { isNewer } from '../../../src/shared/settings/updates';

describe('isNewer', () => {
  it('compares numerically and refuses anything but x.y.z', () => {
    expect(isNewer('1.0.2', '1.0.1')).toBe(true);
    expect(isNewer('1.10.0', '1.9.9')).toBe(true);
    expect(isNewer('1.0.1', '1.0.1')).toBe(false);
    expect(isNewer('1.0.0', '1.0.1')).toBe(false);
    expect(isNewer('2.0.0-beta', '1.0.1')).toBe(false);
  });
});

describe('updates service', () => {
  let dir: string;
  let db: Db;
  let time = 0;
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const answer = (body: unknown, code = 200) =>
    vi.fn<typeof fetch>(() => Promise.resolve(new Response(JSON.stringify(body), { status: code })));
  const make = (fetchFn: typeof fetch, autoAllowed = true) =>
    createUpdatesService({ db, logger, current: '1.0.1', autoAllowed, fetchFn, now: () => time });

  beforeEach(() => {
    time = 0;
    dir = mkdtempSync(join(tmpdir(), 'stellio-upd-'));
    db = prepareDatabase(join(dir, 'x.db'), join(dir, 'b'));
  });
  afterEach(() => {
    db.sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports a newer release with a link it built itself', async () => {
    const st = await make(answer({ tag_name: 'v1.1.0', html_url: 'https://evil.example' })).status();
    expect(st.available).toEqual({
      version: '1.1.0',
      url: 'https://github.com/PraneethReddy-github/stellio/releases/tag/v1.1.0',
    });
  });
  it('checks automatically once a day, also after a failure', async () => {
    const f = answer({}, 500);
    const u = make(f);
    expect((await u.status()).available).toBeNull();
    await u.status();
    expect(f).toHaveBeenCalledTimes(1);
    time += 25 * 60 * 60_000;
    await u.status();
    expect(f).toHaveBeenCalledTimes(2);
  });
  it('never asks on its own when switched off or not allowed; Check now still does', async () => {
    const f = answer({ tag_name: 'v1.0.1' });
    const u = make(f);
    u.set({ autoCheck: false });
    await u.status();
    await make(f, false).status();
    expect(f).not.toHaveBeenCalled();
    expect((await u.checkNow()).available).toBeNull();
    expect(f).toHaveBeenCalledTimes(1);
  });
  it('Check now reports a failure or an odd answer', async () => {
    await expect(make(answer({ tag_name: 'v1/../../x' })).checkNow()).rejects.toThrow(
      /Could not reach GitHub/,
    );
  });
});
