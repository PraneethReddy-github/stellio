import { eq } from 'drizzle-orm';
import type { z } from 'zod';
import type { Db } from '../database';
import { settingsKv } from '../schema';

/** Returns the stored value validated against `schema`, or undefined if unset. Throws if the stored value is invalid. */
export function getSetting<S extends z.ZodType>(db: Db, key: string, schema: S): z.output<S> | undefined {
  const row = db.orm.select().from(settingsKv).where(eq(settingsKv.key, key)).get();
  return row === undefined ? undefined : schema.parse(row.valueJson);
}

export function setSetting(db: Db, key: string, value: unknown): void {
  db.orm
    .insert(settingsKv)
    .values({ key, valueJson: value })
    .onConflictDoUpdate({
      target: settingsKv.key,
      set: { valueJson: value, updatedAt: new Date().toISOString() },
    })
    .run();
}
