import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Config } from '../config.ts';
import { backupTo, openOffline, type DB } from '../db/db.ts';
import { log } from '../util/log.ts';

/**
 * Backups are consistent SQLite snapshots made with SQLite's online backup API, written to
 * BACKUP_DIR as workspace-<timestamp>-<reason>.sqlite. Restore is offline (service stopped).
 */

export type BackupReason = 'scheduled' | 'manual' | 'pre-migration' | 'pre-restore' | 'pre-import';
const NAME = /^workspace-(\d{8}T\d{6}(?:\d{3})?Z)-([a-z-]+)\.sqlite$/;
/** Pre-migration snapshots are kept separately from the rotation so an upgrade can always be undone. */
const KEEP_PRE_MIGRATION = 3;

export interface BackupInfo {
  name: string;
  reason: string;
  created_at: string;
  size: number;
}

function stamp(d = new Date()): string {
  return d.toISOString().replace(/[-:]/g, '').replace('.', '');
}

export async function createBackup(db: DB, config: Config, reason: BackupReason): Promise<string> {
  fs.mkdirSync(config.backupDir, { recursive: true });
  let file = path.join(config.backupDir, `workspace-${stamp()}-${reason}.sqlite`);
  for (let n = 1; fs.existsSync(file); n++) file = path.join(config.backupDir, `workspace-${stamp(new Date(Date.now() + n))}-${reason}.sqlite`);
  await backupTo(db, file);
  log.info('backup written', { file: path.basename(file), reason });
  return file;
}

export function listBackups(config: Config): BackupInfo[] {
  if (!fs.existsSync(config.backupDir)) return [];
  return fs
    .readdirSync(config.backupDir)
    .map((name) => {
      const m = NAME.exec(name);
      if (!m) return null;
      const st = fs.statSync(path.join(config.backupDir, name));
      const s = m[1]!;
      const iso = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}${s.length > 16 ? `.${s.slice(15, 18)}` : ''}Z`;
      return { name, reason: m[2]!, created_at: iso, size: st.size };
    })
    .filter((b): b is BackupInfo => !!b)
    .sort((a, b) => b.name.localeCompare(a.name));
}

/** Keeps the newest BACKUP_KEEP rotating backups and the newest few pre-migration ones. */
export function pruneBackups(config: Config): string[] {
  const list = listBackups(config);
  const removed: string[] = [];
  const rotating = list.filter((b) => b.reason !== 'pre-migration');
  const pre = list.filter((b) => b.reason === 'pre-migration');
  for (const b of [...rotating.slice(config.backupKeep), ...pre.slice(KEEP_PRE_MIGRATION)]) {
    fs.rmSync(path.join(config.backupDir, b.name), { force: true });
    removed.push(b.name);
  }
  if (removed.length) log.info('old backups removed', { count: removed.length });
  return removed;
}

/** Resolves a backup name to a path inside BACKUP_DIR, rejecting anything else. */
export function backupPath(config: Config, name: string): string {
  if (!NAME.test(name)) throw new Error(`Not a backup name: ${name}`);
  const p = path.join(config.backupDir, name);
  if (!fs.existsSync(p)) throw new Error(`Backup not found: ${name}`);
  return p;
}

/** Opens a candidate file read-only and checks that it is an intact workspace database. */
export function verifyDatabaseFile(file: string): { ok: true } | { ok: false; reason: string } {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const r = db.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[];
    if (r.length !== 1 || r[0]!.integrity_check !== 'ok') return { ok: false, reason: `integrity check failed: ${r.map((x) => x.integrity_check).join('; ').slice(0, 300)}` };
    const t = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name IN ('app_migration','member')").all();
    if (t.length !== 2) return { ok: false, reason: 'not a workspace database' };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  } finally {
    db?.close();
  }
}

/**
 * Replaces the live database with a backup. The service must be stopped. The current database is
 * first saved as a pre-restore backup so the restore itself can be undone.
 */
export async function restoreBackup(config: Config, source: string): Promise<{ saved: string | null }> {
  const check = verifyDatabaseFile(source);
  if (!check.ok) throw new Error(`Refusing to restore: ${check.reason}`);
  let saved: string | null = null;
  if (fs.existsSync(config.dbPath)) {
    // Fails with DatabaseInUseError while the service holds the database.
    const cur = openOffline(config.dbPath);
    try {
      saved = await createBackup(cur, config, 'pre-restore');
    } finally {
      cur.close();
    }
  }
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  const tmp = `${config.dbPath}.restoring`;
  fs.copyFileSync(source, tmp);
  for (const ext of ['-wal', '-shm']) fs.rmSync(config.dbPath + ext, { force: true });
  fs.renameSync(tmp, config.dbPath);
  return { saved };
}
