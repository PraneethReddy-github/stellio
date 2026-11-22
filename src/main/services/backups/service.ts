import Database from 'better-sqlite3';
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { BACKUP_KINDS, DB_BACKUP_NAME, type BackupEntry } from '@shared/backups';
import { backupDatabase, type Db } from '../../db/database';
import { unknownMigrations } from '../../db/migrate';
import { scanIsRunning } from '../../db/repos/discovery';
import { UserError } from '../../ipc/dispatch';

type Kind = (typeof BACKUP_KINDS)[number];

/** Copies made when a profile or rules file is replaced without git (see the profile and rules services). */
function kindOf(name: string): Kind | null {
  if (DB_BACKUP_NAME.test(name)) return 'database';
  if (/^profile-.+\.md$/.test(name)) return 'profile';
  if (/^(rules|templates)-.+/.test(name)) return 'rules';
  return null;
}

const NOT_USABLE = 'That file is not a usable Stellio backup. Nothing was changed.';

/**
 * Opens a copy of a backup read-only and checks that it is a whole, readable Stellio database that this
 * version understands. Throws a UserError otherwise.
 */
function validate(file: string, migrations?: Record<string, unknown>): void {
  let probe: Database.Database | undefined;
  try {
    probe = new Database(file, { readonly: true, fileMustExist: true });
    if (probe.pragma('integrity_check', { simple: true }) !== 'ok') throw new UserError(NOT_USABLE);
    if (!probe.prepare("SELECT 1 FROM sqlite_master WHERE name = '_migrations'").get())
      throw new UserError(NOT_USABLE);
    if (unknownMigrations(probe, migrations).length > 0)
      throw new UserError(
        'That backup was made by a newer version of Stellio. Update Stellio, then restore it. Nothing was changed.',
      );
  } catch (e) {
    throw e instanceof UserError ? e : new UserError(NOT_USABLE);
  } finally {
    probe?.close();
  }
}

export function createBackupsService(deps: {
  db: Db;
  /** The live database file. */
  dbFile: string;
  backupsDir: string;
  /** Test seam: the migrations this app ships. */
  migrations?: Record<string, unknown>;
}) {
  const { db, dbFile, backupsDir } = deps;

  function list(): BackupEntry[] {
    if (!existsSync(backupsDir)) return [];
    const entries: BackupEntry[] = [];
    for (const name of readdirSync(backupsDir)) {
      const kind = kindOf(name);
      if (!kind) continue;
      const st = statSync(join(backupsDir, name));
      if (!st.isFile()) continue;
      entries.push({
        name,
        kind,
        createdAt: st.mtime.toISOString(),
        sizeBytes: st.size,
        restorable: kind === 'database',
      });
    }
    return entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.name.localeCompare(a.name));
  }

  function create(now = new Date()): BackupEntry {
    const file = backupDatabase(db.sqlite, backupsDir, { label: 'manual', now });
    const name = file.slice(backupsDir.length + 1);
    const entry = list().find((e) => e.name === name);
    if (!entry) throw new UserError('The backup was written but could not be read back.');
    return entry;
  }

  /**
   * Replaces the live database with a backup. Never loses data:
   * 1. the backup is copied to a temp file and validated (integrity, Stellio schema, not newer than this app);
   * 2. the current database is snapshotted (`pre-restore`);
   * 3. only then the live connection is closed and the temp file renamed over it (same folder: atomic).
   * A refusal in 1 or 2 changes nothing. After success the connection is closed: the caller must restart the app.
   */
  function restore(name: string): { snapshot: string } {
    if (!DB_BACKUP_NAME.test(name)) throw new UserError('Only database backups can be restored.');
    const source = join(backupsDir, name);
    if (!existsSync(source)) throw new UserError('That backup no longer exists.');
    // A scan writes to this database; swapping it underneath would lose or corrupt its results.
    if (scanIsRunning(db, new Date()))
      throw new UserError('A scan is running. Wait for it to finish (or cancel it), then restore.');
    const temp = `${dbFile}.restore-tmp`;
    try {
      copyFileSync(source, temp);
      validate(temp, deps.migrations);
      mkdirSync(backupsDir, { recursive: true });
      const snapshot = backupDatabase(db.sqlite, backupsDir, { label: 'pre-restore' });
      db.sqlite.close(); // checkpoints the WAL
      rmSync(`${dbFile}-wal`, { force: true });
      rmSync(`${dbFile}-shm`, { force: true });
      renameSync(temp, dbFile);
      return { snapshot: snapshot.slice(backupsDir.length + 1) };
    } finally {
      for (const f of [temp, `${temp}-wal`, `${temp}-shm`]) rmSync(f, { force: true });
    }
  }

  return { list, create, restore, dir: backupsDir };
}
export type BackupsService = ReturnType<typeof createBackupsService>;
