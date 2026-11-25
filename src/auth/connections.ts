import { all, get, now, run, tx, type DB } from '../db/db.ts';
import { recordEvent, type Actor } from '../domain/core.ts';
import { log } from '../util/log.ts';

/**
 * A connection is an OAuth client that the owner approved on the consent screen and named.
 * Access tokens are short-lived signed JWTs, so revocation works by checking the connection on every
 * MCP request: a revoked connection, or a token issued before the latest approval, is rejected.
 */
export interface ConnectionRow {
  client_id: string;
  member_id: string;
  name: string;
  client_name: string | null;
  created_at: string;
  approved_at: string;
  last_activity_at: string | null;
  revoked_at: string | null;
}

export function getConnection(db: DB, clientId: string): ConnectionRow | undefined {
  return get<ConnectionRow>(db, 'SELECT * FROM connection WHERE client_id = ?', clientId);
}

export function clientInfo(db: DB, clientId: string) {
  const c = get<Record<string, unknown>>(db, 'SELECT clientId, name, uri, icon, redirectUris, clientDiscoveryId, createdAt, disabled FROM oauthClient WHERE clientId = ?', clientId);
  if (!c) return undefined;
  const redirects = parseJsonList(c.redirectUris);
  return {
    client_id: String(c.clientId),
    name: (c.name as string | null) ?? null,
    uri: (c.uri as string | null) ?? null,
    redirect_uris: redirects,
    registration: c.clientDiscoveryId ? 'client-id-metadata-document' : String(c.clientId).startsWith('https://') ? 'client-id-metadata-document' : 'registered',
    created_at: c.createdAt,
    disabled: !!c.disabled,
  };
}

function parseJsonList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v !== 'string' || !v) return [];
  try {
    const p = JSON.parse(v);
    return Array.isArray(p) ? p.map(String) : [v];
  } catch {
    return v.split(/[\s,]+/).filter(Boolean);
  }
}

/** Called from the consent screen when the owner approves. Re-approving a revoked client reactivates it. */
export function approveConnection(db: DB, actor: Actor, clientId: string, name: string): ConnectionRow {
  const clean = name.trim().slice(0, 100) || 'Unnamed connection';
  const info = clientInfo(db, clientId);
  return tx(db, () => {
    const existing = getConnection(db, clientId);
    const t = now();
    if (existing) {
      run(db, 'UPDATE connection SET name = ?, client_name = ?, approved_at = ?, revoked_at = NULL WHERE client_id = ?', clean, info?.name ?? null, t, clientId);
    } else {
      run(
        db,
        'INSERT INTO connection (client_id, member_id, name, client_name, created_at, approved_at) VALUES (?,?,?,?,?,?)',
        clientId,
        actor.memberId,
        clean,
        info?.name ?? null,
        t,
        t,
      );
    }
    recordEvent(db, actor, 'connection', clientId, 'connection.approved', `Connection "${clean}" approved`, { client_name: info?.name ?? null });
    return getConnection(db, clientId)!;
  });
}

export function renameConnection(db: DB, clientId: string, name: string): void {
  run(db, 'UPDATE connection SET name = ? WHERE client_id = ?', name.trim().slice(0, 100) || 'Unnamed connection', clientId);
}

/** Revokes a connection: blocks its access tokens immediately and deletes its refresh tokens and consent. */
export function revokeConnection(db: DB, actor: Actor, clientId: string): boolean {
  return tx(db, () => {
    const c = getConnection(db, clientId);
    if (!c || c.revoked_at) return false;
    run(db, 'UPDATE connection SET revoked_at = ? WHERE client_id = ?', now(), clientId);
    dropGrants(db, clientId);
    recordEvent(db, actor, 'connection', clientId, 'connection.revoked', `Connection "${c.name}" revoked`);
    return true;
  });
}

/** Removes stored consent and tokens for a client so that the next authorization asks the owner again. */
export function dropGrants(db: DB, clientId: string): void {
  run(db, 'DELETE FROM oauthAccessToken WHERE clientId = ?', clientId);
  run(db, 'DELETE FROM oauthRefreshToken WHERE clientId = ?', clientId);
  run(db, 'DELETE FROM oauthConsent WHERE clientId = ?', clientId);
}

export type AccessCheck = { ok: true; connection: ConnectionRow } | { ok: false; reason: string };

/**
 * Checks an already verified access token against the connection table.
 * `issuedAt` is the token's iat (seconds).
 */
export function checkAccess(db: DB, clientId: string | undefined, issuedAt: number | undefined): AccessCheck {
  if (!clientId) return { ok: false, reason: 'token has no client' };
  const c = getConnection(db, clientId);
  if (!c) {
    // Consent exists in the OAuth server but the owner never named the connection (should not happen
    // through the UI). Drop the grant so the next authorization shows the consent screen.
    dropGrants(db, clientId);
    return { ok: false, reason: 'connection not approved' };
  }
  if (c.revoked_at) return { ok: false, reason: 'connection revoked' };
  const approved = Math.floor(Date.parse(c.approved_at) / 1000);
  if (issuedAt !== undefined && issuedAt < approved) return { ok: false, reason: 'token issued before the current approval' };
  return { ok: true, connection: c };
}

const lastTouch = new Map<string, number>();

/** Records activity at most once a minute per connection. */
export function touchConnection(db: DB, clientId: string): void {
  const t = Date.now();
  if ((lastTouch.get(clientId) ?? 0) > t - 60_000) return;
  lastTouch.set(clientId, t);
  run(db, 'UPDATE connection SET last_activity_at = ? WHERE client_id = ?', new Date(t).toISOString(), clientId);
}

export function listConnections(db: DB) {
  const rows = all<ConnectionRow>(db, 'SELECT * FROM connection ORDER BY revoked_at IS NOT NULL, coalesce(last_activity_at, approved_at) DESC');
  return rows.map((r) => ({ ...r, client: clientInfo(db, r.client_id) ?? null, active: !r.revoked_at }));
}

/** Pending clients: registered (or discovered) but never approved. */
export function listUnapprovedClients(db: DB) {
  return all<Record<string, unknown>>(
    db,
    'SELECT clientId FROM oauthClient WHERE clientId NOT IN (SELECT client_id FROM connection) ORDER BY createdAt DESC LIMIT 100',
  ).map((r) => clientInfo(db, String(r.clientId)));
}

function toMillis(v: unknown): number {
  if (typeof v === 'number') return v;
  if (v instanceof Date) return v.getTime();
  const n = Date.parse(String(v));
  return Number.isNaN(n) ? Number(v) : n;
}

/**
 * Deletes self-registered clients (dynamic registration, or a cached metadata document that is
 * fetched again on the next attempt) that were never approved within `days`. Approved clients and
 * clients the owner created in the web interface are kept.
 */
export function expireUnusedClients(db: DB, days: number): number {
  const cutoff = Date.now() - days * 86_400_000;
  const rows = all<{ id: string; clientId: string; createdAt: unknown }>(
    db,
    'SELECT id, clientId, createdAt FROM oauthClient WHERE userId IS NULL AND clientId NOT IN (SELECT client_id FROM connection)',
  );
  let n = 0;
  for (const r of rows) {
    if (toMillis(r.createdAt) >= cutoff) continue;
    tx(db, () => {
      dropGrants(db, r.clientId);
      run(db, 'DELETE FROM oauthClientResource WHERE clientId IN (?, ?)', r.id, r.clientId);
      run(db, 'DELETE FROM oauthClient WHERE id = ?', r.id);
    });
    n++;
  }
  if (n) log.info('expired unused OAuth clients', { count: n, days });
  return n;
}
