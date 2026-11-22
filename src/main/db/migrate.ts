import type Database from 'better-sqlite3';

/** Raw SQL keyed by glob path. Bundled so the files ship inside the app. */
const bundled = import.meta.glob('./migrations/*.sql', { query: '?raw', import: 'default', eager: true });

type Migrations = Record<string, unknown>;

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/** Migration names not yet recorded in `_migrations`, in name order. */
export function pendingMigrations(sqlite: Database.Database, migrations: Migrations = bundled): string[] {
  sqlite.exec('CREATE TABLE IF NOT EXISTS _migrations (name text primary key, applied_at text)');
  const done = new Set(
    (sqlite.prepare('SELECT name FROM _migrations').all() as { name: string }[]).map((r) => r.name),
  );
  return Object.keys(migrations)
    .map(baseName)
    .filter((name) => !done.has(name))
    .sort();
}

/** Names recorded as applied in `sqlite` that this app does not ship: the file comes from a newer version. */
export function unknownMigrations(sqlite: Database.Database, migrations: Migrations = bundled): string[] {
  const known = new Set(Object.keys(migrations).map(baseName));
  return (sqlite.prepare('SELECT name FROM _migrations').all() as { name: string }[])
    .map((r) => r.name)
    .filter((name) => !known.has(name));
}

/** Applies pending migrations in name order, one transaction each. Returns the applied names. */
export function migrate(sqlite: Database.Database, migrations: Migrations = bundled): string[] {
  const byName = new Map(Object.entries(migrations).map(([path, sql]) => [baseName(path), String(sql)]));
  const pending = pendingMigrations(sqlite, migrations); // also creates `_migrations`
  const record = sqlite.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)');
  const applied: string[] = [];
  for (const name of pending) {
    sqlite.transaction(() => {
      sqlite.exec(byName.get(name) ?? '');
      record.run(name, new Date().toISOString());
    })();
    applied.push(name);
  }
  return applied;
}
