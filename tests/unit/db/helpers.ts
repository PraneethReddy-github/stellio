import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { type Db, openDatabase } from '../../../src/main/db/database';
import { migrate } from '../../../src/main/db/migrate';

const dirs: string[] = [];
const dbs: Db[] = [];

afterEach(() => {
  for (const db of dbs.splice(0)) if (db.sqlite.open) db.sqlite.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'stellio-db-'));
  dirs.push(dir);
  return dir;
}

export function track(db: Db): Db {
  dbs.push(db);
  return db;
}

/** Fresh migrated DB in a temp dir. */
export function freshDb(): Db {
  const db = track(openDatabase(join(tempDir(), 'stellio.db')));
  migrate(db.sqlite);
  return db;
}
