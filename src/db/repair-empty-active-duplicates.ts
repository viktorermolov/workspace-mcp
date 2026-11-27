/**
 * Frozen as of migration 15 (`repair-empty-active-duplicates`).
 * Do not change this file's behaviour except to fix a bug in these exact rules.
 * Re-auth continuation (consent) lives in src/auth/connections.ts and may evolve;
 * this repair must keep the 15 semantics even if those functions later change.
 *
 * Migration 14 leaves an empty same-type duplicate in place when the original was
 * used after that duplicate was approved (`original_still_active`). This repair
 * archives that empty duplicate when the pair is unique and the duplicate has
 * no agents, no roles, and no journal besides its own approval. The original
 * platform and its tokens are not changed. There is no binding table: only the
 * original's client stays accepted.
 */
import type { DatabaseSync } from 'node:sqlite';
import { redirectUriKey } from './repair-reauth-duplicates.ts';

export type MigrationLog = { msg: string; fields: Record<string, unknown> };

type Conn = {
  client_id: string;
  member_id: string;
  name: string;
  created_at: string;
  approved_at: string;
  last_activity_at: string | null;
  revoked_at: string | null;
  roles_confirmed_at: string | null;
  current_client_id: string | null;
  merged_into_client_id: string | null;
};

type ClientInfo = {
  client_id: string;
  name: string | null;
  redirect_uris: string[];
  registration: 'client-id-metadata-document' | 'registered';
  token_endpoint_auth_method: string | null;
};

function all<T>(db: DatabaseSync, sql: string, ...params: unknown[]): T[] {
  return db.prepare(sql).all(...(params as never[])) as T[];
}
function get<T>(db: DatabaseSync, sql: string, ...params: unknown[]): T | undefined {
  return db.prepare(sql).get(...(params as never[])) as T | undefined;
}
function run(db: DatabaseSync, sql: string, ...params: unknown[]) {
  return db.prepare(sql).run(...(params as never[]));
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return !!get(db, "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", name);
}

function isoNow(): string {
  return new Date().toISOString();
}

function notAfter(a: string | null | undefined, b: string): boolean {
  if (!a) return true;
  return Date.parse(a) <= Date.parse(b);
}

function createdAfter(newer: string, older: string): boolean {
  return Date.parse(newer) > Date.parse(older);
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

function clientInfo(db: DatabaseSync, clientId: string): ClientInfo | undefined {
  const c = get<Record<string, unknown>>(
    db,
    'SELECT clientId, name, redirectUris, clientDiscoveryId, tokenEndpointAuthMethod FROM oauthClient WHERE clientId = ?',
    clientId,
  );
  if (!c) return undefined;
  const id = String(c.clientId);
  return {
    client_id: id,
    name: (c.name as string | null) ?? null,
    redirect_uris: parseJsonList(c.redirectUris),
    registration: c.clientDiscoveryId
      ? 'client-id-metadata-document'
      : id.startsWith('https://')
        ? 'client-id-metadata-document'
        : 'registered',
    token_endpoint_auth_method: (c.tokenEndpointAuthMethod as string | null) ?? null,
  };
}

function isCimd(info: ClientInfo): boolean {
  return info.registration === 'client-id-metadata-document';
}

/** Same identity rule as src/auth/connections.ts `sameClientType`, frozen here. */
function sameClientType(existing: ClientInfo, incoming: ClientInfo): boolean {
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

function boundInfo(db: DatabaseSync, row: Conn): ClientInfo | undefined {
  const boundId = row.current_client_id || row.client_id;
  return clientInfo(db, boundId) ?? clientInfo(db, row.client_id);
}

function platformIsConfigured(db: DatabaseSync, row: Conn): boolean {
  const agents = get<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM agent WHERE client_id = ?', row.client_id)?.n ?? 0;
  if (agents > 0) return true;
  if (row.roles_confirmed_at) return true;
  if (!tableExists(db, 'connection_role')) return false;
  const roles =
    get<{ n: number }>(db, "SELECT COUNT(*) AS n FROM connection_role WHERE client_id = ? AND source = 'owner'", row.client_id)
      ?.n ?? 0;
  return roles > 0;
}

function journalEntriesBesidesApprove(db: DatabaseSync, platformClientId: string): number {
  if (!tableExists(db, 'event')) return 0;
  const agentAttr = tableExists(db, 'agent')
    ? `OR (e.entity_type = 'agent' AND e.entity_id IN (SELECT id FROM agent WHERE client_id = ?))
       OR (e.agent IS NOT NULL AND TRIM(e.agent) != '' AND e.agent IN (SELECT slug FROM agent WHERE client_id = ?))`
    : '';
  const params: unknown[] = [platformClientId, platformClientId];
  if (agentAttr) params.push(platformClientId, platformClientId);
  const row = get<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM event e
      WHERE e.action != 'connection.approved'
        AND (
          e.connection_id = ?
          OR (e.entity_type = 'connection' AND e.entity_id = ?)
          ${agentAttr}
        )`,
    ...params,
  );
  return row?.n ?? 0;
}

/** Арина's empty-duplicate conditions: 0 agents, 0 roles, journal only approve. A consent row is not configuration. */
function qualifiesAsEmptyDuplicate(db: DatabaseSync, platform: Conn): boolean {
  if (platform.revoked_at || platform.merged_into_client_id) return false;
  const agents = get<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM agent WHERE client_id = ?', platform.client_id)?.n ?? 0;
  if (agents > 0) return false;
  if (tableExists(db, 'connection_role')) {
    const roles = get<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM connection_role WHERE client_id = ?', platform.client_id)?.n ?? 0;
    if (roles > 0) return false;
  }
  if (platform.roles_confirmed_at) return false;
  if (journalEntriesBesidesApprove(db, platform.client_id) > 0) return false;
  return true;
}

function dropGrants(db: DatabaseSync, clientId: string | undefined | null): void {
  if (!clientId) return;
  for (const table of ['oauthAccessToken', 'oauthRefreshToken', 'oauthConsent']) {
    if (tableExists(db, table)) run(db, `DELETE FROM ${table} WHERE clientId = ?`, clientId);
  }
}

/**
 * Archive each unique empty same-type duplicate that migration 14 left in place
 * because the original was still in use. Never touches the original's accepted
 * client or its tokens. An unused consent row is not configuration and is revoked
 * with the rest of the duplicate's grants.
 */
export function repairEmptyActiveDuplicates(db: DatabaseSync): MigrationLog[] {
  const logs: MigrationLog[] = [];
  if (!tableExists(db, 'oauthClient') || !tableExists(db, 'connection') || !tableExists(db, 'connection_transfer')) {
    logs.push({ msg: 'empty active duplicate repair complete', fields: { id: 15, repaired: 0, skipped: 0 } });
    return logs;
  }

  const connections = all<Conn>(
    db,
    `SELECT client_id, member_id, name, created_at, approved_at, last_activity_at, revoked_at,
            roles_confirmed_at, current_client_id, merged_into_client_id
       FROM connection`,
  );

  const live = connections.filter((c) => !c.revoked_at && !c.merged_into_client_id);
  const byMember = new Map<string, Conn[]>();
  for (const c of live) {
    const g = byMember.get(c.member_id) ?? [];
    g.push(c);
    byMember.set(c.member_id, g);
  }

  let repaired = 0;
  let skipped = 0;

  const skip = (reason: string, ids: string[], extra?: Record<string, unknown>) => {
    skipped++;
    logs.push({
      msg: 'empty active duplicate skipped',
      fields: { id: 15, client_id: ids[0] ?? null, reason, match: 'sameClientType', candidates: ids, ...extra },
    });
  };

  for (const [, platforms] of byMember) {
    const parent = platforms.map((_, i) => i);
    const find = (i: number): number => {
      let x = i;
      while (parent[x] !== x) {
        parent[x] = parent[parent[x]!];
        x = parent[x]!;
      }
      return x;
    };
    const union = (i: number, j: number) => {
      const a = find(i);
      const b = find(j);
      if (a !== b) parent[a] = b;
    };

    const infos = platforms.map((p) => boundInfo(db, p));
    for (let i = 0; i < platforms.length; i++) {
      for (let j = i + 1; j < platforms.length; j++) {
        const a = infos[i];
        const b = infos[j];
        if (a && b && sameClientType(a, b)) union(i, j);
      }
    }

    const groups = new Map<number, Conn[]>();
    for (let i = 0; i < platforms.length; i++) {
      const root = find(i);
      const g = groups.get(root) ?? [];
      g.push(platforms[i]!);
      groups.set(root, g);
    }

    for (const group of groups.values()) {
      const originals = group.filter((c) => platformIsConfigured(db, c));
      const empties = group.filter((c) => qualifiesAsEmptyDuplicate(db, c));
      const candidateIds = group.map((c) => c.client_id);

      // A lone configured platform or a lone empty platform is not a duplicate.
      if (group.length < 2) continue;
      if (empties.length === 0) continue;

      if (originals.length !== 1 || empties.length !== 1 || group.length !== 2) {
        skip(originals.length === 0 ? 'no_original' : 'ambiguous', candidateIds, {
          originals: originals.map((c) => c.client_id),
          duplicates: empties.map((c) => c.client_id),
        });
        continue;
      }

      const original = originals[0]!;
      const duplicate = empties[0]!;

      if (!createdAfter(duplicate.created_at, original.created_at)) {
        skip('duplicate_not_later', [duplicate.client_id, original.client_id]);
        continue;
      }
      // Only the case migration 14 skipped: the original was used after the duplicate was approved.
      if (notAfter(original.last_activity_at, duplicate.approved_at)) {
        skip('not_original_still_active', [duplicate.client_id, original.client_id]);
        continue;
      }

      applyArchive(db, original, duplicate);
      repaired++;
      logs.push({
        msg: 'empty active duplicate archived',
        fields: {
          id: 15,
          from_client_id: duplicate.client_id,
          into_client_id: original.client_id,
          match: 'sameClientType',
          candidates: [original.client_id, duplicate.client_id],
        },
      });
    }
  }

  logs.push({ msg: 'empty active duplicate repair complete', fields: { id: 15, repaired, skipped } });
  return logs;
}

function applyArchive(db: DatabaseSync, original: Conn, duplicate: Conn): void {
  const at = isoNow();
  const dupClient = duplicate.current_client_id || duplicate.client_id;
  const originalClient = original.current_client_id || original.client_id;

  run(
    db,
    `UPDATE connection
        SET merged_into_client_id = ?, revoked_at = ?, current_client_id = NULL
      WHERE client_id = ?`,
    original.client_id,
    at,
    duplicate.client_id,
  );
  dropGrants(db, dupClient);
  if (duplicate.client_id !== dupClient) dropGrants(db, duplicate.client_id);

  const data = JSON.stringify({
    from_client_id: duplicate.client_id,
    into_client_id: original.client_id,
    current_client_id: originalClient,
    agents_unchanged: true,
    allow_list_unchanged: true,
    tokens_unchanged: true,
    kind: 'migration',
    reason: 'empty_active_duplicate',
  });
  run(
    db,
    `INSERT INTO event (member_id, at, actor_kind, connection_id, connection_name, entity_type, entity_id, action, summary, data)
     VALUES (?, ?, 'system', ?, ?, 'connection', ?, 'connection.merged', ?, ?)`,
    original.member_id,
    at,
    original.client_id,
    original.name,
    duplicate.client_id,
    `Archived empty platform "${duplicate.name}" next to "${original.name}"`,
    data,
  );

  // from_client_id = to_client_id: the original's accepted client does not change.
  // archived_client_id lets the owner undo the archive from Platforms.
  run(
    db,
    `INSERT INTO connection_transfer
       (member_id, platform_client_id, from_client_id, to_client_id, previous_approved_at, kind, archived_client_id, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    original.member_id,
    original.client_id,
    originalClient,
    originalClient,
    original.approved_at,
    'migration',
    duplicate.client_id,
    at,
  );
}
