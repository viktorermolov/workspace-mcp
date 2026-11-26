import { backup, DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { migrations } from './schema.ts';
import { log } from '../util/log.ts';

export type DB = DatabaseSync;
export type Row = Record<string, unknown>;

/**
 * Opens the database. The service opens it with `exclusive` so it holds the file lock for its
 * whole lifetime: offline tools (restore, import) then cannot touch a database that is in use.
 */
export function openDatabase(file: string, opts: { exclusive?: boolean } = {}): DB {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  if (opts.exclusive) db.exec('PRAGMA locking_mode = EXCLUSIVE');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA synchronous = NORMAL');
  return db;
}

let txDepth = 0;
/**
 * Runs fn inside one IMMEDIATE transaction (a write lock is taken up front, so concurrent
 * writers are serialized). A change and its log event are always written through this.
 * Nested calls join the outer transaction.
 */
export function tx<T>(db: DB, fn: () => T): T {
  if (txDepth > 0) {
    txDepth++;
    try {
      return fn();
    } finally {
      txDepth--;
    }
  }
  db.exec('BEGIN IMMEDIATE');
  txDepth = 1;
  try {
    const out = fn();
    if (out instanceof Promise) throw new Error('tx callback must be synchronous');
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    txDepth = 0;
  }
}

export function all<T = Row>(db: DB, sql: string, ...params: unknown[]): T[] {
  return db.prepare(sql).all(...(params as never[])) as T[];
}
export function get<T = Row>(db: DB, sql: string, ...params: unknown[]): T | undefined {
  return db.prepare(sql).get(...(params as never[])) as T | undefined;
}
export function run(db: DB, sql: string, ...params: unknown[]) {
  return db.prepare(sql).run(...(params as never[]));
}

function ensureMigrationTable(db: DB): void {
  db.exec('CREATE TABLE IF NOT EXISTS app_migration (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
}

/** Thrown when the database was migrated by a newer release than the one running. */
export class NewerSchemaError extends Error {}

export function pendingAppMigrations(db: DB): typeof migrations {
  ensureMigrationTable(db);
  const applied = all<{ id: number }>(db, 'SELECT id FROM app_migration').map((r) => r.id);
  const known = new Set(migrations.map((m) => m.id));
  const unknown = applied.filter((id) => !known.has(id));
  if (unknown.length) {
    throw new NewerSchemaError(
      `The database was upgraded by a newer release (migration ${Math.max(...unknown)}). Run that release again, or restore the pre-migration backup made before the upgrade (see docs/backups.md).`,
    );
  }
  const done = new Set(applied);
  return migrations.filter((m) => !done.has(m.id));
}

export function runAppMigrations(db: DB): number {
  const pending = pendingAppMigrations(db);
  for (const m of pending) {
    tx(db, () => {
      db.exec(m.sql);
      run(db, 'INSERT INTO app_migration (id, name, applied_at) VALUES (?, ?, ?)', m.id, m.name, new Date().toISOString());
    });
    log.info('migration applied', { id: m.id, name: m.name });
  }
  return pending.length;
}

/** Consistent online backup through SQLite's backup API (not a file copy of the live database). */
export async function backupTo(db: DB, dest: string): Promise<void> {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.partial`;
  fs.rmSync(tmp, { force: true });
  try {
    await backup(db, tmp);
    fs.renameSync(tmp, dest);
  } catch (e) {
    // Leave nothing behind (a full disk would fill up with partial copies), and report the original error.
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // The original error matters more than a failed cleanup.
    }
    throw e;
  }
}

export function hasUserTables(db: DB): boolean {
  const r = get<{ n: number }>(db, "SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
  return (r?.n ?? 0) > 0;
}

export function now(): string {
  return new Date().toISOString();
}

/** Thrown by offline tools when the service still holds the database. */
export class DatabaseInUseError extends Error {}

/** Opens the database for an offline command, failing clearly if the service is running. */
export function openOffline(file: string): DB {
  const inUse = () => new DatabaseInUseError('The database is in use. Stop the service first (for example `docker compose stop workspace`).');
  const isLock = (e: unknown) => {
    const err = e as { errcode?: number; message?: string };
    return err.errcode === 5 || err.errcode === 6 || /locked|busy/i.test(String(err.message));
  };
  let db: DB;
  try {
    db = openDatabase(file);
  } catch (e) {
    if (isLock(e)) throw inUse();
    throw e;
  }
  try {
    db.exec('PRAGMA busy_timeout = 1500');
    db.exec('BEGIN IMMEDIATE');
    db.exec('ROLLBACK');
    db.exec('PRAGMA busy_timeout = 5000');
  } catch (e) {
    db.close();
    if (isLock(e)) throw inUse();
    throw e;
  }
  return db;
}
