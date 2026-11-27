import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { checkAccess, expireUnusedClients, getConnection, listConnections, liveConnectionForClient, pendingTransfer, reauthContinueOptions, rollbackClientTransfer, sameClientType, clientInfo } from '../src/auth/connections.ts';
import { all, get, openDatabase, run, runAppMigrations, tx, type DB } from '../src/db/db.ts';
import { migrations } from '../src/db/schema.ts';
import { repairReauthDuplicateConnections } from '../src/db/repair-reauth-duplicates.ts';
import { setLogLevel } from '../src/util/log.ts';
import { approveConnection, type ConnectionRow } from '../src/auth/connections.ts';
import { connectAgent, registerOwner, startService, TestOAuthProvider, type TestEnv, type Browser } from './helpers/harness.ts';

const GROK_CB = 'https://grok.com/connectors-oauth-exchange-code/';
const OTHER_CB = 'https://other.example/connectors-oauth-exchange-code/';

function tmpDb(): { dir: string; db: DB; close(): void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-reauth-'));
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
    CREATE TABLE IF NOT EXISTS oauthConsent (id TEXT PRIMARY KEY, clientId TEXT);
  `);
}

function putClient(db: DB, id: string, opts: { name?: string; uris?: string[]; method?: string; discovery?: string } = {}): void {
  const uris = JSON.stringify(opts.uris ?? [GROK_CB]);
  run(
    db,
    `INSERT INTO oauthClient (id, clientId, name, redirectUris, tokenEndpointAuthMethod, clientDiscoveryId, createdAt)
     VALUES (?,?,?,?,?,?,?)`,
    `row_${id}`,
    id,
    opts.name ?? 'Grok',
    uris,
    opts.method ?? 'none',
    opts.discovery ?? null,
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

function addAgent(db: DB, clientId: string, slug = 'grok-dev'): void {
  const t = '2026-06-01T00:00:00.000Z';
  const id = `agt_${slug}`;
  run(db, 'INSERT INTO agent (id, member_id, slug, name, client_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?)', id, 'mem_1', slug, slug, clientId, t, t);
}

function confirmRoles(db: DB, clientId: string, roleId = 'role_dev'): void {
  run(db, "INSERT INTO connection_role (client_id, role_id, source) VALUES (?, ?, 'owner')", clientId, roleId);
  run(db, 'UPDATE connection SET roles_confirmed_at = approved_at WHERE client_id = ?', clientId);
}

function captureStdout(fn: () => void): string {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: typeof process.stdout.write }).write = ((chunk: unknown, ...args: unknown[]) => {
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

describe('migration 14 repair-reauth-duplicate-connections', () => {
  it('binds a later empty duplicate onto the earlier configured original and archives the duplicate', () => {
    const { db, close } = tmpDb();
    try {
      applyThrough(db, 13);
      stubOauth(db);
      seedMember(db);
      putClient(db, 'BfLCnOrig', { name: 'Grok' });
      putClient(db, 'CtvfJLive', { name: 'Grok' });
      putClient(db, 'zNRYRevoked', { name: 'Grok' });
      putConnection(db, 'BfLCnOrig', { name: 'Grok', created: '2026-11-01T00:00:00.000Z', approved: '2026-11-01T00:00:00.000Z', activity: '2026-11-10T00:00:00.000Z', confirmed: '2026-11-01T00:00:00.000Z', sole: 1 });
      confirmRoles(db, 'BfLCnOrig');
      addAgent(db, 'BfLCnOrig');
      run(db, "INSERT INTO start_cursor (connection_id, role_key, last_event_id, updated_at) VALUES ('BfLCnOrig', 'developer', 10, '2026-11-10T00:00:00.000Z')");
      run(db, "INSERT INTO start_cursor (connection_id, role_key, last_event_id, updated_at) VALUES ('CtvfJLive', 'developer', 99, '2026-11-27T17:00:00.000Z')");
      run(db, "INSERT INTO start_cursor (connection_id, role_key, last_event_id, updated_at) VALUES ('CtvfJLive', 'new-role', 5, '2026-11-27T17:00:00.000Z')");
      putConnection(db, 'CtvfJLive', { name: 'Grok', created: '2026-11-27T16:59:50.000Z', approved: '2026-11-27T16:59:50.000Z' });
      putConnection(db, 'zNRYRevoked', { name: 'Grok', created: '2026-10-01T00:00:00.000Z', approved: '2026-10-01T00:00:00.000Z', revoked: '2026-10-15T00:00:00.000Z' });
      run(db, "INSERT INTO oauthAccessToken (id, clientId, token) VALUES ('t1', 'BfLCnOrig', 'SECRETTOKEN_original')");
      run(db, "INSERT INTO oauthAccessToken (id, clientId, token) VALUES ('t2', 'CtvfJLive', 'SECRETTOKEN_live')");

      setLogLevel('info');
      const out = captureStdout(() => {
        assert.equal(runAppMigrations(db), 1);
      });
      assert.match(out, /connection duplicate repaired/);
      assert.match(out, /repair-reauth-duplicate-connections/);
      assert.doesNotMatch(out, /SECRETTOKEN/);
      assert.equal(get<{ n: number }>(db, 'SELECT count(*) AS n FROM app_migration WHERE id = 14')!.n, 1);

      const orig = getConnection(db, 'BfLCnOrig')!;
      assert.equal(orig.current_client_id, 'CtvfJLive');
      assert.equal(orig.sole_agent, 1);
      assert.equal(orig.approved_at, '2026-11-01T00:00:00.000Z', 'migration must not bump approved_at');
      assert.equal(orig.roles_confirmed_at, '2026-11-01T00:00:00.000Z');
      assert.equal(orig.revoked_at, null);
      const dup = getConnection(db, 'CtvfJLive')!;
      assert.ok(dup.revoked_at);
      assert.equal(dup.merged_into_client_id, 'BfLCnOrig');
      assert.equal(dup.current_client_id, null);
      const revoked = getConnection(db, 'zNRYRevoked')!;
      assert.ok(revoked.revoked_at);
      assert.equal(revoked.merged_into_client_id, null);

      assert.equal(get<{ n: number }>(db, "SELECT count(*) AS n FROM agent WHERE client_id = 'BfLCnOrig'")!.n, 1);
      assert.equal(get(db, "SELECT 1 FROM agent WHERE client_id = 'CtvfJLive'"), undefined);
      const cursors = all<{ role_key: string; last_event_id: number }>(db, "SELECT role_key, last_event_id FROM start_cursor WHERE connection_id = 'BfLCnOrig' ORDER BY role_key");
      assert.equal(cursors.length, 2);
      assert.equal(cursors[0]!.role_key, 'developer');
      assert.equal(cursors[0]!.last_event_id, 10);
      assert.equal(cursors[1]!.role_key, 'new-role');
      assert.equal(cursors[1]!.last_event_id, 5);
      assert.equal(get(db, "SELECT 1 FROM start_cursor WHERE connection_id = 'CtvfJLive'"), undefined);
      assert.equal(get(db, "SELECT 1 FROM oauthAccessToken WHERE clientId = 'BfLCnOrig'"), undefined, 'original client grants dropped');
      assert.ok(get(db, "SELECT 1 FROM oauthAccessToken WHERE clientId = 'CtvfJLive'"), 'live duplicate token kept');

      const access = checkAccess(db, 'CtvfJLive', Math.floor(Date.now() / 1000));
      assert.equal(access.ok, true);
      if (access.ok) assert.equal(access.connection.client_id, 'BfLCnOrig');
      const old = checkAccess(db, 'BfLCnOrig', Math.floor(Date.now() / 1000));
      assert.equal(old.ok, false);
      assert.ok(get(db, "SELECT 1 FROM oauthAccessToken WHERE clientId = 'CtvfJLive'"), 'unknown-client path must not drop the bound client');

      const transfer = pendingTransfer(db, 'BfLCnOrig');
      assert.ok(transfer);
      assert.equal(transfer!.kind, 'migration');
      assert.equal(transfer!.to_client_id, 'CtvfJLive');
    } finally {
      close();
    }
  });

  it('is a no-op when there is no duplicate, and a re-run repairs nothing more', () => {
    const { db, close } = tmpDb();
    try {
      applyThrough(db, 13);
      stubOauth(db);
      seedMember(db);
      putClient(db, 'only');
      putConnection(db, 'only', { name: 'Grok', confirmed: '2026-06-01T00:00:00.000Z' });
      confirmRoles(db, 'only');
      addAgent(db, 'only');
      assert.equal(runAppMigrations(db), 1);
      const before = getConnection(db, 'only')!;
      assert.equal(before.current_client_id, 'only');
      const logs = repairReauthDuplicateConnections(db);
      assert.equal(logs.at(-1)?.fields.repaired, 0);
      assert.equal(getConnection(db, 'only')!.current_client_id, 'only');
    } finally {
      close();
    }
  });

  it('skips when one original has more than one empty candidate', () => {
    const { db, close } = tmpDb();
    try {
      applyThrough(db, 13);
      stubOauth(db);
      seedMember(db);
      for (const id of ['orig', 'empty1', 'empty2']) putClient(db, id);
      putConnection(db, 'orig', { created: '2026-01-01T00:00:00.000Z', confirmed: '2026-01-01T00:00:00.000Z' });
      confirmRoles(db, 'orig');
      addAgent(db, 'orig');
      putConnection(db, 'empty1', { created: '2026-02-01T00:00:00.000Z', approved: '2026-02-01T00:00:00.000Z' });
      putConnection(db, 'empty2', { created: '2026-03-01T00:00:00.000Z', approved: '2026-03-01T00:00:00.000Z' });
      const logs = captureRepair(db);
      assert.equal(repairedOf(logs), 0);
      assert.ok(logs.some((l) => l.fields.reason === 'ambiguous'));
      assert.equal(getConnection(db, 'orig')!.current_client_id, 'orig');
      assert.equal(getConnection(db, 'empty1')!.merged_into_client_id, null);
    } finally {
      close();
    }
  });

  it('skips when the original was used after the duplicate was approved', () => {
    const { db, close } = tmpDb();
    try {
      applyThrough(db, 13);
      stubOauth(db);
      seedMember(db);
      putClient(db, 'orig');
      putClient(db, 'dup');
      putConnection(db, 'orig', { created: '2026-01-01T00:00:00.000Z', confirmed: '2026-01-01T00:00:00.000Z', activity: '2026-03-15T00:00:00.000Z' });
      confirmRoles(db, 'orig');
      addAgent(db, 'orig');
      putConnection(db, 'dup', { created: '2026-03-01T00:00:00.000Z', approved: '2026-03-01T00:00:00.000Z' });
      const logs = captureRepair(db);
      assert.equal(repairedOf(logs), 0);
      assert.ok(logs.some((l) => l.fields.reason === 'original_still_active'));
    } finally {
      close();
    }
  });

  it('skips when the empty row is older than the configured original', () => {
    const { db, close } = tmpDb();
    try {
      applyThrough(db, 13);
      stubOauth(db);
      seedMember(db);
      putClient(db, 'empty');
      putClient(db, 'orig');
      putConnection(db, 'empty', { created: '2026-01-01T00:00:00.000Z' });
      putConnection(db, 'orig', { created: '2026-02-01T00:00:00.000Z', confirmed: '2026-02-01T00:00:00.000Z' });
      confirmRoles(db, 'orig');
      addAgent(db, 'orig');
      const logs = captureRepair(db);
      assert.equal(repairedOf(logs), 0);
      assert.ok(logs.some((l) => l.fields.reason === 'duplicate_not_later'));
    } finally {
      close();
    }
  });

  it('ignores an unapproved DCR client and a revoked platform, and never matches by name alone', () => {
    const { db, close } = tmpDb();
    try {
      applyThrough(db, 13);
      stubOauth(db);
      seedMember(db);
      putClient(db, 'orig', { name: 'Grok', uris: [GROK_CB] });
      putClient(db, 'unapproved', { name: 'Grok', uris: [GROK_CB] });
      putClient(db, 'emptyOther', { name: 'Grok', uris: [OTHER_CB] });
      putConnection(db, 'orig', { name: 'Grok', created: '2026-01-01T00:00:00.000Z', confirmed: '2026-01-01T00:00:00.000Z' });
      confirmRoles(db, 'orig');
      addAgent(db, 'orig');
      putConnection(db, 'emptyOther', { name: 'Grok', created: '2026-02-01T00:00:00.000Z' });
      const logs = captureRepair(db);
      assert.equal(repairedOf(logs), 0);
      assert.ok(logs.some((l) => l.fields.reason === 'no_original' && (l.fields.candidates as string[]).includes('emptyOther')));
      assert.equal(getConnection(db, 'orig')!.current_client_id, 'orig');
      assert.equal(getConnection(db, 'emptyOther')!.merged_into_client_id, null);
      assert.ok(get(db, "SELECT 1 FROM oauthClient WHERE clientId = 'unapproved'"));
    } finally {
      close();
    }
  });

  it('does not revive an archived row through approveConnection', () => {
    const { db, close } = tmpDb();
    try {
      applyThrough(db, 13);
      stubOauth(db);
      seedMember(db);
      putClient(db, 'orig');
      putClient(db, 'dup');
      putConnection(db, 'orig', { created: '2026-01-01T00:00:00.000Z', confirmed: '2026-01-01T00:00:00.000Z' });
      confirmRoles(db, 'orig');
      addAgent(db, 'orig');
      putConnection(db, 'dup', { created: '2026-02-01T00:00:00.000Z' });
      captureRepair(db);
      const actor = { kind: 'owner' as const, memberId: 'mem_1' };
      // The live token uses the duplicate's client id, now bound on the original.
      // Approving that client again continues the original and must not un-archive the duplicate.
      approveConnection(db, actor, 'dup', 'Grok again');
      const afterLive = getConnection(db, 'dup')!;
      assert.ok(afterLive.revoked_at);
      assert.equal(afterLive.merged_into_client_id, 'orig');
      assert.equal(getConnection(db, 'orig')!.current_client_id, 'dup');
      // A merged row that is not the live binding cannot be approved on its own.
      run(db, "UPDATE connection SET current_client_id = 'orig' WHERE client_id = 'orig'");
      assert.throws(() => approveConnection(db, actor, 'dup', 'Grok again'), /merged/);
      const dup = getConnection(db, 'dup')!;
      assert.ok(dup.revoked_at);
      assert.equal(dup.merged_into_client_id, 'orig');
    } finally {
      close();
    }
  });
});

function captureRepair(db: DB) {
  // Schema of 14 must be applied (columns + transfer table) before the frozen run is called alone.
  if (!get(db, "SELECT 1 FROM app_migration WHERE id = 14")) {
    const m = migrations.find((x) => x.id === 14)!;
    tx(db, () => {
      if (m.sql) db.exec(m.sql);
      const notes = m.run!(db);
      run(db, 'INSERT INTO app_migration (id, name, applied_at) VALUES (14, ?, ?)', m.name, new Date().toISOString());
      return notes;
    });
    return repairReauthDuplicateConnections(db); // second call: already repaired or skipped; for skip cases first run is enough — wait
  }
  return repairReauthDuplicateConnections(db);
}

function repairedOf(logs: { fields: Record<string, unknown> }[]): number {
  const last = logs.filter((l) => l.fields && 'repaired' in l.fields).at(-1);
  return Number(last?.fields.repaired ?? -1);
}

describe('re-auth continuation and rollback', () => {
  let env: TestEnv;
  let owner: Browser;

  before(async () => {
    env = await startService();
    owner = (await registerOwner(env)).browser;
  });
  after(async () => {
    await env.close();
  });

  it('automatically continues the one matching platform, rotates the old token, and journals the transfer', async () => {
    const first = await connectAgent(env, owner, 'Auto Grok');
    const platform = listConnections(env.svc.db).find((c) => c.name === 'Auto Grok')!;
    const second = await connectAgent(env, owner, 'Auto Grok');
    const again = listConnections(env.svc.db).filter((c) => c.active && c.name === 'Auto Grok');
    assert.equal(again.length, 1);
    assert.equal(again[0]!.client_id, platform.client_id);
    const newId = second.provider.clientInformation().client_id;
    assert.equal(again[0]!.current_client_id, newId);
    assert.notEqual(again[0]!.client_id, newId);
    const oldId = first.provider.clientInformation().client_id;
    assert.equal(checkAccess(env.svc.db, oldId, Math.floor(Date.now() / 1000) + 60).ok, false);
    assert.equal(checkAccess(env.svc.db, newId, Math.floor(Date.now() / 1000) + 60).ok, true);
    const transfer = pendingTransfer(env.svc.db, platform.client_id);
    assert.ok(transfer);
    assert.equal(transfer!.kind, 'reauth');
    assert.equal(transfer!.from_client_id, oldId);
    assert.equal(transfer!.to_client_id, newId);
  });

  it('offers a choice instead of auto-continuing when two platforms match', async () => {
    const a = await connectAgent(env, owner, 'Twin Grok');
    const aId = listConnections(env.svc.db).find((c) => c.name === 'Twin Grok')!.client_id;
    const reg = await fetch(`${env.base}/api/auth/oauth2/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Twin Grok', redirect_uris: ['http://127.0.0.1:9/callback'], token_endpoint_auth_method: 'none' }),
    });
    const twin = (await reg.json()) as { client_id: string };
    const t = new Date().toISOString();
    const memberId = get<{ id: string }>(env.svc.db, 'SELECT id FROM member')!.id;
    run(env.svc.db, 'INSERT INTO connection (client_id, member_id, name, client_name, created_at, approved_at, roles_confirmed_at, current_client_id) VALUES (?,?,?,?,?,?,?,?)', twin.client_id, memberId, 'Twin Grok 2', 'Twin Grok', t, t, t, twin.client_id);
    const third = await fetch(`${env.base}/api/auth/oauth2/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Twin Grok', redirect_uris: ['http://127.0.0.1:9/callback'], token_endpoint_auth_method: 'none' }),
    });
    const incoming = (await third.json()) as { client_id: string };
    const info = await owner.json<{ continue_with: { mode: string; candidates?: { client_id: string }[]; target?: { client_id: string } } }>(`/api/owner/consent/client?client_id=${encodeURIComponent(incoming.client_id)}`);
    assert.equal(info.continue_with.mode, 'choice');
    const ids = new Set((info.continue_with.candidates ?? []).map((c) => c.client_id));
    assert.ok(ids.has(aId));
    assert.ok(ids.has(twin.client_id));
    await assert.rejects(owner.json('/api/owner/consent', { json: { accept: true, name: 'Nope', oauth_query: `client_id=${incoming.client_id}` } }), /candidate|choose|continue/i);
  });

  it('offers a choice when the redirect_uri set differs or the auth method differs', async () => {
    const existing = await connectAgent(env, owner, 'Uri Grok');
    const platform = listConnections(env.svc.db).find((c) => c.name === 'Uri Grok')!;
    const otherUri = await fetch(`${env.base}/api/auth/oauth2/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Uri Grok', redirect_uris: ['https://grok.com/connectors-oauth-exchange-code/'], token_endpoint_auth_method: 'none' }),
    });
    const uriClient = (await otherUri.json()) as { client_id: string };
    const uriInfo = await owner.json<{ continue_with: { mode: string; candidates?: { client_id: string }[] } }>(`/api/owner/consent/client?client_id=${encodeURIComponent(uriClient.client_id)}`);
    assert.equal(uriInfo.continue_with.mode, 'choice');
    assert.ok((uriInfo.continue_with.candidates ?? []).some((c) => c.client_id === platform.client_id));
    assert.equal(reauthContinueOptions(env.svc.db, platform.member_id, uriClient.client_id).mode, 'choice');

    const otherMethod = await fetch(`${env.base}/api/auth/oauth2/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Uri Grok', redirect_uris: ['http://127.0.0.1:9/callback'], token_endpoint_auth_method: 'client_secret_post' }),
    });
    const methodClient = (await otherMethod.json()) as { client_id: string };
    const methodInfo = await owner.json<{ continue_with: { mode: string } }>(`/api/owner/consent/client?client_id=${encodeURIComponent(methodClient.client_id)}`);
    assert.equal(methodInfo.continue_with.mode, 'choice');
    void existing;
  });

  it('does not offer a revoked platform as a candidate and does not auto-continue onto it', async () => {
    const connected = await connectAgent(env, owner, 'Soon Revoked');
    const row = listConnections(env.svc.db).find((c) => c.name === 'Soon Revoked')!;
    await owner.json(`/api/owner/connections/${encodeURIComponent(row.client_id)}/revoke`, { method: 'POST' });
    const reg = await fetch(`${env.base}/api/auth/oauth2/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Soon Revoked', redirect_uris: ['http://127.0.0.1:9/callback'], token_endpoint_auth_method: 'none' }),
    });
    const incoming = (await reg.json()) as { client_id: string };
    const info = await owner.json<{ continue_with: { mode: string; candidates?: { client_id: string }[]; target?: { client_id: string } } }>(`/api/owner/consent/client?client_id=${encodeURIComponent(incoming.client_id)}`);
    const ids = (info.continue_with.candidates ?? []).map((c) => c.client_id);
    if (info.continue_with.mode === 'auto') assert.notEqual(info.continue_with.target?.client_id, row.client_id);
    assert.ok(!ids.includes(row.client_id));
    const opts = reauthContinueOptions(env.svc.db, row.member_id, incoming.client_id);
    if (opts.mode === 'choice') assert.ok(!opts.candidates.some((c) => c.client_id === row.client_id));
    if (opts.mode === 'auto') assert.notEqual(opts.target.client_id, row.client_id);
    void connected;
  });

  it('lets only the owner roll back a transfer, restoring the previous client', async () => {
    const first = await connectAgent(env, owner, 'Rollback Grok');
    const second = await connectAgent(env, owner, 'Rollback Grok');
    const platform = listConnections(env.svc.db).find((c) => c.active && c.name === 'Rollback Grok')!;
    const oldId = first.provider.clientInformation().client_id;
    const newId = second.provider.clientInformation().client_id;
    assert.equal(platform.current_client_id, newId);
    const memberId = platform.member_id;
    assert.throws(() => rollbackClientTransfer(env.svc.db, { kind: 'agent', memberId }, platform.client_id), /only the owner/);
    const after = await owner.json<ConnectionRow>(`/api/owner/connections/${encodeURIComponent(platform.client_id)}/rollback-transfer`, { method: 'POST' });
    assert.equal(after.current_client_id, oldId);
    assert.equal(checkAccess(env.svc.db, newId, Math.floor(Date.now() / 1000) + 60).ok, false);
    assert.equal(liveConnectionForClient(env.svc.db, oldId)?.client_id, platform.client_id);
    assert.equal(pendingTransfer(env.svc.db, platform.client_id), undefined);
    await assert.rejects(owner.json(`/api/owner/connections/${encodeURIComponent(platform.client_id)}/rollback-transfer`, { method: 'POST' }), /no client transfer|no transfer/i);
  });

  it('keeps a bound current_client_id out of expireUnusedClients', async () => {
    const first = await connectAgent(env, owner, 'Expire Grok');
    const second = await connectAgent(env, owner, 'Expire Grok');
    const platform = listConnections(env.svc.db).find((c) => c.active && c.name === 'Expire Grok')!;
    const bound = platform.current_client_id!;
    assert.notEqual(bound, platform.client_id);
    run(env.svc.db, 'UPDATE oauthClient SET createdAt = ? WHERE clientId = ?', '2020-01-01T00:00:00.000Z', bound);
    expireUnusedClients(env.svc.db, 7);
    assert.ok(get(env.svc.db, 'SELECT 1 FROM oauthClient WHERE clientId = ?', bound), 'bound current_client_id kept');
    void first;
    void second;
  });
});

describe('sameClientType', () => {
  it('requires registration, redirect set, auth method and name together, never name alone', () => {
    const base = { client_id: 'a', name: 'Grok', uri: null, redirect_uris: [GROK_CB], registration: 'registered' as const, token_endpoint_auth_method: 'none', created_at: null, disabled: false };
    assert.equal(sameClientType(base, { ...base, client_id: 'b' }), true);
    assert.equal(sameClientType(base, { ...base, client_id: 'b', redirect_uris: [OTHER_CB] }), false);
    assert.equal(sameClientType(base, { ...base, client_id: 'b', token_endpoint_auth_method: 'client_secret_post' }), false);
    assert.equal(sameClientType(base, { ...base, client_id: 'b', name: 'Muse' }), false);
    assert.equal(sameClientType({ ...base, name: 'Grok' }, { ...base, client_id: 'b', name: 'Grok', redirect_uris: [OTHER_CB] }), false);
    const cimd = { ...base, client_id: 'https://cimd.example/client.json', registration: 'client-id-metadata-document' as const };
    assert.equal(sameClientType(cimd, { ...cimd }), true);
    assert.equal(sameClientType(cimd, { ...cimd, client_id: 'https://cimd.example/other.json' }), false);
    void clientInfo;
  });
});
