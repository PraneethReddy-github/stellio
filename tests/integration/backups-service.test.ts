import Database from 'better-sqlite3';
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/main/db/database';
import { acquireScanLock, STALE_LOCK_MS } from '../../src/main/db/repos/discovery';
import { migrate } from '../../src/main/db/migrate';
import { companies } from '../../src/main/db/schema';
import { createBackupsService } from '../../src/main/services/backups/service';
import { createNotificationSettings } from '../../src/main/services/settings/notifications';
import { freshDb, tempDir, track } from '../unit/db/helpers';

function setup() {
  const dir = tempDir();
  const dbFile = join(dir, 'stellio.db');
  const backupsDir = join(dir, 'backups');
  const db = track(openDatabase(dbFile));
  return { dir, dbFile, backupsDir, db };
}

function migrated() {
  const s = setup();
  migrate(s.db.sqlite);
  const svc = createBackupsService({ db: s.db, dbFile: s.dbFile, backupsDir: s.backupsDir });
  return { ...s, svc };
}

const rows = (file: string): number => {
  const d = new Database(file, { readonly: true });
  try {
    return (d.prepare('SELECT count(*) AS n FROM companies').get() as { n: number }).n;
  } finally {
    d.close();
  }
};

describe('backups service', () => {
  it('lists database snapshots and profile/rules copies, newest first; ignores other files', () => {
    const { svc, backupsDir } = migrated();
    mkdirSync(backupsDir, { recursive: true });
    writeFileSync(join(backupsDir, 'profile-2026-11-01T10-00-00-000Z.md'), 'p');
    writeFileSync(join(backupsDir, 'rules-resume.md-2026-11-01T10-00-00-000Z'), 'r');
    writeFileSync(join(backupsDir, 'notes.txt'), 'x');
    const made = svc.create();
    expect(made).toMatchObject({ kind: 'database', restorable: true });
    expect(made.name).toMatch(/^stellio-\d{4}-\d{2}-\d{2}-\d{9}-manual\.db$/);
    const list = svc.list();
    expect(list.map((b) => b.kind).sort()).toEqual(['database', 'profile', 'rules']);
    expect(list.find((b) => b.kind === 'profile')?.restorable).toBe(false);
    expect(list.some((b) => b.name === 'notes.txt')).toBe(false);
  });

  it('refuses to restore while a scan is running, and changes nothing', () => {
    const { svc, db, dbFile, backupsDir } = migrated();
    const backup = svc.create();
    const lock = acquireScanLock(db, 'manual', new Date(), STALE_LOCK_MS);
    expect(lock).not.toBeNull();
    expect(() => svc.restore(backup.name)).toThrow(/scan is running/);
    expect(db.sqlite.open).toBe(true);
    expect(readdirSync(backupsDir).some((f) => f.includes('pre-restore'))).toBe(false);
    expect(existsSync(`${dbFile}.restore-tmp`)).toBe(false);
    // a stale (crashed) scan does not block
    db.sqlite.prepare("UPDATE scan_runs SET started_at = '2020-01-01T00:00:00.000Z'").run();
    expect(() => svc.restore(backup.name)).not.toThrow();
  });

  it('restores: snapshots the current db first, swaps the file, drops stale WAL files', () => {
    const { svc, db, dbFile, backupsDir } = migrated();
    db.orm.insert(companies).values({ name: 'Initech' }).run();
    const backup = svc.create();
    db.orm.insert(companies).values({ name: 'Hooli' }).run();
    const { snapshot } = svc.restore(backup.name);
    expect(db.sqlite.open).toBe(false);
    expect(rows(dbFile)).toBe(1); // the older state
    expect(rows(join(backupsDir, snapshot))).toBe(2); // nothing lost: the newer state is the snapshot
    expect(snapshot).toMatch(/pre-restore\.db$/);
    expect(existsSync(`${dbFile}-wal`)).toBe(false);
    expect(readdirSync(join(dbFile, '..')).filter((f) => f.includes('restore-tmp'))).toEqual([]);
  });

  it('refuses a corrupt file, a non-Stellio sqlite file and a missing one; nothing changes', () => {
    const { svc, db, dbFile, backupsDir } = migrated();
    db.orm.insert(companies).values({ name: 'Initech' }).run();
    mkdirSync(backupsDir, { recursive: true });
    writeFileSync(join(backupsDir, 'stellio-2026-01-01-corrupt.db'), 'garbage, not sqlite');
    const other = new Database(join(backupsDir, 'stellio-2026-01-02-foreign.db'));
    other.exec('create table x (a)');
    other.close();
    for (const name of ['stellio-2026-01-01-corrupt.db', 'stellio-2026-01-02-foreign.db'])
      expect(() => svc.restore(name)).toThrow(/not a usable Stellio backup/);
    expect(() => svc.restore('stellio-2026-01-03-gone.db')).toThrow(/no longer exists/);
    expect(() => svc.restore('../stellio.db')).toThrow(/Only database backups/);
    expect(() => svc.restore('profile-x.md')).toThrow(/Only database backups/);
    expect(db.sqlite.open).toBe(true);
    expect(db.orm.select().from(companies).all()).toHaveLength(1);
    expect(readdirSync(backupsDir).some((f) => f.includes('pre-restore'))).toBe(false);
    expect(existsSync(`${dbFile}.restore-tmp`)).toBe(false);
  });

  it('refuses a backup from a newer schema', () => {
    const { svc, db, backupsDir } = migrated();
    const backup = svc.create();
    const file = join(backupsDir, backup.name);
    const newer = join(backupsDir, 'stellio-2099-01-01-newer.db');
    copyFileSync(file, newer);
    const d = new Database(newer);
    d.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run('9999_future.sql', 'x');
    d.close();
    expect(() => svc.restore('stellio-2099-01-01-newer.db')).toThrow(/newer version/);
    expect(db.sqlite.open).toBe(true);
  });

  it('accepts an older schema (the next start migrates it)', () => {
    const { svc, db, dbFile } = migrated();
    const backup = svc.create();
    const applied = (db.sqlite.prepare('SELECT name FROM _migrations').all() as { name: string }[]).map(
      (r) => r.name,
    );
    // The app now ships one more migration than the backup has.
    const newer = createBackupsService({
      db,
      dbFile,
      backupsDir: svc.dir,
      migrations: Object.fromEntries([...applied, '9999_future.sql'].map((n) => [`./migrations/${n}`, ''])),
    });
    expect(() => newer.restore(backup.name)).not.toThrow();
  });
});

describe('notification settings', () => {
  it('defaults, validates, persists, and survives a broken stored value', () => {
    const db = freshDb();
    const n = createNotificationSettings(db);
    expect(n.get()).toEqual({ digestEnabled: true, digestTime: '09:00', scanEnabled: true });
    expect(() => n.set({ digestEnabled: true, digestTime: '9am', scanEnabled: true })).toThrow();
    n.set({ digestEnabled: false, digestTime: '06:15', scanEnabled: false });
    expect(n.get()).toEqual({ digestEnabled: false, digestTime: '06:15', scanEnabled: false });
    db.sqlite
      .prepare("UPDATE settings_kv SET value_json = '\"junk\"' WHERE key = 'notifications.settings'")
      .run();
    expect(n.get().digestTime).toBe('09:00');
  });
});
