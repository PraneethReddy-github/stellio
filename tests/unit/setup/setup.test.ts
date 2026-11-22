import { describe, expect, it } from 'vitest';
import { createSetupSettings } from '../../../src/main/services/settings/setup';
import { setupComplete, setupSteps, type SetupInputs } from '../../../src/shared/setup';
import { fixture, modelOf, seedTemplate } from '../profile/helpers';
import { freshDb } from '../db/helpers';

const ready: SetupInputs = {
  ai: { installed: true, loggedIn: true },
  profile: modelOf(fixture('full')),
  rulesReviewed: true,
  searchProfiles: 1,
  latex: { engine: { kind: 'tectonic' }, sandbox: 'bwrap', installSupported: true },
  scanEnabled: false,
};
const status = (i: SetupInputs) => Object.fromEntries(setupSteps(i).map((s) => [s.id, s.status]));

describe('setupSteps', () => {
  it('everything loaded and fine: complete, and the optional scan step does not matter', () => {
    const steps = setupSteps(ready);
    expect(steps.map((s) => s.status)).toEqual(['done', 'done', 'done', 'done', 'done', 'todo']);
    expect(setupComplete(steps)).toBe(true);
  });

  it('a fresh install: nothing is done for you, and the seed profile is not "filled"', () => {
    const fresh: SetupInputs = {
      ai: { installed: false },
      profile: modelOf(seedTemplate()),
      rulesReviewed: false,
      searchProfiles: 0,
      latex: { engine: null, installSupported: true },
      scanEnabled: false,
    };
    expect(status(fresh)).toEqual({
      claude: 'todo',
      profile: 'todo',
      rules: 'todo',
      search: 'todo',
      latex: 'todo',
      scan: 'todo',
    });
    const profile = setupSteps(fresh).find((s) => s.id === 'profile');
    expect(profile?.detail).toContain('example entry "Job Title — Company"');
    expect(setupComplete(setupSteps(fresh))).toBe(false);
  });

  it('unloaded inputs read as checking, never as done', () => {
    const none: SetupInputs = {
      ai: undefined,
      profile: undefined,
      rulesReviewed: false,
      searchProfiles: undefined,
      latex: undefined,
      scanEnabled: undefined,
    };
    expect(Object.values(status(none))).toEqual([
      'checking',
      'checking',
      'todo',
      'checking',
      'checking',
      'checking',
    ]);
  });

  it('logged-out CLI, engine without sandbox: both stay to do with a specific message', () => {
    const s = setupSteps({
      ...ready,
      ai: { installed: true, loggedIn: false },
      latex: { engine: {}, sandbox: null, installSupported: true },
    });
    expect(s[0]).toMatchObject({ status: 'todo' });
    expect(s[0]?.detail).toContain('not logged in');
    expect(s[4]).toMatchObject({ status: 'todo' });
    expect(s[4]?.detail).toContain('bubblewrap');
  });
});

describe('setup settings', () => {
  it('merges patches and survives a broken stored value', () => {
    const db = freshDb();
    const svc = createSetupSettings(db);
    expect(svc.get()).toEqual({ dismissed: false, completed: false, rulesReviewed: false });
    svc.set({ rulesReviewed: true });
    expect(svc.set({ dismissed: true })).toEqual({ dismissed: true, completed: false, rulesReviewed: true });
    expect(() => svc.set({ dismissed: 'yes' })).toThrow();
    db.sqlite.prepare("UPDATE settings_kv SET value_json = '\"junk\"' WHERE key = 'setup.state'").run();
    expect(svc.get().dismissed).toBe(false);
  });
});
