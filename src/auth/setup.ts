import { APIError } from 'better-auth/api';
import type { Config } from '../config.ts';
import { get, now, run, tx, type DB } from '../db/db.ts';
import { ensureOwnerMember, ownerMember } from '../domain/entities.ts';
import { newId } from '../domain/core.ts';
import { normalizeCode, oneTimeCode, sha256, signPayload, verifyPayload } from '../util/crypto.ts';

/**
 * Owner sign-up without passwords:
 * - `setup`: while no owner exists, the server prints a one-time code to its log. Entering it lets the
 *   visitor register a passkey and become the owner.
 * - `recovery`: the CLI (`npm run cli -- recovery-code`) issues a code on the host. Entering it lets the owner
 *   register a new passkey for the existing account (lost device).
 * Codes are stored hashed, expire, and work once.
 */
export type CodePurpose = 'setup' | 'recovery';

const CODE_TTL_MINUTES = 30;
const CONTEXT_TTL_SECONDS = 10 * 60;
const OWNER_EMAIL = 'owner@workspace.invalid';

export function ownerUserId(db: DB): string | null {
  return ownerMember(db)?.user_id ?? null;
}

export function hasOwner(db: DB): boolean {
  return ownerUserId(db) !== null;
}

/** Issues a fresh code (older unused codes of the same purpose are invalidated). */
export function issueCode(db: DB, purpose: CodePurpose): { code: string; expiresAt: string } {
  if (purpose === 'setup' && hasOwner(db)) throw new Error('The owner already exists; use a recovery code instead.');
  if (purpose === 'recovery' && !hasOwner(db)) throw new Error('No owner exists yet; open the web UI and use the setup code from the server log.');
  const code = oneTimeCode();
  const expiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60_000).toISOString();
  tx(db, () => {
    run(db, 'UPDATE setup_code SET used_at = ? WHERE purpose = ? AND used_at IS NULL', now(), purpose);
    run(db, 'INSERT INTO setup_code (purpose, code_hash, created_at, expires_at) VALUES (?,?,?,?)', purpose, sha256(normalizeCode(code)), now(), expiresAt);
  });
  return { code, expiresAt };
}

interface CodeRow {
  id: number;
  purpose: CodePurpose;
  expires_at: string;
  used_at: string | null;
}

function liveCode(db: DB, id: number): CodeRow | undefined {
  const r = get<CodeRow>(db, 'SELECT id, purpose, expires_at, used_at FROM setup_code WHERE id = ?', id);
  if (!r || r.used_at || r.expires_at < now()) return undefined;
  return r;
}

interface SetupContext {
  t: 'setup-ctx';
  cid: number;
  purpose: CodePurpose;
  exp: number;
}

/**
 * Checks a code typed by the visitor. Returns a short-lived signed context that the passkey
 * registration carries; the code itself is consumed only when the passkey is stored.
 */
export function verifyCode(db: DB, config: Config, input: string): { context: string; purpose: CodePurpose } | null {
  const hash = sha256(normalizeCode(input));
  const r = get<CodeRow & { code_hash: string }>(db, 'SELECT id, purpose, expires_at, used_at, code_hash FROM setup_code WHERE code_hash = ? ORDER BY id DESC LIMIT 1', hash);
  if (!r || r.used_at || r.expires_at < now()) return null;
  if (r.purpose === 'setup' && hasOwner(db)) return null;
  if (r.purpose === 'recovery' && !hasOwner(db)) return null;
  const ctx: SetupContext = { t: 'setup-ctx', cid: r.id, purpose: r.purpose, exp: Math.floor(Date.now() / 1000) + CONTEXT_TTL_SECONDS };
  return { context: signPayload(config.authSecret, ctx as unknown as Record<string, unknown>), purpose: r.purpose };
}

function readContext(db: DB, config: Config, token: string | null | undefined): SetupContext {
  const c = token ? verifyPayload<SetupContext>(config.authSecret, token) : null;
  if (!c || c.t !== 'setup-ctx' || c.exp < Date.now() / 1000 || !liveCode(db, c.cid)) {
    throw new APIError('UNAUTHORIZED', { message: 'The setup or recovery code is missing, expired or already used.' });
  }
  if (c.purpose === 'setup' && hasOwner(db)) throw new APIError('FORBIDDEN', { message: 'The owner already exists.' });
  return c;
}

/** better-auth passkey `registration.resolveUser`: who the new passkey belongs to. */
export function resolveRegistrationUser(db: DB, config: Config, token: string | null | undefined) {
  const c = readContext(db, config, token);
  if (c.purpose === 'recovery') return { id: ownerUserId(db)!, name: 'Owner', displayName: 'Owner' };
  // The user row is created after the passkey is verified; the id is fixed now so the credential binds to it.
  return { id: newId('usr'), name: 'Owner', displayName: 'Owner' };
}

interface InternalAdapter {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createUser(data: any, source: any): Promise<{ id: string } | null>;
}

/** better-auth passkey `registration.afterVerification`: consumes the code and creates/links the owner. */
export async function completeRegistration(
  db: DB,
  config: Config,
  token: string | null | undefined,
  user: { id: string },
  internalAdapter: InternalAdapter,
): Promise<{ userId: string; name: string }> {
  const c = readContext(db, config, token);
  const consumed = run(db, 'UPDATE setup_code SET used_at = ? WHERE id = ? AND used_at IS NULL', now(), c.cid);
  if (consumed.changes !== 1) throw new APIError('UNAUTHORIZED', { message: 'The code was already used.' });
  if (c.purpose === 'recovery') return { userId: ownerUserId(db)!, name: `Recovery passkey ${now().slice(0, 10)}` };
  const created = await internalAdapter.createUser({ id: user.id, name: 'Owner', email: OWNER_EMAIL, emailVerified: true }, { method: 'passkey' });
  if (!created) throw new APIError('INTERNAL_SERVER_ERROR', { message: 'Could not create the owner account.' });
  run(db, 'UPDATE member SET user_id = ? WHERE id = ?', created.id, ensureOwnerMember(db).id);
  return { userId: created.id, name: 'First passkey' };
}
