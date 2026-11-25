import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { kwalletDisabled, withUserBins } from '../../src/main/platform/desktopEnv';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stellio-env-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('withUserBins', () => {
  it('adds the per-user folders after a desktop session PATH', () => {
    const parts = withUserBins('/usr/bin:/bin', home).split(':');
    expect(parts.slice(0, 3)).toEqual(['/usr/bin', '/bin', join(home, '.local/bin')]);
  });
  it('keeps the order of existing entries and adds nothing twice', () => {
    const local = join(home, '.local/bin');
    const parts = withUserBins(`${local}:/usr/bin`, home).split(':');
    expect(parts[0]).toBe(local);
    expect(parts.filter((p) => p === local)).toHaveLength(1);
  });
  it('drops empty entries (they mean the current folder) and keeps system folders when PATH is unset', () => {
    expect(withUserBins('/usr/bin::', home).split(':')).not.toContain('');
    expect(withUserBins(undefined, home).startsWith('/usr/bin:/bin:')).toBe(true);
  });
  it('lists nvm versions newest first', () => {
    for (const v of ['v9.0.0', 'v22.1.0'])
      mkdirSync(join(home, '.nvm/versions/node', v), { recursive: true });
    const nvm = withUserBins('/usr/bin', home)
      .split(':')
      .filter((p) => p.includes('.nvm'));
    expect(nvm.map((p) => p.split('/').at(-2))).toEqual(['v22.1.0', 'v9.0.0']);
  });
});

describe('kwalletDisabled', () => {
  const rc = (text: string): boolean => {
    writeFileSync(join(home, 'kwalletrc'), text);
    return kwalletDisabled({ XDG_CONFIG_HOME: home });
  };
  it('reads Enabled from the Wallet group only', () => {
    expect(rc('[Wallet]\nClose When Idle=false\nEnabled=false\nFirst Use=false\n\n[x]\napi=true\n')).toBe(
      true,
    );
    expect(rc('[Wallet]\nEnabled=false')).toBe(true);
    expect(rc('[Wallet]\nEnabled=true\n')).toBe(false);
    expect(rc('[Wallet]\nFirst Use=false\n\n[other]\nEnabled=false\n')).toBe(false);
  });
  it('is false without a config file', () => {
    expect(kwalletDisabled({ XDG_CONFIG_HOME: join(home, 'none') })).toBe(false);
  });
});
