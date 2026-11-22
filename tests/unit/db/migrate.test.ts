import Database from 'better-sqlite3';
import { getTableColumns, getTableName, is } from 'drizzle-orm';
import { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';
import { migrate } from '../../../src/main/db/migrate';
import * as schema from '../../../src/main/db/schema';
import { freshDb } from './helpers';

const tables = Object.values<unknown>(schema).flatMap((v) => (is(v, SQLiteTable) ? [v] : []));

describe('migrate', () => {
  it('applies every migration on an empty DB, in name order', () => {
    const db = freshDb();
    const rows = db.sqlite.prepare('SELECT name FROM _migrations ORDER BY name').all() as { name: string }[];
    expect(rows.map((r) => r.name)).toEqual([
      '0000_init.sql',
      '0001_jobs_fts.sql',
      '0002_referrals.sql',
      '0003_analyses_job_idx.sql',
    ]);
  });

  it('is idempotent and returns only newly applied names', () => {
    const db = freshDb();
    expect(migrate(db.sqlite)).toEqual([]);
  });

  it('returns applied names on first run', () => {
    const sqlite = new Database(':memory:');
    const applied = migrate(sqlite, {
      './m/0001_b.sql': 'CREATE TABLE b (x)',
      './m/0000_a.sql': 'CREATE TABLE a (x)',
    });
    expect(applied).toEqual(['0000_a.sql', '0001_b.sql']);
    sqlite.close();
  });

  it('rolls back a failing migration and keeps earlier ones', () => {
    const db = freshDb();
    const bad = {
      './m/0000_init.sql': '',
      './m/0001_jobs_fts.sql': '',
      './m/0002_ok.sql': 'CREATE TABLE ok (x)',
      './m/0003_bad.sql': 'CREATE TABLE half (x); CREATE TABLE half (x);',
    };
    expect(() => migrate(db.sqlite, bad)).toThrow();
    const names = (db.sqlite.prepare('SELECT name FROM _migrations').all() as { name: string }[]).map(
      (r) => r.name,
    );
    expect(names).toContain('0002_ok.sql');
    expect(names).not.toContain('0003_bad.sql');
    expect(db.sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name = 'half'").get()).toBeUndefined();
  });

  it('creates every Drizzle table with exactly the schema columns', () => {
    const db = freshDb();
    for (const table of tables) {
      const cols = db.sqlite.prepare(`PRAGMA table_info(${getTableName(table)})`).all() as { name: string }[];
      const expected = Object.values(getTableColumns(table)).map((c) => c.name);
      expect(cols.map((c) => c.name).sort(), getTableName(table)).toEqual(expected.sort());
    }
  });

  it('creates the documented unique constraints and indexes', () => {
    const db = freshDb();
    const idx = (
      db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]
    ).map((r) => r.name);
    expect(idx).toEqual(
      expect.arrayContaining([
        'job_sources_source_external_id_uq',
        'applications_job_id_unique',
        'jobs_dedupe_key_uq',
        'jobs_state_idx',
        'application_events_application_id_at_idx',
        'ai_runs_started_at_idx',
        'people_dedupe_key_uq',
        'referral_requests_job_id_idx',
      ]),
    );
  });
});
