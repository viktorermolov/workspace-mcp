import { hkdfSync } from 'node:crypto';
import path from 'node:path';

/** Runtime configuration, read once from environment variables. */
export interface Config {
  /** Public base URL, e.g. https://workspace.example.com (no trailing slash). */
  publicUrl: string;
  /** Canonical MCP resource URL (publicUrl + /mcp). */
  mcpUrl: string;
  host: string;
  port: number;
  dataDir: string;
  dbPath: string;
  backupDir: string;
  /** Root secret; sub-keys are derived from it with HKDF. */
  secretKey: Buffer;
  /** Derived secret for better-auth cookie signing and internal signing. */
  authSecret: string;
  /** Derived 32-byte key for encrypting stored secrets (webhook headers, GitHub token). */
  encryptionKey: Buffer;
  trustProxy: boolean;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  githubApiUrl: string;
  /** Where users can get the Corresponding Source of this deployment (AGPL-3.0 section 13). */
  sourceUrl: string;
  githubSyncIntervalMinutes: number;
  webhookAllowPrivate: boolean;
  backupIntervalHours: number;
  backupKeep: number;
  accessTokenTtlSeconds: number;
  unusedClientTtlDays: number;
  uiDir: string;
}

export class ConfigError extends Error {}

function bool(v: string | undefined, dflt: boolean): boolean {
  if (v === undefined || v === '') return dflt;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

function int(name: string, v: string | undefined, dflt: number, min: number, max: number): number {
  if (v === undefined || v === '') return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new ConfigError(`${name} must be an integer between ${min} and ${max}`);
  return n;
}

/** Default source location: the upstream repository. A modified deployment must point SOURCE_URL at its own source. */
export const UPSTREAM_SOURCE_URL = 'https://github.com/viktorermolov/workspace-mcp';

function sourceUrl(raw: string | undefined): string {
  if (!raw) return UPSTREAM_SOURCE_URL;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ConfigError('SOURCE_URL must be an absolute URL');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new ConfigError('SOURCE_URL must be an http or https URL');
  return u.toString();
}

export function normalizePublicUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ConfigError('PUBLIC_URL must be an absolute URL, for example https://workspace.example.com');
  }
  const loopback = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) {
    throw new ConfigError('PUBLIC_URL must use https (http is allowed only for localhost)');
  }
  if (u.search || u.hash || u.username || u.password) throw new ConfigError('PUBLIC_URL must not contain a query, fragment or credentials');
  if (u.pathname !== '/' && u.pathname !== '') throw new ConfigError('PUBLIC_URL must not contain a path; serve the service at the root of its hostname');
  return `${u.protocol}//${u.host}`.toLowerCase();
}

function derive(secret: Buffer, info: string, len = 32): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), info, len));
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const publicRaw = env.PUBLIC_URL;
  if (!publicRaw) throw new ConfigError('PUBLIC_URL is required (the public https address of this service)');
  const publicUrl = normalizePublicUrl(publicRaw);

  const secretRaw = env.SECRET_KEY;
  if (!secretRaw) throw new ConfigError('SECRET_KEY is required: 32 random bytes in base64, for example the output of `openssl rand -base64 32`');
  const secretKey = Buffer.from(secretRaw, 'base64');
  if (secretKey.length < 32) throw new ConfigError('SECRET_KEY must decode to at least 32 bytes (base64)');

  const dataDir = path.resolve(env.DATA_DIR || './data');
  const logLevel = (env.LOG_LEVEL || 'info') as Config['logLevel'];
  if (!['debug', 'info', 'warn', 'error'].includes(logLevel)) throw new ConfigError('LOG_LEVEL must be debug, info, warn or error');

  return {
    publicUrl,
    mcpUrl: `${publicUrl}/mcp`,
    host: env.HOST || '127.0.0.1',
    port: int('PORT', env.PORT, 8080, 1, 65535),
    dataDir,
    dbPath: path.join(dataDir, 'workspace.sqlite'),
    backupDir: path.join(dataDir, 'backups'),
    secretKey,
    authSecret: derive(secretKey, 'workspace-mcp/auth').toString('base64url'),
    encryptionKey: derive(secretKey, 'workspace-mcp/encryption'),
    trustProxy: bool(env.TRUST_PROXY, false),
    logLevel,
    githubApiUrl: (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, ''),
    sourceUrl: sourceUrl(env.SOURCE_URL),
    githubSyncIntervalMinutes: int('GITHUB_SYNC_INTERVAL_MINUTES', env.GITHUB_SYNC_INTERVAL_MINUTES, 15, 0, 1440),
    webhookAllowPrivate: bool(env.WEBHOOK_ALLOW_PRIVATE_ADDRESSES, false),
    backupIntervalHours: int('BACKUP_INTERVAL_HOURS', env.BACKUP_INTERVAL_HOURS, 24, 0, 720),
    backupKeep: int('BACKUP_KEEP', env.BACKUP_KEEP, 14, 1, 1000),
    accessTokenTtlSeconds: int('ACCESS_TOKEN_TTL_SECONDS', env.ACCESS_TOKEN_TTL_SECONDS, 3600, 60, 86400),
    unusedClientTtlDays: int('UNUSED_CLIENT_TTL_DAYS', env.UNUSED_CLIENT_TTL_DAYS, 7, 1, 365),
    uiDir: path.resolve(env.UI_DIR || new URL('../dist/ui', import.meta.url).pathname),
  };
}
