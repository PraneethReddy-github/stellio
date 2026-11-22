import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  backupDatabase,
  dailyBackupIfDue,
  openDatabase,
  prepareDatabase,
} from '../../../src/main/db/database';
import { migrate } from '../../../src/main/db/migrate';
import { companies } from '../../../src/main/db/schema';
import { freshDb, tempDir, track } from './helpers';

const day = (d: string) => new Date(`${d}T12:00:00Z`);

describe('openDatabase', () => {
  it('sets the pragmas', () => {
    const db = track(openDatabase(join(tempDir(), 'a.db')));
    expect(db.sqlite.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.sqlite.pragma('busy_timeout', { simple: true })).toBe(5000);
    expect(db.sqlite.pragma('synchronous', { simple: true })).toBe(1); // NORMAL
  });
});

describe('backupDatabase', () => {
  it('writes a restorable stellio-YYYY-MM-DD[-label].db', () => {
    const db = freshDb();
    db.orm.insert(companies).values({ name: 'Initech' }).run();
    const dir = join(tempDir(), 'backups');
    const file = backupDatabase(db.sqlite, dir, { now: day('2026-11-19'), label: 'pre-migrate' });
    expect(file).toBe(join(dir, 'stellio-2026-11-19-120000000-pre-migrate.db'));
    const copy = track(openDatabase(file));
    expect(copy.orm.select().from(companies).all()).toHaveLength(1);
  });

  it('overwrites a same-day backup', () => {
    const db = freshDb();
    const dir = tempDir();
    backupDatabase(db.sqlite, dir, { now: day('2026-11-19') });
    expect(() => backupDatabase(db.sqlite, dir, { now: day('2026-11-19') })).not.toThrow();
  });

  it('a second labelled backup the same day keeps the first snapshot', () => {
    const db = freshDb();
    const dir = tempDir();
    const at = (t: string) => new Date(`2026-11-19T${t}Z`);
    const a = backupDatabase(db.sqlite, dir, { now: at('09:00:00'), label: 'pre-migrate' });
    db.orm.insert(companies).values({ name: 'Initech' }).run();
    const b = backupDatabase(db.sqlite, dir, { now: at('17:30:05'), label: 'pre-migrate' });
    expect(a).not.toBe(b);
    expect(b).toBe(join(dir, 'stellio-2026-11-19-173005000-pre-migrate.db'));
    expect(readdirSync(dir)).toHaveLength(2);
    expect(track(openDatabase(a)).orm.select().from(companies).all()).toHaveLength(0);
  });

  it('prunes the oldest beyond keep and ignores foreign files', () => {
    const db = freshDb();
    const dir = tempDir();
    writeFileSync(join(dir, 'notes.txt'), 'keep me');
    for (const d of ['2026-11-01', '2026-11-02', '2026-11-03'])
      backupDatabase(db.sqlite, dir, { now: day(d), keep: 2 });
    expect(readdirSync(dir).sort()).toEqual(['notes.txt', 'stellio-2026-11-02.db', 'stellio-2026-11-03.db']);
  });
});

describe('backup pruning', () => {
  const at = (n: number) => new Date(Date.UTC(2026, 10, 19, 9, 0, 0, n));

  it('labelled backups in the same millisecond get a counter instead of colliding', () => {
    const db = freshDb();
    const dir = tempDir();
    const a = backupDatabase(db.sqlite, dir, { now: at(5), label: 'manual' });
    const b = backupDatabase(db.sqlite, dir, { now: at(5), label: 'manual' });
    expect(a.endsWith('-090000005-manual.db')).toBe(true);
    expect(b.endsWith('-090000005-2-manual.db')).toBe(true);
    expect(readdirSync(dir)).toHaveLength(2);
  });

  it('manual backups never push out dailies, and each label has its own cap', () => {
    const db = freshDb();
    const dir = tempDir();
    for (const d of ['2026-11-01', '2026-11-02']) backupDatabase(db.sqlite, dir, { now: day(d), keep: 2 });
    backupDatabase(db.sqlite, dir, { now: at(0), label: 'pre-migrate', keepLabelled: 2 });
    for (let i = 1; i <= 5; i++)
      backupDatabase(db.sqlite, dir, { now: at(i), label: 'manual', keepLabelled: 2 });
    const names = readdirSync(dir).sort();
    expect(names.filter((n) => /^stellio-[\d-]+\.db$/.test(n))).toEqual([
      'stellio-2026-11-01.db',
      'stellio-2026-11-02.db',
    ]);
    expect(names.filter((n) => n.endsWith('-manual.db'))).toEqual([
      'stellio-2026-11-19-090000004-manual.db',
      'stellio-2026-11-19-090000005-manual.db',
    ]);
    expect(names.filter((n) => n.endsWith('-pre-migrate.db'))).toHaveLength(1);
  });

  it('a daily backup prunes only dailies', () => {
    const db = freshDb();
    const dir = tempDir();
    backupDatabase(db.sqlite, dir, { now: at(0), label: 'pre-restore', keepLabelled: 1 });
    for (const d of ['2026-11-01', '2026-11-02', '2026-11-03'])
      backupDatabase(db.sqlite, dir, { now: day(d), keep: 1, keepLabelled: 1 });
    expect(readdirSync(dir).sort()).toEqual([
      'stellio-2026-11-03.db',
      'stellio-2026-11-19-090000000-pre-restore.db',
    ]);
  });
});

describe('dailyBackupIfDue', () => {
  it('backs up once per day', () => {
    const db = freshDb();
    const dir = tempDir();
    expect(dailyBackupIfDue(db.sqlite, dir, day('2026-11-19'))).not.toBeNull();
    expect(dailyBackupIfDue(db.sqlite, dir, day('2026-11-19'))).toBeNull();
    expect(dailyBackupIfDue(db.sqlite, dir, day('2026-11-20'))).not.toBeNull();
  });
});

describe('prepareDatabase', () => {
  it('migrates a new DB without a backup', () => {
    const base = tempDir();
    track(prepareDatabase(join(base, 'stellio.db'), join(base, 'backups')));
    expect(existsSync(join(base, 'backups'))).toBe(false);
  });

  it('backs up an existing DB before applying pending migrations', () => {
    const base = tempDir();
    const file = join(base, 'stellio.db');
    const backups = join(base, 'backups');
    // Existing DB at an older schema: only the first migration applied.
    const old = openDatabase(file);
    migrate(old.sqlite, { './0000_init.sql': readFileSync('src/main/db/migrations/0000_init.sql', 'utf8') });
    old.sqlite.close();
    track(prepareDatabase(file, backups));
    const files = readdirSync(backups);
    expect(files).toHaveLength(1);
    expect(files).toEqual([expect.stringMatching(/^stellio-\d{4}-\d{2}-\d{2}-\d{9}-pre-migrate\.db$/)]);
    expect(statSync(join(backups, ...files)).size).toBeGreaterThan(0);
  });

  it('does not back up when nothing is pending', () => {
    const base = tempDir();
    const file = join(base, 'stellio.db');
    track(prepareDatabase(file, join(base, 'backups'))).sqlite.close();
    track(prepareDatabase(file, join(base, 'backups')));
    expect(existsSync(join(base, 'backups'))).toBe(false);
  });
});
