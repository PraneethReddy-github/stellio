import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AiSettingsSchema, TaskModelSchema, type AiSettings } from '@shared/settings/ai';
import { call } from './ipc';

const AI_KEY = ['settings', 'ai'] as const;

export function useAiSettings() {
  return useQuery({
    queryKey: AI_KEY,
    queryFn: () => call('settings:getAi', undefined),
    refetchOnMount: 'always',
  });
}

export function useSetAi() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (value: AiSettings) => call('settings:setAi', value),
    onSuccess: (saved) => qc.setQueryData(AI_KEY, saved),
  });
}

export function useAiStatus() {
  return useQuery({
    queryKey: ['ai', 'status'],
    queryFn: () => call('ai:status', undefined),
    refetchOnMount: 'always',
  });
}

export function useAppInfo() {
  return useQuery({
    queryKey: ['app', 'info'],
    queryFn: () => call('app:getInfo', undefined),
    staleTime: Infinity,
  });
}

export const MODEL_PRESETS = ['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5-5'] as const;
export const CUSTOM = 'custom';

/** The Select value for a stored model id. */
export const modelChoice = (model: string): string =>
  (MODEL_PRESETS as readonly string[]).includes(model) ? model : CUSTOM;

/** Error text for a custom model id, or null when the shared schema accepts it. */
export function modelError(model: string): string | null {
  const r = TaskModelSchema.shape.model.safeParse(model.trim());
  return r.success ? null : 'Use letters, digits and . _ : - only, starting with a letter or digit.';
}

/** Whole seconds from text, or null when it is not a number the schema would accept. */
export function parseSeconds(text: string): number | null {
  const n = Number(text.trim());
  const r = AiSettingsSchema.shape.timeoutsSec.shape.default.safeParse(n);
  return text.trim() !== '' && r.success ? n : null;
}

export const SECONDS_RANGE = 'Whole seconds from 10 to 1800.';

/** Same value, regardless of key order. */
export const sameSettings = (a: AiSettings, b: AiSettings): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

// ---- Density (per-viewer convenience, so localStorage) ----
export type Density = 'comfortable' | 'compact';
const DENSITY_KEY = 'stellio.density';

export function readDensity(): Density {
  try {
    return localStorage.getItem(DENSITY_KEY) === 'compact' ? 'compact' : 'comfortable';
  } catch {
    return 'comfortable';
  }
}

export function applyDensity(d: Density): void {
  if (d === 'compact') document.documentElement.dataset.density = 'compact';
  else delete document.documentElement.dataset.density;
  try {
    localStorage.setItem(DENSITY_KEY, d);
  } catch {
    // Not persisted; the choice still applies for this session.
  }
}
