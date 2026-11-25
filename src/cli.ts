import fs from 'node:fs';
import path from 'node:path';
import { backupPath, createBackup, listBackups, pruneBackups, restoreBackup, verifyDatabaseFile } from './backup/backup.ts';
import { buildExport, importExport, isWorkspaceEmpty, readExport } from './backup/export.ts';
import { createAuth } from './auth/auth.ts';
import { hasOwner, issueCode } from './auth/setup.ts';
import { ConfigError, loadConfig, type Config } from './config.ts';
import { DatabaseInUseError, openOffline, type DB } from './db/db.ts';
import { migrateWithBackup } from './service.ts';
import { ensureOwnerMember } from './domain/entities.ts';
import { errMessage, setLogLevel } from './util/log.ts';
import { VERSION } from './version.ts';

/**
 * Offline administration. Every command that opens the database needs the service to be stopped:
 * the running service holds an exclusive lock, and the command says so instead of waiting.
 */

const HELP = `workspace-mcp ${VERSION} administration

Usage: node src/cli.ts <command> [options]
In Docker:  docker compose run --rm workspace cli <command> [options]

Stop the service first (docker compose stop workspace); every command opens the database directly.

Commands
  setup-code              Print a new one-time setup code (only before the owner passkey exists).
  recovery-code           Print a one-time code that lets the owner register a new passkey.
  backup                  Write a consistent backup to the backup directory.
  backups                 List backups.
  restore <name|path>     Replace the database with a backup (the current one is saved first).
  verify <path>           Check that a file is an intact workspace database.
  export [file]           Write an export zip (default: ./workspace-export-<date>.zip).
  import <file>           Import an export zip into an empty workspace.
  check-export <file>     Verify an export zip without importing it.
  version                 Print the version.
`;

function out(s: string): void {
  process.stdout.write(s + '\n');
}

async function withDb<T>(config: Config, fn: (db: DB) => Promise<T> | T): Promise<T> {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const db = openOffline(config.dbPath);
  try {
    await migrateWithBackup(db, config, createAuth({ config, db }));
    ensureOwnerMember(db);
    return await fn(db);
  } finally {
    db.close();
  }
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...args] = argv;
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    out(HELP);
    return cmd ? 0 : 1;
  }
  if (cmd === 'version') {
    out(VERSION);
    return 0;
  }
  if (cmd === 'verify') {
    if (!args[0]) throw new ConfigError('verify needs a file path');
    const r = verifyDatabaseFile(args[0]);
    out(r.ok ? 'ok: intact workspace database' : `failed: ${r.reason}`);
    return r.ok ? 0 : 1;
  }
  if (cmd === 'check-export') {
    if (!args[0]) throw new ConfigError('check-export needs a file path');
    const { manifest } = readExport(new Uint8Array(fs.readFileSync(args[0])));
    out(`ok: format v${manifest.format_version}, exported ${manifest.exported_at} by ${manifest.app_version}`);
    for (const [k, v] of Object.entries(manifest.counts)) out(`  ${k}: ${v}`);
    return 0;
  }

  const config = loadConfig();
  setLogLevel('warn');

  switch (cmd) {
    case 'setup-code':
    case 'recovery-code':
      return withDb(config, (db) => {
        const purpose = cmd === 'setup-code' ? 'setup' : 'recovery';
        if (purpose === 'setup' && hasOwner(db)) {
          out('The owner passkey already exists. Use `recovery-code` to add a new passkey.');
          return 1;
        }
        const { code, expiresAt } = issueCode(db, purpose);
        out(`Open ${config.publicUrl}/setup and enter this code (expires ${expiresAt}):\n\n    ${code}\n`);
        out('Start the service again before using it.');
        return 0;
      });
    case 'backup':
      return withDb(config, async (db) => {
        const file = await createBackup(db, config, 'manual');
        pruneBackups(config);
        out(file);
        return 0;
      });
    case 'backups': {
      const list = listBackups(config);
      if (!list.length) out('No backups yet.');
      for (const b of list) out(`${b.name}  ${(b.size / 1024).toFixed(0)} KiB  ${b.reason}`);
      return 0;
    }
    case 'restore': {
      const ref = args[0];
      if (!ref) throw new ConfigError('restore needs a backup name (see `backups`) or a file path');
      const src = fs.existsSync(ref) ? path.resolve(ref) : backupPath(config, ref);
      const { saved } = await restoreBackup(config, src);
      out(`Restored ${path.basename(src)}.${saved ? ` The previous database was saved as ${path.basename(saved)}.` : ''}`);
      out('Start the service; it applies any newer migrations on start.');
      return 0;
    }
    case 'export':
      return withDb(config, (db) => {
        const owner = ensureOwnerMember(db);
        const file = path.resolve(args[0] ?? `workspace-export-${new Date().toISOString().slice(0, 10)}.zip`);
        const { zip, manifest } = buildExport(db, owner.id);
        fs.writeFileSync(file, zip);
        out(`${file}  (${Object.entries(manifest.counts).map(([k, v]) => `${k} ${v}`).join(', ')})`);
        return 0;
      });
    case 'import':
      return withDb(config, async (db) => {
        if (!args[0]) throw new ConfigError('import needs an export zip');
        const owner = ensureOwnerMember(db);
        if (!isWorkspaceEmpty(db, owner.id)) {
          out('The workspace is not empty. Import only goes into an empty workspace.');
          return 1;
        }
        await createBackup(db, config, 'pre-import');
        const r = importExport(db, owner.id, new Uint8Array(fs.readFileSync(args[0])));
        out(`Imported (format v${r.format_version}, exported ${r.exported_at}): ${Object.entries(r.counts).map(([k, v]) => `${k} ${v}`).join(', ')}`);
        return 0;
      });
    default:
      out(`Unknown command: ${cmd}\n`);
      out(HELP);
      return 1;
  }
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((e) => {
    if (e instanceof DatabaseInUseError) process.stderr.write(`${e.message}\n`);
    else if (e instanceof ConfigError) process.stderr.write(`Error: ${e.message}\n`);
    else process.stderr.write(`Error: ${errMessage(e)}\n`);
    process.exit(1);
  });
