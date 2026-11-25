import { betterAuth } from 'better-auth';
import { jwt } from 'better-auth/plugins';
import { getMigrations } from 'better-auth/db/migration';
import { NodeSqliteDialect } from '@better-auth/kysely-adapter/node-sqlite-dialect';
import { mcp } from '@better-auth/mcp';
import { cimd } from '@better-auth/cimd';
import { fetchClientMetadataResource } from '@better-auth/cimd/node';
import { passkey } from '@better-auth/passkey';
import type { ClientMetadataResourceFetch } from '@better-auth/oauth-provider';
import type { Config } from '../config.ts';
import type { DB } from '../db/db.ts';
import { errMessage, log } from '../util/log.ts';
import { recordDiag } from './diagnostics.ts';
import { completeRegistration, resolveRegistrationUser } from './setup.ts';

export const AUTH_BASE_PATH = '/api/auth';

export interface AuthDeps {
  config: Config;
  db: DB;
  /** Overridable for tests; production uses better-auth's SSRF-safe Node fetcher. */
  cimdFetch?: ClientMetadataResourceFetch;
}

/**
 * The built-in OAuth 2.1 authorization server and owner sign-in.
 * - better-auth `mcp()` = OAuth 2.1 provider bound to the MCP resource (RFC 8707 audience, RFC 9728 PRM,
 *   RFC 8414 metadata, PKCE S256, RFC 9207 iss, rotating refresh tokens, RFC 7009 revocation).
 * - `cimd()` = Client ID Metadata Documents (MCP 2026-07-28 profile); DCR stays enabled for compatibility.
 * - `passkey()` = WebAuthn sign-in for the owner. There is no password sign-in.
 */
/** Internal header set by the HTTP layer; any incoming value is discarded. */
export const CLIENT_IP_HEADER = 'x-workspace-client-ip';

/**
 * Routes better-auth's own messages into our JSON log. Extra arguments are reduced to error
 * messages so request data never reaches the log. better-auth compares SQLite column types with
 * its schema and reports TEXT columns that hold JSON arrays as drift, although it created them
 * that way itself; those notices go to debug.
 */
export const betterAuthLogger = {
  level: 'debug' as const,
  log(level: 'debug' | 'info' | 'success' | 'warn' | 'error', message: string, ...args: unknown[]) {
    const error = args.find((a) => a instanceof Error);
    const fields = { source: 'better-auth', ...(error ? { error: errMessage(error) } : {}) };
    if (level === 'warn' && /has a different type in the database\. Expected string\[\] but got TEXT/.test(message)) return log.debug(message, fields);
    if (level === 'success') return log.info(message, fields);
    log[level](message, fields);
  },
};

export function createAuth({ config, db, cimdFetch }: AuthDeps) {
  const rpID = new URL(config.publicUrl).hostname;
  return betterAuth({
    appName: 'Workspace MCP',
    logger: betterAuthLogger,
    baseURL: config.publicUrl,
    basePath: AUTH_BASE_PATH,
    secret: config.authSecret,
    // One shared connection and no interactive transactions from better-auth: our own writes are
    // synchronous transactions, and an async transaction held open across an await on the same
    // connection could otherwise absorb or block them.
    database: { dialect: new NodeSqliteDialect({ database: db }), type: 'sqlite', transaction: false },
    trustedOrigins: [config.publicUrl],
    emailAndPassword: { enabled: false },
    // The JWT plugin's session-to-JWT endpoint is not needed: MCP tokens come only from /oauth2/token.
    disabledPaths: ['/token'],
    session: { expiresIn: 60 * 60 * 24 * 30, updateAge: 60 * 60 * 24 },
    advanced: {
      useSecureCookies: config.publicUrl.startsWith('https://'),
      // The HTTP layer resolves the client address once (honouring TRUST_PROXY) and passes it here.
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
    },
    rateLimit: {
      enabled: true,
      storage: 'memory',
      window: 60,
      max: 120,
      customRules: {
        '/oauth2/register': { window: 3600, max: 30 },
        '/oauth2/token': { window: 60, max: 60 },
        '/passkey/verify-authentication': { window: 60, max: 20 },
        '/passkey/verify-registration': { window: 60, max: 10 },
      },
    },
    plugins: [
      jwt({ disableSettingJwtHeader: true }),
      mcp({
        loginPage: '/login',
        consentPage: '/consent',
        resource: config.mcpUrl,
        accessTokenExpiresIn: config.accessTokenTtlSeconds,
        refreshTokenExpiresIn: 60 * 60 * 24 * 60,
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        storeTokens: 'hashed',
      }),
      cimd({
        fetchClientMetadataResource: cimdFetch ?? fetchClientMetadataResource,
        metadataProfile: 'mcp-2026-07-28',
        onClientCreated: ({ client }: { client: { clientId?: string; client_id?: string } }) => {
          recordDiag(db, { client_id: client.clientId ?? client.client_id ?? null, step: 'registration', method: 'GET', path: 'client-id-metadata-document', status: 200, outcome: 'ok', detail: { via: 'cimd' } });
        },
      } as Parameters<typeof cimd>[0]),
      passkey({
        rpID,
        rpName: 'Workspace MCP',
        origin: config.publicUrl,
        // The passkey is the only factor for the owner account, so the device must verify the person (PIN or biometrics).
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        registration: {
          requireSession: false,
          resolveUser: ({ context }) => resolveRegistrationUser(db, config, context),
          afterVerification: ({ ctx, context, user }) => completeRegistration(db, config, context, user, ctx.context.internalAdapter),
        },
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;

export async function migrateAuth(auth: Auth): Promise<number> {
  const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(auth.options);
  const n = toBeCreated.length + toBeAdded.length;
  if (n > 0) await runMigrations();
  return n;
}

export async function pendingAuthMigrations(auth: Auth): Promise<number> {
  const { toBeCreated, toBeAdded } = await getMigrations(auth.options, { throwOnUnsafe: false });
  return toBeCreated.length + toBeAdded.length;
}
