import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { migrate, pendingMigrations } from './migrate';
import * as schema from './schema';

export interface Db {
  sqlite: Database.Database;
  orm: BetterSQLite3Database<typeof schema>;
}

export function openDatabase(file: string): Db {
  const sqlite = new Database(file);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('synchronous = NORMAL');
  return { sqlite, orm: drizzle(sqlite, { schema }) };
}

const DAILY_NAME = /^stellio-\d{4}-\d{2}-\d{2}\.db$/;
/** `stellio-DATE-HHMMSS[mmm][-N]-label.db`; the label is the part a prune groups by. */
const LABELLED_NAME = /^stellio-\d{4}-\d{2}-\d{2}-\d{6}(?:\d{3})?(?:-\d+)?-([\w-]+)\.db$/;

interface BackupOptions {
  /** How many unlabelled daily backups to keep. */
  keep?: number;
  /** How many labelled backups (pre-migrate, pre-restore, manual) to keep, each label counted on its own. */
  keepLabelled?: number;
  label?: string;
  /** Injectable clock for tests. */
  now?: Date;
}

/**
 * `VACUUM INTO` a dated file in `backupsDir`, then prune. Dailies and each label are pruned separately, so a
 * burst of manual backups can never push out the daily history or the pre-migrate snapshot. Returns the file path.
 */
export function backupDatabase(
  sqlite: Database.Database,
  backupsDir: string,
  { keep = 14, keepLabelled = 10, label, now = new Date() }: BackupOptions = {},
): string {
  mkdirSync(backupsDir, { recursive: true });
  const iso = now.toISOString();
  const date = iso.slice(0, 10);
  // Labelled backups are true snapshots: timestamped to the millisecond, never overwritten (VACUUM INTO refuses to).
  const time = `${iso.slice(11, 19).replaceAll(':', '')}${iso.slice(20, 23)}`;
  let file = join(backupsDir, `stellio-${date}${label ? `-${time}-${label}` : ''}.db`);
  for (let n = 2; label && existsSync(file); n++)
    file = join(backupsDir, `stellio-${date}-${time}-${n}-${label}.db`);
  if (!label) rmSync(file, { force: true }); // the daily backup is replaced
  sqlite.prepare('VACUUM INTO ?').run(file);
  // Names start with the ISO date, so name order is age order.
  const names = readdirSync(backupsDir).sort();
  const groups = new Map<string, string[]>([['', names.filter((f) => DAILY_NAME.test(f))]]);
  for (const f of names) {
    const l = LABELLED_NAME.exec(f)?.[1];
    if (l !== undefined) groups.set(l, [...(groups.get(l) ?? []), f]);
  }
  for (const [l, list] of groups)
    for (const old of list.slice(0, Math.max(0, list.length - (l === '' ? keep : keepLabelled))))
      rmSync(join(backupsDir, old));
  return file;
}

/** Backs up unless today's unlabeled backup already exists. Returns the new file, or null. */
export function dailyBackupIfDue(
  sqlite: Database.Database,
  backupsDir: string,
  now = new Date(),
): string | null {
  if (existsSync(join(backupsDir, `stellio-${now.toISOString().slice(0, 10)}.db`))) return null;
  return backupDatabase(sqlite, backupsDir, { now });
}

/** Opens `file`, backs it up if an existing DB has pending migrations, migrates, and returns the handle. */
export function prepareDatabase(file: string, backupsDir: string): Db {
  const existing = existsSync(file) && statSync(file).size > 0;
  const db = openDatabase(file);
  try {
    if (existing && pendingMigrations(db.sqlite).length > 0) {
      backupDatabase(db.sqlite, backupsDir, { label: 'pre-migrate' });
    }
    migrate(db.sqlite);
  } catch (error) {
    db.sqlite.close();
    throw error;
  }
  return db;
}
