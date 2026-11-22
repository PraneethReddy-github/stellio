// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { AI_TASKS, DEFAULT_AI_SETTINGS } from '@shared/settings/ai';
import { build, toForm } from '@renderer/features/settings/AiSection';
import {
  CUSTOM,
  applyDensity,
  modelChoice,
  modelError,
  parseSeconds,
  readDensity,
  sameSettings,
} from '@renderer/lib/settings';

afterEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.density;
});

describe('model ids', () => {
  it('maps stored ids to presets or Custom', () => {
    expect(modelChoice('claude-sonnet-5-5')).toBe('claude-sonnet-5-5');
    expect(modelChoice('claude-future-9')).toBe(CUSTOM);
  });
  it('accepts what the shared schema accepts and rejects the rest', () => {
    expect(modelError('claude-sonnet-5-5')).toBeNull();
    expect(modelError('  claude-x.1:2[1m] ')).toBeNull();
    for (const bad of ['', '-flag', '--model', 'has space', 'a;b', 'x'.repeat(101)])
      expect(modelError(bad)).not.toBeNull();
  });
});

describe('timeouts', () => {
  it('parses whole seconds in range', () => {
    expect(parseSeconds('180')).toBe(180);
    expect(parseSeconds(' 10 ')).toBe(10);
    for (const bad of ['', '9', '1801', '1.5', 'abc']) expect(parseSeconds(bad)).toBeNull();
  });
});

describe('AI form', () => {
  it('round-trips the defaults', () => {
    const f = toForm(DEFAULT_AI_SETTINGS);
    expect(Object.values(f.custom).some(Boolean)).toBe(false);
    const built = build(f);
    expect(built && sameSettings(built, DEFAULT_AI_SETTINGS)).toBe(true);
  });
  it('treats a non-preset model as custom and trims it', () => {
    const f = toForm({
      ...DEFAULT_AI_SETTINGS,
      models: { ...DEFAULT_AI_SETTINGS.models, 'jd.parse': { model: 'claude-x-1', effort: 'low' } },
    });
    expect(f.custom['jd.parse']).toBe(true);
    f.models['jd.parse'].model = '  claude-y-2 ';
    expect(build(f)?.models['jd.parse'].model).toBe('claude-y-2');
  });
  it('builds nothing while a field is invalid', () => {
    const f = toForm(DEFAULT_AI_SETTINGS);
    f.models[AI_TASKS[0]].model = '--bad';
    expect(build(f)).toBeNull();
    const g = toForm(DEFAULT_AI_SETTINGS);
    g.gen = '5';
    expect(build(g)).toBeNull();
  });
});

describe('density', () => {
  it('applies, persists and reads back', () => {
    expect(readDensity()).toBe('comfortable');
    applyDensity('compact');
    expect(document.documentElement.dataset.density).toBe('compact');
    expect(readDensity()).toBe('compact');
    applyDensity('comfortable');
    expect(document.documentElement.dataset.density).toBeUndefined();
    expect(readDensity()).toBe('comfortable');
  });
});
