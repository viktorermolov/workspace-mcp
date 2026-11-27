import { all, get, now, run, tx, type DB } from '../db/db.ts';
import { recordEvent, DomainError, type Actor } from '../domain/core.ts';
import { connectionAccessView } from '../domain/access.ts';
import { redirectUriKey, normalizeRedirectUri } from '../db/repair-reauth-duplicates.ts';
import { log } from '../util/log.ts';

/**
 * A connection is an OAuth client that the owner approved on the consent screen and named.
 * Access tokens are short-lived signed JWTs, so revocation works by checking the connection on every
 * MCP request: a revoked connection, or a token issued before the latest approval, is rejected.
 * `client_id` is the stable platform id. `current_client_id` is the OAuth client whose tokens are accepted.
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
  roles_confirmed_at?: string | null;
  roles_suggested_at?: string | null;
  current_client_id?: string | null;
  merged_into_client_id?: string | null;
  sole_agent?: number;
}

export function getConnection(db: DB, clientId: string): ConnectionRow | undefined {
  return get<ConnectionRow>(db, 'SELECT * FROM connection WHERE client_id = ?', clientId);
}

/**
 * The single active, not-merged platform that currently accepts this OAuth client, if any.
 * Today the accepted client is `current_client_id` only. If a later migration needs more
 * than one accepted client, this lookup should join that binding table instead of being
 * rewritten at each call site.
 */
export function liveConnectionForClient(db: DB, clientId: string): ConnectionRow | undefined {
  return get<ConnectionRow>(
    db,
    `SELECT * FROM connection
      WHERE current_client_id = ?
        AND revoked_at IS NULL
        AND merged_into_client_id IS NULL`,
    clientId,
  );
}

/**
 * OAuth client ids whose tokens this platform currently accepts.
 * Today that is only `current_client_id` (falling back to the stable platform id).
 * A later binding table can extend this list without rewriting revoke, expiry, or rollback.
 */
export function acceptedClientIds(_db: DB, platform: ConnectionRow): string[] {
  const current = platform.current_client_id ?? platform.client_id;
  return current ? [current] : [];
}

/** Agents, or an owner-confirmed role allow-list, make a platform a re-auth match candidate. */
export function platformIsConfigured(db: DB, clientId: string): boolean {
  const agents = get<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM agent WHERE client_id = ?', clientId)?.n ?? 0;
  if (agents > 0) return true;
  const row = getConnection(db, clientId);
  if (row?.roles_confirmed_at) return true;
  const roles =
    get<{ n: number }>(db, "SELECT COUNT(*) AS n FROM connection_role WHERE client_id = ? AND source = 'owner'", clientId)?.n ?? 0;
  return roles > 0;
}

/**
 * Journal rows under this platform other than its own `connection.approved`.
 * Attribution is by `connection_id`, by `entity_id` on the platform or one of its agents,
 * and by `event.agent` when that slug belongs to an agent on the platform.
 */
export function journalEntriesBesidesApprove(db: DB, platformClientId: string): number {
  const row = get<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM event e
      WHERE e.action != 'connection.approved'
        AND (
          e.connection_id = ?
          OR (e.entity_type = 'connection' AND e.entity_id = ?)
          OR (e.entity_type = 'agent' AND e.entity_id IN (SELECT id FROM agent WHERE client_id = ?))
          OR (e.agent IS NOT NULL AND TRIM(e.agent) != '' AND e.agent IN (SELECT slug FROM agent WHERE client_id = ?))
        )`,
    platformClientId,
    platformClientId,
    platformClientId,
    platformClientId,
  );
  return row?.n ?? 0;
}

/** An empty same-type duplicate may be archived only when all of these hold. */
export function qualifiesAsEmptyDuplicate(db: DB, platform: ConnectionRow): boolean {
  if (platform.revoked_at || platform.merged_into_client_id) return false;
  const agents = get<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM agent WHERE client_id = ?', platform.client_id)?.n ?? 0;
  if (agents > 0) return false;
  const roles = get<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM connection_role WHERE client_id = ?', platform.client_id)?.n ?? 0;
  if (roles > 0) return false;
  if (platform.roles_confirmed_at) return false;
  if (journalEntriesBesidesApprove(db, platform.client_id) > 0) return false;
  return true;
}

export function emptyDuplicatesToArchive(db: DB, memberId: string, incomingClientId: string, continuedPlatformId: string): ConnectionRow[] {
  const incoming = clientInfo(db, incomingClientId);
  if (!incoming) return [];
  const out: ConnectionRow[] = [];
  for (const row of activePlatforms(db, memberId)) {
    if (row.client_id === continuedPlatformId) continue;
    const boundId = row.current_client_id || row.client_id;
    const existing = clientInfo(db, boundId) ?? clientInfo(db, row.client_id);
    if (!existing || !sameClientType(existing, incoming)) continue;
    if (qualifiesAsEmptyDuplicate(db, row)) out.push(row);
  }
  return out;
}

export type ClientInfo = {
  client_id: string;
  name: string | null;
  uri: string | null;
  redirect_uris: string[];
  registration: 'client-id-metadata-document' | 'registered';
  token_endpoint_auth_method: string | null;
  created_at: unknown;
  disabled: boolean;
};

export function clientInfo(db: DB, clientId: string): ClientInfo | undefined {
  const c = get<Record<string, unknown>>(
    db,
    'SELECT clientId, name, uri, icon, redirectUris, clientDiscoveryId, tokenEndpointAuthMethod, createdAt, disabled FROM oauthClient WHERE clientId = ?',
    clientId,
  );
  if (!c) return undefined;
  const redirects = parseJsonList(c.redirectUris);
  return {
    client_id: String(c.clientId),
    name: (c.name as string | null) ?? null,
    uri: (c.uri as string | null) ?? null,
    redirect_uris: redirects,
    registration: c.clientDiscoveryId ? 'client-id-metadata-document' : String(c.clientId).startsWith('https://') ? 'client-id-metadata-document' : 'registered',
    token_endpoint_auth_method: (c.tokenEndpointAuthMethod as string | null) ?? null,
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

export type ContinueTarget = {
  client_id: string;
  name: string;
  agents: number;
  roles: { slug: string; name: string }[];
  sole_agent: boolean;
};

export type ReauthContinue =
  | { mode: 'auto'; target: ContinueTarget; archive: ContinueTarget[] }
  | { mode: 'choice'; candidates: ContinueTarget[] }
  | { mode: 'new' };

function isCimd(info: ClientInfo): boolean {
  return info.registration === 'client-id-metadata-document';
}

/**
 * Identity for automatic continuation: same registration method, same redirect-URI set,
 * same token endpoint auth method, and the same client name. CIMD also requires the
 * client_id URL to be equal. Name is never used alone.
 */
export function sameClientType(existing: ClientInfo, incoming: ClientInfo): boolean {
  if (isCimd(existing) !== isCimd(incoming)) return false;
  if (isCimd(incoming)) return existing.client_id === incoming.client_id;
  const a = redirectUriKey(existing.redirect_uris);
  const b = redirectUriKey(incoming.redirect_uris);
  if (!a || !b || a !== b) return false;
  const methodA = existing.token_endpoint_auth_method ?? 'none';
  const methodB = incoming.token_endpoint_auth_method ?? 'none';
  if (methodA !== methodB) return false;
  const nameA = (existing.name ?? '').trim();
  const nameB = (incoming.name ?? '').trim();
  if (!nameA || !nameB || nameA !== nameB) return false;
  return true;
}

function continueTarget(db: DB, row: ConnectionRow): ContinueTarget {
  const agents = get<{ n: number }>(db, 'SELECT count(*) AS n FROM agent WHERE client_id = ?', row.client_id)?.n ?? 0;
  const roles = all<{ slug: string; name: string }>(
    db,
    `SELECT r.slug, r.name
       FROM connection_role cr JOIN role r ON r.id = cr.role_id
      WHERE cr.client_id = ? AND cr.source = 'owner'
      ORDER BY r.name`,
    row.client_id,
  );
  return {
    client_id: row.client_id,
    name: row.name,
    agents,
    roles,
    sole_agent: row.sole_agent === 1,
  };
}

export function activePlatforms(db: DB, memberId: string): ConnectionRow[] {
  return all<ConnectionRow>(
    db,
    `SELECT * FROM connection
      WHERE member_id = ? AND revoked_at IS NULL AND merged_into_client_id IS NULL
      ORDER BY created_at`,
    memberId,
  );
}

/** How consent should treat this incoming client for this owner. */
export function reauthContinueOptions(db: DB, memberId: string, incomingClientId: string): ReauthContinue {
  const incoming = clientInfo(db, incomingClientId);
  if (!incoming) return { mode: 'new' };
  const already = liveConnectionForClient(db, incomingClientId);
  if (already && already.member_id === memberId) {
    return { mode: 'auto', target: continueTarget(db, already), archive: [] };
  }
  const active = activePlatforms(db, memberId);
  if (!active.length) return { mode: 'new' };
  const matches: ContinueTarget[] = [];
  const archive: ContinueTarget[] = [];
  for (const row of active) {
    // Identity is taken from the OAuth client currently (or originally) bound to the platform.
    const boundId = row.current_client_id || row.client_id;
    const existing = clientInfo(db, boundId) ?? clientInfo(db, row.client_id);
    if (!existing || !sameClientType(existing, incoming)) continue;
    if (platformIsConfigured(db, row.client_id)) matches.push(continueTarget(db, row));
    else if (qualifiesAsEmptyDuplicate(db, row)) archive.push(continueTarget(db, row));
  }
  if (matches.length === 1) return { mode: 'auto', target: matches[0]!, archive };
  const matchIds = new Set(matches.map((m) => m.client_id));
  const candidates = [
    ...active.filter((row) => matchIds.has(row.client_id)).map((row) => continueTarget(db, row)),
    ...active.filter((row) => !matchIds.has(row.client_id)).map((row) => continueTarget(db, row)),
  ];
  return { mode: 'choice', candidates };
}

export interface ApproveOptions {
  /** When set, bind this existing platform instead of creating a new one. Null means "new platform". */
  continueClientId?: string | null;
  /** Consent computed an automatic continuation; the owner is not asked to pick. */
  autoContinue?: boolean;
  /** The consent screen offered a choice and the owner picked a new platform. */
  offeredChoice?: boolean;
}

/** How long a consent-time rebind stays pending, waiting for the authorization-code exchange.
 *  Longer than the authorization server's 10-minute code lifetime so cleanup is not racy. */
export const PENDING_BIND_TTL_MS = 15 * 60 * 1000;

export type PendingBindRow = {
  platform_client_id: string;
  incoming_client_id: string;
  member_id: string;
  auto: number;
  created_at: string;
  expires_at: string;
};

function hasPendingBindTable(db: DB): boolean {
  return !!get(db, "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'connection_pending_bind'");
}

/** The pending rebind for this platform, if any (including an expired row not yet cleaned up). */
export function getPendingBind(db: DB, platformClientId: string): PendingBindRow | undefined {
  if (!hasPendingBindTable(db)) return undefined;
  return get<PendingBindRow>(db, 'SELECT * FROM connection_pending_bind WHERE platform_client_id = ?', platformClientId);
}

/**
 * Records a rebind approved on the consent screen, without dropping the previous client's
 * grants or switching `current_client_id`. A later consent for the same platform, or the
 * same incoming client on another platform, replaces the pending row.
 */
export function queuePendingBind(
  db: DB,
  actor: Actor,
  platformId: string,
  incomingClientId: string,
  auto: boolean,
): ConnectionRow {
  const platform = getConnection(db, platformId);
  if (!platform || platform.member_id !== actor.memberId || platform.revoked_at || platform.merged_into_client_id) {
    throw new DomainError('invalid', 'That platform cannot be continued');
  }
  if (!hasPendingBindTable(db)) {
    throw new DomainError('invalid', 'Pending client bind is not available');
  }
  const t = now();
  const expires = new Date(Date.parse(t) + PENDING_BIND_TTL_MS).toISOString();
  run(db, 'DELETE FROM connection_pending_bind WHERE platform_client_id = ? OR incoming_client_id = ?', platformId, incomingClientId);
  run(
    db,
    `INSERT INTO connection_pending_bind
       (platform_client_id, incoming_client_id, member_id, auto, created_at, expires_at)
     VALUES (?,?,?,?,?,?)`,
    platform.client_id,
    incomingClientId,
    actor.memberId,
    auto ? 1 : 0,
    t,
    expires,
  );
  return getConnection(db, platform.client_id)!;
}

/**
 * Applies a pending rebind after the incoming client's authorization-code exchange succeeds.
 * Completes even if the pending row has passed `expires_at`, as long as it was not replaced:
 * a valid code is the signal. Returns undefined when there is no pending bind for this client.
 */
export function completePendingBind(db: DB, incomingClientId: string): ConnectionRow | undefined {
  if (!hasPendingBindTable(db)) return undefined;
  return tx(db, () => {
    const pending = get<PendingBindRow>(
      db,
      'SELECT * FROM connection_pending_bind WHERE incoming_client_id = ?',
      incomingClientId,
    );
    if (!pending) return undefined;
    const actor: Actor = { kind: 'owner', memberId: pending.member_id };
    const info = clientInfo(db, incomingClientId);
    const row = bindIncomingClient(
      db,
      actor,
      pending.platform_client_id,
      incomingClientId,
      '',
      info,
      pending.auto === 1,
      pending.created_at,
    );
    run(db, 'DELETE FROM connection_pending_bind WHERE platform_client_id = ?', pending.platform_client_id);
    return row;
  });
}

/** Called from the consent screen when the owner approves. Re-approving a revoked (not merged) client reactivates it. */
export function approveConnection(db: DB, actor: Actor, clientId: string, name: string, opts: ApproveOptions = {}): ConnectionRow {
  const clean = name.trim().slice(0, 100) || 'Unnamed connection';
  const info = clientInfo(db, clientId);
  return tx(db, () => {
    const live = liveConnectionForClient(db, clientId);
    if (live) {
      run(db, 'UPDATE connection SET name = ?, client_name = ?, approved_at = ? WHERE client_id = ?', clean, info?.name ?? live.client_name, now(), live.client_id);
      dropGrants(db, live.current_client_id && live.current_client_id !== clientId ? live.client_id : undefined);
      // Same live client re-approved: rotate tokens for this client after approval by bumping approved_at only
      // (new token is issued after this). Refresh tokens of this client stay until the token endpoint rotates them;
      // older access tokens fail the iat < approved_at check.
      recordEvent(db, actor, 'connection', live.client_id, 'connection.approved', `Connection "${clean}" approved`, {
        client_name: info?.name ?? null,
        continued: true,
        auto: true,
      });
      return getConnection(db, live.client_id)!;
    }

    const byPk = getConnection(db, clientId);
    if (byPk?.merged_into_client_id) {
      throw new DomainError('invalid', 'This client was merged into another platform and cannot be approved again on its own.');
    }
    if (byPk) {
      run(db, 'UPDATE connection SET name = ?, client_name = ?, approved_at = ?, revoked_at = NULL WHERE client_id = ?', clean, info?.name ?? null, now(), clientId);
      recordEvent(db, actor, 'connection', clientId, 'connection.approved', `Connection "${clean}" approved`, { client_name: info?.name ?? null });
      return getConnection(db, clientId)!;
    }

    const continueId = opts.autoContinue || opts.continueClientId ? opts.continueClientId ?? undefined : undefined;
    if (opts.autoContinue && !opts.continueClientId) {
      // Caller should pass the computed target; look it up if they only set the flag.
    }
    const targetId = opts.continueClientId || (opts.autoContinue ? reauthContinueOptions(db, actor.memberId, clientId).mode === 'auto'
      ? (reauthContinueOptions(db, actor.memberId, clientId) as { mode: 'auto'; target: ContinueTarget }).target.client_id
      : undefined
    : undefined);

    if (targetId) {
      // Do not drop previous grants or switch current_client_id until the code is exchanged.
      return queuePendingBind(db, actor, targetId, clientId, !!opts.autoContinue);
    }

    const t = now();
    run(
      db,
      'INSERT INTO connection (client_id, member_id, name, client_name, created_at, approved_at, current_client_id) VALUES (?,?,?,?,?,?,?)',
      clientId,
      actor.memberId,
      clean,
      info?.name ?? null,
      t,
      t,
      clientId,
    );
    recordEvent(db, actor, 'connection', clientId, 'connection.approved', `Connection "${clean}" approved`, {
      client_name: info?.name ?? null,
      ...(opts.offeredChoice ? { offered: true, choice: 'new' } : {}),
    });
    return getConnection(db, clientId)!;
  });
}

function bindIncomingClient(
  db: DB,
  actor: Actor,
  platformId: string,
  incomingClientId: string,
  name: string,
  info: ClientInfo | undefined,
  auto: boolean,
  approvedAt?: string,
): ConnectionRow {
  const platform = getConnection(db, platformId);
  if (!platform || platform.member_id !== actor.memberId || platform.revoked_at || platform.merged_into_client_id) {
    throw new DomainError('invalid', 'That platform cannot be continued');
  }
  const previous = platform.current_client_id || platform.client_id;
  const previousApprovedAt = platform.approved_at;
  // Use the consent time when completing a pending bind so the new token's iat
  // (stamped at /token, after consent) is not before approved_at.
  const t = approvedAt ?? now();
  const toArchive = emptyDuplicatesToArchive(db, actor.memberId, incomingClientId, platform.client_id);
  for (const dup of toArchive) {
    const dupClient = dup.current_client_id || dup.client_id;
    run(
      db,
      `UPDATE connection
          SET merged_into_client_id = ?, revoked_at = ?, current_client_id = NULL
        WHERE client_id = ?`,
      platform.client_id,
      t,
      dup.client_id,
    );
    dropGrants(db, dupClient);
    if (dup.client_id !== dupClient) dropGrants(db, dup.client_id);
    recordEvent(db, actor, 'connection', dup.client_id, 'connection.merged', `Empty platform "${dup.name}" archived into "${platform.name}"`, {
      merged_into: platform.client_id,
      reason: 'empty_reauth_duplicate',
    });
  }
  dropGrants(db, previous);
  run(
    db,
    'UPDATE connection SET current_client_id = ?, approved_at = ?, client_name = ? WHERE client_id = ?',
    incomingClientId,
    t,
    info?.name ?? platform.client_name,
    platform.client_id,
  );
  // Keep the owner's platform name; do not rename it to the incoming client name.
  void name;
  const firstArchived = toArchive[0]?.client_id ?? null;
  // Extra archive rows first so the bind transfer is the latest pending one.
  for (const dup of toArchive.slice(1)) {
    run(
      db,
      `INSERT INTO connection_transfer
         (member_id, platform_client_id, from_client_id, to_client_id, previous_approved_at, kind, archived_client_id, created_at)
       VALUES (?,?,?,?,?,'reauth',?,?)`,
      platform.member_id,
      platform.client_id,
      previous,
      incomingClientId,
      previousApprovedAt,
      dup.client_id,
      t,
    );
  }
  run(
    db,
    `INSERT INTO connection_transfer
       (member_id, platform_client_id, from_client_id, to_client_id, previous_approved_at, kind, archived_client_id, created_at)
     VALUES (?,?,?,?,?,'reauth',?,?)`,
    platform.member_id,
    platform.client_id,
    previous,
    incomingClientId,
    previousApprovedAt,
    firstArchived,
    t,
  );
  recordEvent(db, actor, 'connection', platform.client_id, 'connection.rebound', `OAuth client bound to platform "${platform.name}"`, {
    from_client_id: previous,
    to_client_id: incomingClientId,
    auto,
    agents_unchanged: true,
    allow_list_unchanged: true,
    archived_client_ids: toArchive.map((d) => d.client_id),
  });
  return getConnection(db, platform.client_id)!;
}

export function renameConnection(db: DB, clientId: string, name: string): void {
  run(db, 'UPDATE connection SET name = ? WHERE client_id = ?', name.trim().slice(0, 100) || 'Unnamed connection', clientId);
}

/** Revokes a connection: blocks its access tokens immediately and deletes its refresh tokens and consent. */
export function revokeConnection(db: DB, actor: Actor, clientId: string): boolean {
  return tx(db, () => {
    const c = getConnection(db, clientId);
    if (!c || c.revoked_at) return false;
    if (c.merged_into_client_id) return false;
    run(db, 'UPDATE connection SET revoked_at = ? WHERE client_id = ?', now(), clientId);
    const revokedClients = new Set(acceptedClientIds(db, c));
    revokedClients.add(c.client_id);
    for (const id of revokedClients) dropGrants(db, id);
    recordEvent(db, actor, 'connection', clientId, 'connection.revoked', `Connection "${c.name}" revoked`);
    return true;
  });
}

/** Removes stored consent and tokens for a client so that the next authorization asks the owner again. */
export function dropGrants(db: DB, clientId: string | undefined): void {
  if (!clientId) return;
  run(db, 'DELETE FROM oauthAccessToken WHERE clientId = ?', clientId);
  run(db, 'DELETE FROM oauthRefreshToken WHERE clientId = ?', clientId);
  run(db, 'DELETE FROM oauthConsent WHERE clientId = ?', clientId);
}

export type AccessCheck = { ok: true; connection: ConnectionRow } | { ok: false; reason: string };

/**
 * Checks an already verified access token against the connection table.
 * `issuedAt` is the token's iat (seconds). Lookup is by accepted client
 * (`liveConnectionForClient`): today `current_client_id` only. A token for a
 * platform's original client id is rejected after a re-bind unless that id is
 * still accepted.
 */
export function checkAccess(db: DB, clientId: string | undefined, issuedAt: number | undefined): AccessCheck {
  if (!clientId) return { ok: false, reason: 'token has no client' };
  const c = liveConnectionForClient(db, clientId);
  if (!c) {
    // Consent exists in the OAuth server but the owner never named the connection (should not happen
    // through the UI). Drop the grant so the next authorization shows the consent screen.
    // Never drop grants of a client that is still accepted on a platform (including an archived one
    // that should have been found above — the live lookup already requires an unmerged row).
    const bound = get(db, 'SELECT 1 FROM connection WHERE current_client_id = ?', clientId);
    if (!bound) dropGrants(db, clientId);
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

export type TransferRow = {
  id: number;
  platform_client_id: string;
  from_client_id: string;
  to_client_id: string;
  previous_approved_at: string | null;
  kind: 'reauth' | 'migration';
  archived_client_id: string | null;
  rolled_back_at: string | null;
  created_at: string;
};

export function pendingTransfer(db: DB, platformClientId: string): TransferRow | undefined {
  return get<TransferRow>(
    db,
    `SELECT * FROM connection_transfer
      WHERE platform_client_id = ? AND rolled_back_at IS NULL
      ORDER BY id DESC LIMIT 1`,
    platformClientId,
  );
}

/** Owner-only: undo the latest client transfer on this platform. */
export function rollbackClientTransfer(db: DB, actor: Actor, platformClientId: string): ConnectionRow {
  if (actor.kind !== 'owner') throw new DomainError('forbidden', 'only the owner can roll back a client transfer');
  return tx(db, () => {
    const platform = getConnection(db, platformClientId);
    if (!platform || platform.member_id !== actor.memberId) throw new DomainError('not_found', `connection not found: ${platformClientId}`);
    const transfer = pendingTransfer(db, platformClientId);
    if (!transfer) throw new DomainError('invalid', 'There is no client transfer to roll back on this platform');
    const t = now();
    const siblings = all<TransferRow>(
      db,
      `SELECT * FROM connection_transfer
        WHERE platform_client_id = ? AND rolled_back_at IS NULL AND created_at = ? AND id != ?`,
      platform.client_id,
      transfer.created_at,
      transfer.id,
    );
    const archivedIds = [transfer.archived_client_id, ...siblings.map((s) => s.archived_client_id)].filter(
      (id): id is string => !!id,
    );
    // Migration 15 archives an empty duplicate without switching the accepted client
    // (from_client_id = to_client_id). Undo must not drop the original's tokens or
    // move approved_at / current_client_id, or every agent on that platform would
    // have to reconnect. Real client switches (from != to) keep the 0007 behaviour.
    const sameClientArchive =
      transfer.from_client_id === transfer.to_client_id &&
      transfer.kind === 'migration' &&
      !!transfer.archived_client_id;
    if (sameClientArchive) {
      for (const archivedId of archivedIds) {
        dropGrants(db, archivedId);
        run(
          db,
          `UPDATE connection
              SET current_client_id = ?, revoked_at = NULL, merged_into_client_id = NULL
            WHERE client_id = ? AND merged_into_client_id = ?`,
          archivedId,
          archivedId,
          platform.client_id,
        );
      }
    } else {
      dropGrants(db, transfer.to_client_id);
      dropGrants(db, transfer.from_client_id);
      for (const archivedId of archivedIds) dropGrants(db, archivedId);
      run(
        db,
        'UPDATE connection SET current_client_id = ?, approved_at = ? WHERE client_id = ?',
        transfer.from_client_id,
        t,
        platform.client_id,
      );
      for (const archivedId of archivedIds) {
        run(
          db,
          `UPDATE connection
              SET current_client_id = ?, revoked_at = NULL, merged_into_client_id = NULL, approved_at = ?
            WHERE client_id = ? AND merged_into_client_id = ?`,
          archivedId,
          t,
          archivedId,
          platform.client_id,
        );
      }
    }
    run(db, 'UPDATE connection_transfer SET rolled_back_at = ? WHERE id = ?', t, transfer.id);
    for (const sib of siblings) {
      run(db, 'UPDATE connection_transfer SET rolled_back_at = ? WHERE id = ?', t, sib.id);
    }
    recordEvent(db, actor, 'connection', platform.client_id, 'connection.transfer_rolled_back', `Rolled back a client transfer on "${platform.name}"`, {
      from_client_id: transfer.to_client_id,
      to_client_id: transfer.from_client_id,
      kind: transfer.kind,
      archived_client_ids: archivedIds,
    });
    return getConnection(db, platform.client_id)!;
  });
}

export function listConnections(db: DB) {
  const rows = all<ConnectionRow>(db, 'SELECT * FROM connection ORDER BY revoked_at IS NOT NULL, coalesce(last_activity_at, approved_at) DESC');
  return rows.map((r) => ({
    ...r,
    client: clientInfo(db, r.current_client_id || r.client_id) ?? clientInfo(db, r.client_id) ?? null,
    active: !r.revoked_at && !r.merged_into_client_id,
    pending_transfer: r.revoked_at || r.merged_into_client_id ? null : pendingTransfer(db, r.client_id) ?? null,
    ...connectionAccessView(db, r.member_id, r.client_id),
  }));
}

/** Pending clients: registered (or discovered) but never approved, and not an accepted client of any platform.
 *  Today "accepted" is `current_client_id`; a later binding table would be excluded here the same way. */
export function listUnapprovedClients(db: DB) {
  const pending = hasPendingBindTable(db) ? 'AND clientId NOT IN (SELECT incoming_client_id FROM connection_pending_bind)' : '';
  return all<Record<string, unknown>>(
    db,
    `SELECT clientId FROM oauthClient
      WHERE clientId NOT IN (SELECT client_id FROM connection)
        AND clientId NOT IN (SELECT current_client_id FROM connection WHERE current_client_id IS NOT NULL)
        ${pending}
      ORDER BY createdAt DESC LIMIT 100`,
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
 * fetched again on the next attempt) that were never approved within `days`. Approved clients,
 * clients the owner created in the web interface, every accepted client (`current_client_id`
 * today; a later binding table would be included the same way), and archived
 * duplicates' clients are kept.
 */
export function expireUnusedClients(db: DB, days: number): number {
  const cutoff = Date.now() - days * 86_400_000;
  const rows = all<{ id: string; clientId: string; createdAt: unknown }>(
    db,
    `SELECT id, clientId, createdAt FROM oauthClient
      WHERE userId IS NULL
        AND clientId NOT IN (SELECT client_id FROM connection)
        AND clientId NOT IN (SELECT current_client_id FROM connection WHERE current_client_id IS NOT NULL)
        ${hasPendingBindTable(db) ? 'AND clientId NOT IN (SELECT incoming_client_id FROM connection_pending_bind)' : ''}`,
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

export { normalizeRedirectUri, redirectUriKey };
