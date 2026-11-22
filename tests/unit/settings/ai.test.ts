import { describe, expect, it } from 'vitest';
import { createAiSettings } from '../../../src/main/services/settings/ai';
import { setSetting } from '../../../src/main/db/repos/settings';
import {
  AI_TASKS,
  AiSettingsSchema,
  DEFAULT_AI_SETTINGS,
  resolveAiSettings,
  taskConfig,
} from '../../../src/shared/settings/ai';
import { freshDb } from '../db/helpers';

describe('defaults (docs/04 §2)', () => {
  it('cover every task and match the routing table', () => {
    expect(Object.keys(DEFAULT_AI_SETTINGS.models).sort()).toEqual([...AI_TASKS].sort());
    expect(DEFAULT_AI_SETTINGS.models['jd.parse']).toEqual({ model: 'claude-haiku-5-5', effort: 'low' });
    expect(DEFAULT_AI_SETTINGS.models['job.triage']).toEqual({ model: 'claude-haiku-5-5', effort: 'low' });
    expect(DEFAULT_AI_SETTINGS.models['job.analyze']).toEqual({
      model: 'claude-sonnet-5-5',
      effort: 'medium',
    });
    expect(DEFAULT_AI_SETTINGS.models['resume.generate']).toEqual({
      model: 'claude-sonnet-5-5',
      effort: 'high',
    });
    expect(DEFAULT_AI_SETTINGS.models['profile.import']).toEqual({
      model: 'claude-sonnet-5-5',
      effort: 'high',
    });
    expect(DEFAULT_AI_SETTINGS.concurrency).toBe(2);
    expect(AiSettingsSchema.safeParse(DEFAULT_AI_SETTINGS).success).toBe(true);
  });

  it('give generation tasks the longer timeout', () => {
    expect(taskConfig(DEFAULT_AI_SETTINGS, 'jd.parse').timeoutMs).toBe(180_000);
    expect(taskConfig(DEFAULT_AI_SETTINGS, 'resume.generate').timeoutMs).toBe(300_000);
    expect(taskConfig(DEFAULT_AI_SETTINGS, 'profile.import').timeoutMs).toBe(300_000);
  });
});

describe('validation', () => {
  const bad = (patch: object) => AiSettingsSchema.safeParse({ ...DEFAULT_AI_SETTINGS, ...patch }).success;
  it('rejects bad concurrency, timeouts, efforts and model ids', () => {
    expect(bad({ concurrency: 0 })).toBe(false);
    expect(bad({ concurrency: 9 })).toBe(false);
    expect(bad({ concurrency: 1.5 })).toBe(false);
    expect(bad({ timeoutsSec: { default: 1, generation: 300 } })).toBe(false);
    expect(bad({ timeoutsSec: { default: 180, generation: 99999 } })).toBe(false);
    const models = (model: string, effort = 'low') => ({
      models: { ...DEFAULT_AI_SETTINGS.models, 'jd.parse': { model, effort } },
    });
    expect(bad(models('--dangerously-skip-permissions'))).toBe(false); // would read as a CLI flag
    expect(bad(models(''))).toBe(false);
    expect(bad(models('a b'))).toBe(false);
    expect(bad(models('haiku', 'max'))).toBe(false);
    expect(bad(models('haiku'))).toBe(true);
    expect(bad(models('claude-haiku-5-5'))).toBe(true);
    expect(bad({ models: { 'jd.parse': { model: 'haiku', effort: 'low' } } })).toBe(false); // partial
  });
});

describe('resolveAiSettings', () => {
  it('fills gaps from defaults and keeps overrides', () => {
    const r = resolveAiSettings({
      concurrency: 3,
      models: { 'jd.parse': { model: 'sonnet', effort: 'high' } },
    });
    expect(r.concurrency).toBe(3);
    expect(r.models['jd.parse']).toEqual({ model: 'sonnet', effort: 'high' });
    expect(r.models['job.analyze']).toEqual(DEFAULT_AI_SETTINGS.models['job.analyze']);
    expect(r.timeoutsSec).toEqual(DEFAULT_AI_SETTINGS.timeoutsSec);
  });
  it('falls back to defaults for garbage', () => {
    expect(resolveAiSettings(null)).toEqual(DEFAULT_AI_SETTINGS);
    expect(resolveAiSettings('x')).toEqual(DEFAULT_AI_SETTINGS);
    expect(resolveAiSettings({ concurrency: 'many' })).toEqual(DEFAULT_AI_SETTINGS);
  });
});

describe('settings service (settings_kv)', () => {
  it('returns defaults, persists a valid change, refuses an invalid one', () => {
    const svc = createAiSettings(freshDb());
    expect(svc.get()).toEqual(DEFAULT_AI_SETTINGS);
    const next = {
      ...DEFAULT_AI_SETTINGS,
      concurrency: 1,
      models: { ...DEFAULT_AI_SETTINGS.models, 'job.analyze': { model: 'opus', effort: 'high' as const } },
    };
    expect(svc.set(next)).toEqual(next);
    expect(svc.get().concurrency).toBe(1);
    expect(svc.forTask('job.analyze')).toEqual({ model: 'opus', effort: 'high', timeoutMs: 180_000 });
    expect(() => svc.set({ ...next, concurrency: 99 })).toThrow();
    expect(svc.get().concurrency).toBe(1);
  });

  it('survives a corrupt stored value', () => {
    const db = freshDb();
    setSetting(db, 'ai', { concurrency: 'lots' });
    expect(createAiSettings(db).get()).toEqual(DEFAULT_AI_SETTINGS);
  });
});
