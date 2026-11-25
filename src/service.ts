import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { serve, type ServerType } from '@hono/node-server';
import type { ClientMetadataResourceFetch } from '@better-auth/oauth-provider';
import { createAuth, migrateAuth, pendingAuthMigrations, type Auth } from './auth/auth.ts';
import { expireUnusedClients } from './auth/connections.ts';
import { hasOwner, issueCode } from './auth/setup.ts';
import { createBackup, pruneBackups } from './backup/backup.ts';
import type { Config } from './config.ts';
import { hasUserTables, openDatabase, pendingAppMigrations, runAppMigrations, type DB } from './db/db.ts';
import { clearEventHooks } from './domain/core.ts';
import { ensureOwnerMember } from './domain/entities.ts';
import { GithubSync } from './github/sync.ts';
import { errMessage, log } from './util/log.ts';
import { createApp } from './web/app.ts';
import { WebhookDispatcher } from './webhooks/dispatcher.ts';
import { VERSION } from './version.ts';

export interface ServiceOptions {
  /** Tests inject a fake CIMD fetcher (loopback client ids are not fetchable by the real one). */
  cimdFetch?: ClientMetadataResourceFetch;
  /** Background jobs (backups, sync, deliveries, client expiry). Off in most tests. */
  jobs?: boolean;
  /** Print the setup code to the log when there is no owner (default true). */
  announceSetupCode?: boolean;
  fetchImpl?: typeof fetch;
  /** Hold the database lock for the service's lifetime (default true). */
  exclusive?: boolean;
}

export interface Service {
  config: Config;
  db: DB;
  auth: Auth;
  app: ReturnType<typeof createApp>['app'];
  webhooks: WebhookDispatcher;
  github: GithubSync;
  listen(): Promise<{ url: string; port: number }>;
  close(): Promise<void>;
}

/**
 * Applies pending app and auth migrations. A database that already holds data is backed up first
 * (reason "pre-migration"); a brand-new one is not. Shared by the service and the offline CLI.
 */
export async function migrateWithBackup(db: DB, config: Config, auth: ReturnType<typeof createAuth>): Promise<void> {
  // Decide before anything creates tables: a brand-new database needs no backup.
  const existing = hasUserTables(db) && hasData(db);
  const pendingApp = pendingAppMigrations(db).length;
  const pendingAuth = await pendingAuthMigrations(auth);
  if ((pendingApp || pendingAuth) && existing) {
    const file = await createBackup(db, config, 'pre-migration');
    log.info('backup before migration', { file: path.basename(file), app_migrations: pendingApp, auth_migrations: pendingAuth });
  }
  runAppMigrations(db);
  const authChanges = await migrateAuth(auth);
  if (authChanges) log.info('auth schema migrated', { changes: authChanges });
}

/** Opens the database, migrates (with a backup first when data exists), and wires the HTTP app. */
export async function createService(config: Config, opts: ServiceOptions = {}): Promise<Service> {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(config.backupDir, { recursive: true });
  const db = openDatabase(config.dbPath, { exclusive: opts.exclusive ?? true });
  clearEventHooks();

  const auth = createAuth({ config, db, cimdFetch: opts.cimdFetch });
  try {
    await migrateWithBackup(db, config, auth);
    ensureOwnerMember(db);
  } catch (e) {
    db.close();
    throw e;
  }

  const webhooks = new WebhookDispatcher(db, config, { fetchImpl: opts.fetchImpl });
  webhooks.attach();
  const github = new GithubSync(db, config, { fetchImpl: opts.fetchImpl });

  const { app, close: closeApp } = createApp({ config, db, auth, version: VERSION, webhooks, github });

  if (!hasOwner(db) && opts.announceSetupCode !== false) announceSetupCode(db, config);

  let server: ServerType | undefined;
  const timers: NodeJS.Timeout[] = [];
  const every = (ms: number, fn: () => unknown, name: string) => {
    const t = setInterval(() => {
      Promise.resolve()
        .then(fn)
        .catch((e) => log.error('background job failed', { job: name, error: errMessage(e) }));
    }, ms);
    t.unref();
    timers.push(t);
  };

  return {
    config,
    db,
    auth,
    app,
    webhooks,
    github,
    async listen() {
      if (opts.jobs !== false) {
        webhooks.start();
        every(60 * 60_000, () => expireUnusedClients(db, config.unusedClientTtlDays), 'expire-clients');
        if (config.backupIntervalHours > 0) {
          every(config.backupIntervalHours * 3600_000, async () => {
            await createBackup(db, config, 'scheduled');
            pruneBackups(config);
          }, 'backup');
        }
        if (config.githubSyncIntervalMinutes > 0) every(config.githubSyncIntervalMinutes * 60_000, () => github.syncIfConnected(), 'github-sync');
        setTimeout(() => github.syncIfConnected().catch(() => undefined), 5_000).unref();
      }
      return new Promise((resolve) => {
        server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info: AddressInfo) => {
          const url = `http://${info.address.includes(':') ? `[${info.address}]` : info.address}:${info.port}`;
          log.info('listening', { address: url, public_url: config.publicUrl, version: VERSION });
          resolve({ url, port: info.port });
        });
      });
    },
    async close() {
      for (const t of timers) clearInterval(t);
      webhooks.stop();
      await new Promise<void>((resolve) => {
        if (!server) return resolve();
        const http = server as import('node:http').Server;
        // Open streams (for example an MCP event stream) would hold close() forever: give them a moment, then cut them.
        const force = setTimeout(() => http.closeAllConnections?.(), 3000);
        force.unref();
        http.close(() => {
          clearTimeout(force);
          resolve();
        });
        http.closeIdleConnections?.();
      });
      await closeApp();
      await webhooks.drain();
      db.close();
    },
  };
}

function hasData(db: DB): boolean {
  try {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = 'app_migration'").get();
  } catch {
    return false;
  }
}

export function announceSetupCode(db: DB, config: Config): string {
  const { code, expiresAt } = issueCode(db, 'setup');
  const lines = [
    '',
    '================================================================',
    ' Workspace MCP: first-time setup',
    ` Open ${config.publicUrl}/setup and enter this one-time code:`,
    '',
    `     ${code}`,
    '',
    ` It expires at ${expiresAt}. A new code is printed on every restart`,
    ' until the owner passkey is registered.',
    '================================================================',
    '',
  ];
  process.stdout.write(lines.join('\n') + '\n');
  return code;
}
