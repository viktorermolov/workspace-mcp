import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { checkAccess, getConnection, pendingTransfer, rollbackClientTransfer } from '../src/auth/connections.ts';
import { all, get, openDatabase, run, runAppMigrations, tx, type DB } from '../src/db/db.ts';
import { repairEmptyActiveDuplicates } from '../src/db/repair-empty-active-duplicates.ts';
import { migrations } from '../src/db/schema.ts';
import { setLogLevel } from '../src/util/log.ts';

const GROK_CB = 'https://grok.com/connectors-oauth-exchange-code/';
const CLAUDE_CB = 'https://claude.ai/api/mcp/auth/callback';
const MANUS_CB = 'https://manus.example/connectors-oauth-exchange-code/';
const CHATGPT_CB = 'https://chatgpt.com/connectors/oauth/callback';

function tmpDb(): { dir: string; db: DB; close(): void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-m15-'));
  const db = openDatabase(path.join(dir, 'w.sqlite'));
  return {
    dir,
    db,
    close() {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function applyThrough(db: DB, lastId: number): void {
  db.exec('CREATE TABLE IF NOT EXISTS app_migration (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  for (const m of migrations.filter((x) => x.id <= lastId)) {
    tx(db, () => {
      if (m.sql) db.exec(m.sql);
      run(db, 'INSERT INTO app_migration (id, name, applied_at) VALUES (?, ?, ?)', m.id, m.name, '2026-01-01T00:00:00.000Z');
    });
  }
}

function applyOne(db: DB, id: number): ReturnType<NonNullable<(typeof migrations)[number]['run']>> {
  const m = migrations.find((x) => x.id === id);
  if (!m) throw new Error(`missing migration ${id}`);
  let notes: ReturnType<NonNullable<typeof m.run>> = [];
  tx(db, () => {
    if (m.sql) db.exec(m.sql);
    if (m.run) notes = m.run(db) ?? [];
    run(db, 'INSERT INTO app_migration (id, name, applied_at) VALUES (?, ?, ?)', m.id, m.name, new Date().toISOString());
  });
  return notes;
}

function stubOauth(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS oauthClient (
      id TEXT PRIMARY KEY,
      clientId TEXT UNIQUE NOT NULL,
      name TEXT,
      uri TEXT,
      icon TEXT,
      redirectUris TEXT,
      tokenEndpointAuthMethod TEXT,
      clientDiscoveryId TEXT,
      userId TEXT,
      disabled INTEGER DEFAULT 0,
      createdAt TEXT
    );
    CREATE TABLE IF NOT EXISTS oauthAccessToken (id TEXT PRIMARY KEY, clientId TEXT, token TEXT);
    CREATE TABLE IF NOT EXISTS oauthRefreshToken (id TEXT PRIMARY KEY, clientId TEXT, token TEXT);
    CREATE TABLE IF NOT EXISTS oauthConsent (id TEXT PRIMARY KEY, clientId TEXT, scopes TEXT);
  `);
}

function putClient(db: DB, id: string, opts: { name?: string; uris?: string[]; method?: string } = {}): void {
  const uris = JSON.stringify(opts.uris ?? [GROK_CB]);
  run(
    db,
    `INSERT INTO oauthClient (id, clientId, name, redirectUris, tokenEndpointAuthMethod, createdAt)
     VALUES (?,?,?,?,?,?)`,
    `row_${id}`,
    id,
    opts.name ?? 'Grok',
    uris,
    opts.method ?? 'none',
    '2026-01-01T00:00:00.000Z',
  );
}

function putConnection(
  db: DB,
  id: string,
  opts: {
    member?: string;
    name?: string;
    created?: string;
    approved?: string;
    activity?: string | null;
    revoked?: string | null;
    confirmed?: string | null;
    sole?: number;
  } = {},
): void {
  const member = opts.member ?? 'mem_1';
  const created = opts.created ?? '2026-06-01T00:00:00.000Z';
  const approved = opts.approved ?? created;
  run(
    db,
    `INSERT INTO connection (client_id, member_id, name, client_name, created_at, approved_at, last_activity_at, revoked_at, roles_confirmed_at, sole_agent)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    id,
    member,
    opts.name ?? id,
    opts.name ?? id,
    created,
    approved,
    opts.activity === undefined ? null : opts.activity,
    opts.revoked ?? null,
    opts.confirmed ?? null,
    opts.sole ?? 0,
  );
}

function seedMember(db: DB): void {
  const t = '2026-01-01T00:00:00.000Z';
  run(db, "INSERT INTO member (id, name, is_owner, created_at) VALUES ('mem_1', 'Owner', 1, ?)", t);
  run(db, "INSERT INTO role (id, member_id, slug, name, created_at, updated_at) VALUES ('role_dev', 'mem_1', 'developer', 'Developer', ?, ?)", t, t);
}

function addAgent(db: DB, clientId: string, slug: string, at = '2026-06-01T00:00:00.000Z'): void {
  const memberId =
    get<{ member_id: string }>(db, 'SELECT member_id FROM connection WHERE client_id = ?', clientId)?.member_id ?? 'mem_1';
  run(
    db,
    'INSERT INTO agent (id, member_id, slug, name, client_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
    `agt_${slug}`,
    memberId,
    slug,
    slug,
    clientId,
    at,
    at,
  );
}

function confirmRoles(db: DB, clientId: string, roleId = 'role_dev'): void {
  run(db, "INSERT INTO connection_role (client_id, role_id, source) VALUES (?, ?, 'owner')", clientId, roleId);
  run(db, 'UPDATE connection SET roles_confirmed_at = approved_at WHERE client_id = ?', clientId);
}

function putEvent(
  db: DB,
  opts: { clientId: string; action: string; at?: string; entityType?: string; entityId?: string; agent?: string | null },
): void {
  const at = opts.at ?? '2026-11-01T00:00:00.000Z';
  const entityType = opts.entityType ?? 'connection';
  const entityId = opts.entityId ?? opts.clientId;
  run(
    db,
    `INSERT INTO event (member_id, at, actor_kind, connection_id, connection_name, entity_type, entity_id, action, summary, data, agent)
     VALUES ('mem_1', ?, 'agent', ?, ?, ?, ?, ?, ?, '{}', ?)`,
    at,
    opts.clientId,
    opts.clientId,
    entityType,
    entityId,
    opts.action,
    opts.action,
    opts.agent ?? null,
  );
}

function captureStdout(fn: () => void): string {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: typeof process.stdout.write }).write = ((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    fn();
  } finally {
    process.stdout.write = orig;
  }
  return chunks.join('');
}

function repairedOf(logs: { fields: Record<string, unknown> }[]): number {
  const last = logs.filter((l) => l.fields && 'repaired' in l.fields).at(-1);
  return Number(last?.fields.repaired ?? -1);
}

/** 0.6.0 starting point: migration 14 skipped CtvfJ as original_still_active; the other three as no_original. */
function seedBothActiveModel(db: DB): void {
  seedMember(db);
  putClient(db, 'BfLCn', { name: 'Grok', uris: [GROK_CB] });
  putClient(db, 'CtvfJ', { name: 'Grok', uris: [GROK_CB] });
  putClient(db, 'claude', { name: 'Claude', uris: [CLAUDE_CB] });
  putClient(db, 'manus', { name: 'Manus', uris: [MANUS_CB] });
  putClient(db, 'chatgpt', { name: 'ChatGPT', uris: [CHATGPT_CB] });

  putConnection(db, 'BfLCn', {
    name: 'Grok',
    created: '2026-11-01T00:00:00.000Z',
    approved: '2026-11-01T00:00:00.000Z',
    activity: '2026-11-27T18:00:00.000Z',
    confirmed: '2026-11-01T00:00:00.000Z',
    sole: 1,
  });
  confirmRoles(db, 'BfLCn');
  addAgent(db, 'BfLCn', 'grok-dev', '2026-11-01T00:00:00.000Z');
  putEvent(db, { clientId: 'BfLCn', action: 'connection.approved', at: '2026-11-01T00:00:00.000Z' });
  for (let i = 1; i <= 7; i++) {
    putEvent(db, { clientId: 'BfLCn', action: 'task.updated', at: `2026-11-0${Math.min(i, 9)}T12:00:00.000Z` });
  }
  for (let i = 1; i <= 15; i++) {
    run(db, 'INSERT INTO oauthRefreshToken (id, clientId, token) VALUES (?,?,?)', `rt_bflcn_${i}`, 'BfLCn', `SECRETTOKEN_bflcn_${i}`);
  }
  run(db, "INSERT INTO oauthAccessToken (id, clientId, token) VALUES ('at_bflcn', 'BfLCn', 'SECRETTOKEN_bflcn_access')");

  putConnection(db, 'CtvfJ', {
    name: 'Grok leftover',
    created: '2026-11-27T16:59:50.000Z',
    approved: '2026-11-27T16:59:50.000Z',
    activity: null,
  });
  putEvent(db, { clientId: 'CtvfJ', action: 'connection.approved', at: '2026-11-27T16:59:50.000Z' });
  // Unused / empty consent must not count as configuration and must be revoked on archive.
  run(db, "INSERT INTO oauthConsent (id, clientId, scopes) VALUES ('consent_ctvfj', 'CtvfJ', '')");

  putConnection(db, 'claude', { name: 'Claude', created: '2026-11-20T00:00:00.000Z', approved: '2026-11-20T00:00:00.000Z' });
  putEvent(db, { clientId: 'claude', action: 'connection.approved', at: '2026-11-20T00:00:00.000Z' });
  putConnection(db, 'manus', { name: 'Manus', created: '2026-11-21T00:00:00.000Z', approved: '2026-11-21T00:00:00.000Z' });
  putConnection(db, 'chatgpt', { name: 'ChatGPT', created: '2026-11-22T00:00:00.000Z', approved: '2026-11-22T00:00:00.000Z' });
}

describe('migration 15 repair-empty-active-duplicates', () => {
  it('upgrades from 0.6.0: archives the empty still-active duplicate, leaves the original and other platforms alone, and is idempotent', () => {
    const { db, close } = tmpDb();
    try {
      applyThrough(db, 13);
      stubOauth(db);
      seedBothActiveModel(db);

      const logs14 = applyOne(db, 14);
      assert.ok(logs14.some((l) => l.fields.reason === 'original_still_active' && (l.fields.candidates as string[]).includes('CtvfJ')));
      assert.ok(logs14.some((l) => l.fields.reason === 'no_original' && (l.fields.candidates as string[]).includes('claude')));
      assert.ok(logs14.some((l) => l.fields.reason === 'no_original' && (l.fields.candidates as string[]).includes('manus')));
      assert.ok(logs14.some((l) => l.fields.reason === 'no_original' && (l.fields.candidates as string[]).includes('chatgpt')));
      assert.equal(getConnection(db, 'CtvfJ')!.merged_into_client_id, null);
      assert.equal(get<{ n: number }>(db, "SELECT count(*) AS n FROM oauthRefreshToken WHERE clientId = 'BfLCn'")!.n, 15);

      // After 0.6.0, a lone platform later gets an agent; migration 15 must not touch it.
      addAgent(db, 'claude', 'duet', '2026-11-27T19:08:00.000Z');

      setLogLevel('info');
      const out = captureStdout(() => {
        assert.equal(runAppMigrations(db), 2);
      });
      assert.match(out, /empty active duplicate archived/);
      assert.match(out, /repair-empty-active-duplicates/);
      assert.doesNotMatch(out, /SECRETTOKEN/);
      assert.equal(get<{ n: number }>(db, 'SELECT count(*) AS n FROM app_migration WHERE id = 15')!.n, 1);

      const orig = getConnection(db, 'BfLCn')!;
      assert.equal(orig.current_client_id, 'BfLCn');
      assert.equal(orig.approved_at, '2026-11-01T00:00:00.000Z', 'migration 15 must not bump the original approved_at');
      assert.equal(orig.last_activity_at, '2026-11-27T18:00:00.000Z');
      assert.equal(orig.revoked_at, null);
      assert.equal(orig.merged_into_client_id, null);
      assert.equal(orig.sole_agent, 1);
      assert.equal(get<{ n: number }>(db, "SELECT count(*) AS n FROM agent WHERE client_id = 'BfLCn'")!.n, 1);
      assert.equal(get<{ n: number }>(db, "SELECT count(*) AS n FROM oauthRefreshToken WHERE clientId = 'BfLCn'")!.n, 15);
      assert.ok(get(db, "SELECT 1 FROM oauthAccessToken WHERE clientId = 'BfLCn'"));

      const dup = getConnection(db, 'CtvfJ')!;
      assert.ok(dup.revoked_at);
      assert.equal(dup.merged_into_client_id, 'BfLCn');
      assert.equal(dup.current_client_id, null);
      assert.equal(get(db, "SELECT 1 FROM oauthConsent WHERE clientId = 'CtvfJ'"), undefined);
      assert.equal(get(db, "SELECT 1 FROM oauthRefreshToken WHERE clientId = 'CtvfJ'"), undefined);
      assert.equal(get(db, "SELECT 1 FROM oauthAccessToken WHERE clientId = 'CtvfJ'"), undefined);

      const ev = get<{ action: string; summary: string; entity_id: string; data: string }>(
        db,
        "SELECT action, summary, entity_id, data FROM event WHERE action = 'connection.merged' AND entity_id = 'CtvfJ'",
      );
      assert.ok(ev);
      assert.match(ev!.summary, /Archived empty platform/);
      assert.match(ev!.data, /empty_active_duplicate/);

      const transfer = pendingTransfer(db, 'BfLCn');
      assert.ok(transfer);
      assert.equal(transfer!.kind, 'migration');
      assert.equal(transfer!.archived_client_id, 'CtvfJ');
      assert.equal(transfer!.from_client_id, 'BfLCn');
      assert.equal(transfer!.to_client_id, 'BfLCn');
      assert.equal(transfer!.previous_approved_at, '2026-11-01T00:00:00.000Z');

      const claude = getConnection(db, 'claude')!;
      assert.equal(claude.merged_into_client_id, null);
      assert.equal(claude.revoked_at, null);
      assert.equal(get<{ slug: string }>(db, "SELECT slug FROM agent WHERE client_id = 'claude'")!.slug, 'duet');

      for (const id of ['manus', 'chatgpt']) {
        const row = getConnection(db, id)!;
        assert.equal(row.merged_into_client_id, null, `${id} must stay as it is`);
        assert.equal(row.revoked_at, null, `${id} must stay as it is`);
        assert.equal(row.current_client_id, id);
      }

      const second = repairEmptyActiveDuplicates(db);
      assert.equal(repairedOf(second), 0);
      assert.equal(getConnection(db, 'CtvfJ')!.merged_into_client_id, 'BfLCn');
      assert.equal(get<{ n: number }>(db, "SELECT count(*) AS n FROM oauthRefreshToken WHERE clientId = 'BfLCn'")!.n, 15);
    } finally {
      close();
    }
  });

  it('leaves a lone platform with an agent and a lone empty platform unchanged', () => {
    const { db, close } = tmpDb();
    try {
      applyThrough(db, 13);
      stubOauth(db);
      seedMember(db);
      putClient(db, 'soloAgent', { name: 'Claude', uris: [CLAUDE_CB] });
      putClient(db, 'soloEmpty', { name: 'Manus', uris: [MANUS_CB] });
      putConnection(db, 'soloAgent', { name: 'Claude', created: '2026-11-01T00:00:00.000Z', approved: '2026-11-01T00:00:00.000Z' });
      addAgent(db, 'soloAgent', 'duet', '2026-11-27T19:08:00.000Z');
      putConnection(db, 'soloEmpty', { name: 'Manus', created: '2026-11-21T00:00:00.000Z', approved: '2026-11-21T00:00:00.000Z' });
      applyOne(db, 14);
      assert.equal(runAppMigrations(db), 2);

      const agentPlat = getConnection(db, 'soloAgent')!;
      assert.equal(agentPlat.merged_into_client_id, null);
      assert.equal(agentPlat.revoked_at, null);
      assert.equal(agentPlat.current_client_id, 'soloAgent');
      assert.equal(get<{ n: number }>(db, "SELECT count(*) AS n FROM agent WHERE client_id = 'soloAgent' AND slug = 'duet'")!.n, 1);

      const emptyPlat = getConnection(db, 'soloEmpty')!;
      assert.equal(emptyPlat.merged_into_client_id, null);
      assert.equal(emptyPlat.revoked_at, null);
      assert.equal(emptyPlat.current_client_id, 'soloEmpty');
      assert.equal(pendingTransfer(db, 'soloAgent'), undefined);
      assert.equal(pendingTransfer(db, 'soloEmpty'), undefined);
    } finally {
      close();
    }
  });

  it('does not treat an empty consent row as configuration, and still archives the duplicate', () => {
    const { db, close } = tmpDb();
    try {
      applyThrough(db, 13);
      stubOauth(db);
      seedMember(db);
      putClient(db, 'orig');
      putClient(db, 'dup');
      putConnection(db, 'orig', {
        created: '2026-01-01T00:00:00.000Z',
        confirmed: '2026-01-01T00:00:00.000Z',
        activity: '2026-04-01T00:00:00.000Z',
      });
      confirmRoles(db, 'orig');
      addAgent(db, 'orig', 'bot');
      putConnection(db, 'dup', { created: '2026-03-01T00:00:00.000Z', approved: '2026-03-01T00:00:00.000Z' });
      putEvent(db, { clientId: 'dup', action: 'connection.approved', at: '2026-03-01T00:00:00.000Z' });
      run(db, "INSERT INTO oauthConsent (id, clientId, scopes) VALUES ('empty_consent', 'dup', '')");
      applyOne(db, 14);
      const logs = applyOne(db, 15);
      assert.equal(repairedOf(logs), 1);
      assert.equal(getConnection(db, 'dup')!.merged_into_client_id, 'orig');
      assert.equal(get(db, "SELECT 1 FROM oauthConsent WHERE clientId = 'dup'"), undefined);
    } finally {
      close();
    }
  });

  it('does not archive a duplicate that has a journal entry besides approve', () => {
    const { db, close } = tmpDb();
    try {
      applyThrough(db, 13);
      stubOauth(db);
      seedMember(db);
      putClient(db, 'orig');
      putClient(db, 'dup');
      putConnection(db, 'orig', {
        created: '2026-01-01T00:00:00.000Z',
        confirmed: '2026-01-01T00:00:00.000Z',
        activity: '2026-04-01T00:00:00.000Z',
      });
      confirmRoles(db, 'orig');
      addAgent(db, 'orig', 'bot');
      putConnection(db, 'dup', { created: '2026-03-01T00:00:00.000Z', approved: '2026-03-01T00:00:00.000Z' });
      putEvent(db, { clientId: 'dup', action: 'connection.approved', at: '2026-03-01T00:00:00.000Z' });
      putEvent(db, { clientId: 'dup', action: 'connection.renamed', at: '2026-03-02T00:00:00.000Z' });
      applyOne(db, 14);
      const logs = applyOne(db, 15);
      assert.equal(repairedOf(logs), 0);
      assert.equal(getConnection(db, 'dup')!.merged_into_client_id, null);
    } finally {
      close();
    }
  });

  it('does not archive a same-type platform that has an agent or confirmed roles', () => {
    const { db, close } = tmpDb();
    try {
      applyThrough(db, 13);
      stubOauth(db);
      seedMember(db);
      putClient(db, 'orig');
      putClient(db, 'agentTwin');
      putClient(db, 'origB', { name: 'Other', uris: [CHATGPT_CB] });
      putClient(db, 'roleTwinB', { name: 'Other', uris: [CHATGPT_CB] });

      putConnection(db, 'orig', {
        created: '2026-01-01T00:00:00.000Z',
        confirmed: '2026-01-01T00:00:00.000Z',
        activity: '2026-04-01T00:00:00.000Z',
      });
      confirmRoles(db, 'orig');
      addAgent(db, 'orig', 'orig-bot');
      putConnection(db, 'agentTwin', { created: '2026-03-01T00:00:00.000Z', approved: '2026-03-01T00:00:00.000Z' });
      addAgent(db, 'agentTwin', 'twin-bot');

      putConnection(db, 'origB', {
        name: 'Other',
        created: '2026-01-01T00:00:00.000Z',
        confirmed: '2026-01-01T00:00:00.000Z',
        activity: '2026-04-01T00:00:00.000Z',
      });
      confirmRoles(db, 'origB');
      addAgent(db, 'origB', 'other-bot');
      putConnection(db, 'roleTwinB', {
        name: 'Other',
        created: '2026-03-01T00:00:00.000Z',
        approved: '2026-03-01T00:00:00.000Z',
        confirmed: '2026-03-01T00:00:00.000Z',
      });
      confirmRoles(db, 'roleTwinB');

      applyOne(db, 14);
      const logs = applyOne(db, 15);
      assert.equal(repairedOf(logs), 0);
      assert.equal(getConnection(db, 'agentTwin')!.merged_into_client_id, null);
      assert.equal(getConnection(db, 'roleTwinB')!.merged_into_client_id, null);
    } finally {
      close();
    }
  });

  it('does not archive when the pair is not unique', () => {
    const { db, close } = tmpDb();
    try {
      applyThrough(db, 13);
      stubOauth(db);
      seedMember(db);
      for (const id of ['orig', 'empty1', 'empty2']) putClient(db, id);
      putConnection(db, 'orig', {
        created: '2026-01-01T00:00:00.000Z',
        confirmed: '2026-01-01T00:00:00.000Z',
        activity: '2026-05-01T00:00:00.000Z',
      });
      confirmRoles(db, 'orig');
      addAgent(db, 'orig', 'bot');
      putConnection(db, 'empty1', { created: '2026-03-01T00:00:00.000Z', approved: '2026-03-01T00:00:00.000Z' });
      putConnection(db, 'empty2', { created: '2026-04-01T00:00:00.000Z', approved: '2026-04-01T00:00:00.000Z' });
      applyOne(db, 14);
      const logs = applyOne(db, 15);
      assert.equal(repairedOf(logs), 0);
      assert.ok(logs.some((l) => l.fields.reason === 'ambiguous'));
      assert.equal(getConnection(db, 'empty1')!.merged_into_client_id, null);
      assert.equal(getConnection(db, 'empty2')!.merged_into_client_id, null);
      assert.equal(getConnection(db, 'orig')!.current_client_id, 'orig');
    } finally {
      close();
    }
  });

  it('rollback of a migration 15 archive un-archives the duplicate and leaves the original tokens valid', () => {
    const { db, close } = tmpDb();
    try {
      applyThrough(db, 13);
      stubOauth(db);
      seedMember(db);
      putClient(db, 'BfLCn');
      putClient(db, 'CtvfJ');
      putConnection(db, 'BfLCn', {
        name: 'Grok',
        created: '2026-01-01T00:00:00.000Z',
        approved: '2026-01-01T00:00:00.000Z',
        confirmed: '2026-01-01T00:00:00.000Z',
        activity: '2026-04-01T00:00:00.000Z',
      });
      confirmRoles(db, 'BfLCn');
      addAgent(db, 'BfLCn', 'bot');
      putConnection(db, 'CtvfJ', { name: 'Grok leftover', created: '2026-03-01T00:00:00.000Z', approved: '2026-03-01T00:00:00.000Z' });
      run(db, "INSERT INTO oauthRefreshToken (id, clientId, token) VALUES ('rt_orig', 'BfLCn', 'SECRETTOKEN_orig')");
      run(db, "INSERT INTO oauthConsent (id, clientId, scopes) VALUES ('c_dup', 'CtvfJ', '')");
      applyOne(db, 14);
      applyOne(db, 15);
      assert.equal(getConnection(db, 'CtvfJ')!.merged_into_client_id, 'BfLCn');
      assert.equal(get<{ n: number }>(db, "SELECT count(*) AS n FROM oauthRefreshToken WHERE clientId = 'BfLCn'")!.n, 1);

      const iat = Math.floor(Date.parse('2026-04-01T00:00:00.000Z') / 1000);
      rollbackClientTransfer(db, { kind: 'owner', memberId: 'mem_1' }, 'BfLCn');

      const orig = getConnection(db, 'BfLCn')!;
      const dup = getConnection(db, 'CtvfJ')!;
      assert.equal(orig.current_client_id, 'BfLCn');
      assert.equal(orig.approved_at, '2026-01-01T00:00:00.000Z');
      assert.equal(dup.merged_into_client_id, null);
      assert.equal(dup.revoked_at, null);
      assert.equal(dup.current_client_id, 'CtvfJ');
      assert.equal(dup.approved_at, '2026-03-01T00:00:00.000Z');
      assert.equal(pendingTransfer(db, 'BfLCn'), undefined);
      assert.equal(checkAccess(db, 'BfLCn', iat).ok, true);
      assert.equal(get<{ n: number }>(db, "SELECT count(*) AS n FROM oauthRefreshToken WHERE clientId = 'BfLCn' AND token = 'SECRETTOKEN_orig'")!.n, 1);
      assert.equal(get(db, "SELECT 1 FROM oauthConsent WHERE clientId = 'CtvfJ'"), undefined);
      assert.equal(get(db, "SELECT 1 FROM oauthRefreshToken WHERE clientId = 'CtvfJ'"), undefined);
      const ev = get<{ action: string; summary: string; data: string }>(
        db,
        "SELECT action, summary, data FROM event WHERE action = 'connection.transfer_rolled_back' AND entity_id = 'BfLCn'",
      );
      assert.ok(ev);
      assert.match(ev!.summary, /Rolled back a client transfer/);
      assert.match(ev!.data, /"kind":"migration"/);
    } finally {
      close();
    }
  });

  it('does not alter a pair that migration 14 already bound, including that pair’s tokens', () => {
    const { db, close } = tmpDb();
    try {
      applyThrough(db, 13);
      stubOauth(db);
      seedMember(db);
      putClient(db, 'orig');
      putClient(db, 'dup');
      putConnection(db, 'orig', {
        created: '2026-01-01T00:00:00.000Z',
        approved: '2026-01-01T00:00:00.000Z',
        confirmed: '2026-01-01T00:00:00.000Z',
        activity: '2026-01-15T00:00:00.000Z',
      });
      confirmRoles(db, 'orig');
      addAgent(db, 'orig', 'bot');
      putConnection(db, 'dup', { created: '2026-02-01T00:00:00.000Z', approved: '2026-02-01T00:00:00.000Z' });
      run(db, "INSERT INTO oauthRefreshToken (id, clientId, token) VALUES ('rt_dup', 'dup', 'SECRETTOKEN_dup_live')");
      const logs14 = applyOne(db, 14);
      assert.equal(repairedOf(logs14), 1);
      assert.equal(getConnection(db, 'orig')!.current_client_id, 'dup');
      assert.ok(get(db, "SELECT 1 FROM oauthRefreshToken WHERE clientId = 'dup'"));

      const logs15 = applyOne(db, 15);
      assert.equal(repairedOf(logs15), 0);
      assert.equal(getConnection(db, 'orig')!.current_client_id, 'dup');
      assert.equal(getConnection(db, 'orig')!.approved_at, '2026-01-01T00:00:00.000Z');
      assert.equal(getConnection(db, 'dup')!.merged_into_client_id, 'orig');
      assert.ok(get(db, "SELECT 1 FROM oauthRefreshToken WHERE clientId = 'dup'"), 'live token bound by migration 14 must stay');
    } finally {
      close();
    }
  });
});
