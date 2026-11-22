import { z } from 'zod';
import {
  DEFAULT_DISCOVERY_SETTINGS,
  DEFAULT_SCHEDULE,
  DiscoverySettingsSchema,
  ScheduleSchema,
  type DiscoverySettings,
  type DiscoverySource,
  type Schedule,
} from '@shared/discovery/schemas';
import type { Db } from '../../db/database';
import { getSetting, setSetting } from '../../db/repos/settings';

const SourceStateSchema = z.object({
  enabled: z.boolean().optional(),
  lastRunAt: z.string().nullable().optional(),
  lastSuccessAt: z.string().nullable().optional(),
  lastError: z.string().nullable().optional(),
});
export type SourceState = z.infer<typeof SourceStateSchema>;
const SourcesSchema = z.record(z.string(), SourceStateSchema);
const Counter = z.object({ day: z.string(), n: z.number().int() });
const WebDays = z.record(z.string(), z.string());

/** Web search costs subscription usage and reads the open web: it starts off. */
const DEFAULT_OFF: readonly DiscoverySource[] = ['websearch'];

/** Everything the discovery feature remembers between runs, in `settings_kv` (no secrets). */
export function createDiscoveryState(db: Db) {
  const read = <S extends z.ZodType>(key: string, schema: S): z.output<S> | undefined => {
    try {
      return getSetting(db, key, schema);
    } catch {
      return undefined; // a broken stored value falls back to defaults
    }
  };
  const sources = (): Record<string, SourceState> => read('discovery.sources', SourcesSchema) ?? {};
  return {
    settings(): DiscoverySettings {
      const stored = read('discovery.settings', z.unknown());
      const merged = DiscoverySettingsSchema.safeParse({
        ...DEFAULT_DISCOVERY_SETTINGS,
        ...(typeof stored === 'object' && stored !== null ? stored : {}),
      });
      return merged.success ? merged.data : DEFAULT_DISCOVERY_SETTINGS;
    },
    setSettings(v: unknown): DiscoverySettings {
      const parsed = DiscoverySettingsSchema.parse(v);
      setSetting(db, 'discovery.settings', parsed);
      return parsed;
    },
    schedule: (): Schedule => read('discovery.schedule', ScheduleSchema) ?? DEFAULT_SCHEDULE,
    setSchedule(v: unknown): Schedule {
      const parsed = ScheduleSchema.parse(v);
      setSetting(db, 'discovery.schedule', parsed);
      return parsed;
    },
    source: (id: string): SourceState => sources()[id] ?? {},
    enabled: (id: DiscoverySource): boolean => sources()[id]?.enabled ?? !DEFAULT_OFF.includes(id),
    patchSource(id: string, patch: SourceState): void {
      const all = sources();
      setSetting(db, 'discovery.sources', { ...all, [id]: { ...all[id], ...patch } });
    },
    /** Full analyses started by scans today (the daily cap). */
    analyzedToday(day: string): number {
      const c = read('discovery.analyzed', Counter);
      return c?.day === day ? c.n : 0;
    },
    bumpAnalyzed(day: string): void {
      setSetting(db, 'discovery.analyzed', { day, n: this.analyzedToday(day) + 1 });
    },
    webSearchDay: (profileId: string): string | undefined =>
      read('discovery.websearch', WebDays)?.[profileId],
    setWebSearchDay(profileId: string, day: string): void {
      setSetting(db, 'discovery.websearch', { ...read('discovery.websearch', WebDays), [profileId]: day });
    },
  };
}
export type DiscoveryState = ReturnType<typeof createDiscoveryState>;
