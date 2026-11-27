/**
 * Frozen as of migration 14 (`repair-reauth-duplicate-connections`).
 * Do not change this file's behaviour except to fix a bug in these exact rules.
 * Re-auth continuation (consent) lives in src/auth/connections.ts and may evolve; this
 * repair must keep the 14 semantics even if those functions later change.
 */
import type { DatabaseSync } from 'node:sqlite';

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

function all<T>(db: DatabaseSync, sql: string, ...params: unknown[]): T[] {
  return db.prepare(sql).all(...(params as never[])) as T[];
}
function get<T>(db: DatabaseSync, sql: string, ...params: unknown[]): T | undefined {
  return db.prepare(sql).get(...(params as never[])) as T | undefined;
}
function run(db: DatabaseSync, sql: string, ...params: unknown[]) {
  return db.prepare(sql).run(...(params as never[]));
}

/** Normalize a redirect URI for set comparison: lower-case host, no trailing slash on the path, no hash. */
export function normalizeRedirectUri(raw: string): string {
  const s = raw.trim();
  try {
    const u = new URL(s);
    let path = u.pathname;
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    return `${u.protocol}//${u.host.toLowerCase()}${path}${u.search}`;
  } catch {
    return s.replace(/\/+$/, '');
  }
}

function parseRedirectUris(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v !== 'string' || !v) return [];
  try {
    const p = JSON.parse(v);
    return Array.isArray(p) ? p.map(String) : [v];
  } catch {
    return v.split(/[\s,]+/).filter(Boolean);
  }
}

export function redirectUriKey(uris: string[]): string | null {
  const n = [...new Set(uris.map(normalizeRedirectUri).filter(Boolean))].sort();
  return n.length ? n.join('\n') : null;
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

/**
 * Bind each empty later platform to the one earlier configured platform that shares
 * its redirect-URI set, when the pair is unique and the original was unused after
 * the duplicate was approved. Otherwise skip and report. Never matches by name.
 * Never bumps approved_at (a live token on the duplicate must keep working).
 * Never copies the duplicate's allow-list or agents onto the original.
 */
function tableExists(db: DatabaseSync, name: string): boolean {
  return !!get(db, "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", name);
}

export function repairReauthDuplicateConnections(db: DatabaseSync): MigrationLog[] {
  const logs: MigrationLog[] = [];
  if (!tableExists(db, 'oauthClient') || !tableExists(db, 'connection')) {
    logs.push({ msg: 'connection duplicate repair complete', fields: { id: 14, repaired: 0, skipped: 0 } });
    return logs;
  }
  const connections = all<Conn>(
    db,
    `SELECT client_id, member_id, name, created_at, approved_at, last_activity_at, revoked_at,
            roles_confirmed_at, current_client_id, merged_into_client_id
       FROM connection`,
  );

  const uriOf = new Map<string, string | null>();
  for (const c of connections) {
    const row = get<{ redirectUris: unknown }>(db, 'SELECT redirectUris FROM oauthClient WHERE clientId = ?', c.client_id);
    uriOf.set(c.client_id, row ? redirectUriKey(parseRedirectUris(row.redirectUris)) : null);
  }

  const agentCount = new Map<string, number>();
  for (const r of all<{ client_id: string; n: number }>(db, 'SELECT client_id, count(*) AS n FROM agent WHERE client_id IS NOT NULL GROUP BY client_id')) {
    agentCount.set(r.client_id, r.n);
  }

  type Candidate = Conn & { uri: string | null; agents: number; configured: boolean; empty: boolean };
  const live: Candidate[] = [];
  for (const c of connections) {
    if (c.revoked_at || c.merged_into_client_id) continue;
    const agents = agentCount.get(c.client_id) ?? 0;
    const configured = agents > 0 || !!c.roles_confirmed_at;
    const empty = agents === 0 && !c.roles_confirmed_at;
    live.push({ ...c, uri: uriOf.get(c.client_id) ?? null, agents, configured, empty });
  }

  const groups = new Map<string, Candidate[]>();
  const noUri: Candidate[] = [];
  for (const c of live) {
    if (!c.uri) {
      noUri.push(c);
      continue;
    }
    const key = `${c.member_id}\n${c.uri}`;
    const g = groups.get(key) ?? [];
    g.push(c);
    groups.set(key, g);
  }

  // Platforms with no redirect URIs are never auto-repaired (name is not an identity).
  for (const c of noUri.filter((x) => x.empty)) {
    logs.push({
      msg: 'connection duplicate skipped',
      fields: {
        id: 14,
        client_id: c.client_id,
        reason: 'no_redirect_uri',
        match: false,
        candidates: [c.client_id],
      },
    });
  }

  let repaired = 0;
  let skipped = logs.length;

  const skip = (reason: string, ids: string[], extra?: Record<string, unknown>) => {
    skipped++;
    logs.push({
      msg: 'connection duplicate skipped',
      fields: { id: 14, client_id: ids[0] ?? null, reason, match: 'redirect_uri', candidates: ids, ...extra },
    });
  };

  for (const [, group] of groups) {
    const originals = group.filter((c) => c.configured);
    const duplicates = group.filter((c) => c.empty);
    // A live platform that is neither configured nor empty cannot happen given the definitions.
    const candidateIds = group.map((c) => c.client_id);

    if (duplicates.length === 0) continue;

    if (originals.length !== 1 || duplicates.length !== 1) {
      skip(originals.length === 0 ? 'no_original' : 'ambiguous', candidateIds, {
        originals: originals.map((c) => c.client_id),
        duplicates: duplicates.map((c) => c.client_id),
      });
      continue;
    }

    const original = originals[0]!;
    const duplicate = duplicates[0]!;

    if (!createdAfter(duplicate.created_at, original.created_at)) {
      skip('duplicate_not_later', [duplicate.client_id, original.client_id]);
      continue;
    }
    if (!notAfter(original.last_activity_at, duplicate.approved_at)) {
      skip('original_still_active', [duplicate.client_id, original.client_id]);
      continue;
    }

    applyRepair(db, original, duplicate);
    repaired++;
    logs.push({
      msg: 'connection duplicate repaired',
      fields: {
        id: 14,
        from_client_id: duplicate.client_id,
        into_client_id: original.client_id,
        match: 'redirect_uri',
        candidates: [original.client_id, duplicate.client_id],
      },
    });
  }

  logs.push({ msg: 'connection duplicate repair complete', fields: { id: 14, repaired, skipped } });
  return logs;
}

function applyRepair(db: DatabaseSync, original: Conn, duplicate: Conn): void {
  const at = isoNow();
  // Drop grants of the original's previous OAuth client only. The duplicate's tokens stay,
  // because its client id becomes current_client_id. approved_at is not touched.
  dropGrants(db, original.current_client_id ?? original.client_id);

  // Cursors: copy a key only when the original lacks it; never raise last_event_id.
  const dupCursors = all<{ role_key: string; last_event_id: number }>(
    db,
    'SELECT role_key, last_event_id FROM start_cursor WHERE connection_id = ?',
    duplicate.client_id,
  );
  for (const cur of dupCursors) {
    const have = get<{ last_event_id: number }>(
      db,
      'SELECT last_event_id FROM start_cursor WHERE connection_id = ? AND role_key = ?',
      original.client_id,
      cur.role_key,
    );
    if (!have) {
      run(
        db,
        'INSERT INTO start_cursor (connection_id, role_key, last_event_id, updated_at) VALUES (?,?,?,?)',
        original.client_id,
        cur.role_key,
        cur.last_event_id,
        at,
      );
    }
  }
  run(db, 'DELETE FROM start_cursor WHERE connection_id = ?', duplicate.client_id);

  run(
    db,
    `UPDATE connection
        SET current_client_id = NULL,
            revoked_at = ?,
            merged_into_client_id = ?
      WHERE client_id = ?`,
    at,
    original.client_id,
    duplicate.client_id,
  );

  run(db, 'UPDATE connection SET current_client_id = ? WHERE client_id = ?', duplicate.client_id, original.client_id);

  const data = JSON.stringify({
    from_client_id: duplicate.client_id,
    into_client_id: original.client_id,
    current_client_id: duplicate.client_id,
    agents_unchanged: true,
    allow_list_unchanged: true,
    kind: 'migration',
  });
  run(
    db,
    `INSERT INTO event (member_id, at, actor_kind, connection_id, connection_name, entity_type, entity_id, action, summary, data)
     VALUES (?, ?, 'system', ?, ?, 'connection', ?, 'connection.merged', ?, ?)`,
    original.member_id,
    at,
    original.client_id,
    original.name,
    original.client_id,
    `Merged a duplicate platform into "${original.name}"`,
    data,
  );

  run(
    db,
    `INSERT INTO connection_transfer
       (member_id, platform_client_id, from_client_id, to_client_id, previous_approved_at, kind, archived_client_id, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    original.member_id,
    original.client_id,
    original.current_client_id ?? original.client_id,
    duplicate.client_id,
    original.approved_at,
    'migration',
    duplicate.client_id,
    at,
  );
}

function dropGrants(db: DatabaseSync, clientId: string): void {
  if (!clientId) return;
  for (const table of ['oauthAccessToken', 'oauthRefreshToken', 'oauthConsent']) {
    if (tableExists(db, table)) run(db, `DELETE FROM ${table} WHERE clientId = ?`, clientId);
  }
}
