import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  approveConnection,
  checkAccess,
  getConnection,
  journalEntriesBesidesApprove,
  listConnections,
  pendingTransfer,
  qualifiesAsEmptyDuplicate,
  reauthContinueOptions,
  type ConnectionRow,
} from '../src/auth/connections.ts';
import { get, openDatabase, run, runAppMigrations, type DB } from '../src/db/db.ts';
import { connectAgent, registerOwner, startService, type TestEnv, type Browser } from './helpers/harness.ts';

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
  const uris = JSON.stringify(opts.uris ?? ['https://grok.com/connectors-oauth-exchange-code/']);
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
  opts: { member?: string; name?: string; created?: string; approved?: string; activity?: string | null } = {},
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
    null,
    null,
    0,
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
  const memberId =
    get<{ member_id: string }>(db, 'SELECT member_id FROM connection WHERE client_id = ?', clientId)?.member_id ??
    get<{ id: string }>(db, 'SELECT id FROM member LIMIT 1')?.id ??
    'mem_1';
  run(db, 'INSERT INTO agent (id, member_id, slug, name, client_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?)', id, memberId, slug, slug, clientId, t, t);
}

function configurePlatform(db: DB, clientId: string, slug: string): void {
  addAgent(db, clientId, slug);
}

function confirmRoles(db: DB, clientId: string, roleId: string): void {
  run(db, "INSERT INTO connection_role (client_id, role_id, source) VALUES (?, ?, 'owner')", clientId, roleId);
  run(db, 'UPDATE connection SET roles_confirmed_at = approved_at WHERE client_id = ?', clientId);
}

async function registerTestClient(env: TestEnv, name: string, redirect = 'http://127.0.0.1:9/callback', method = 'none'): Promise<string> {
  const reg = await fetch(`${env.base}/api/auth/oauth2/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: name, redirect_uris: [redirect], token_endpoint_auth_method: method }),
  });
  const body = (await reg.json()) as { client_id: string };
  if (!body.client_id) throw new Error(`register failed: ${JSON.stringify(body)}`);
  return body.client_id;
}

async function assertRefreshRejected(env: TestEnv, clientId: string, refreshToken: string): Promise<void> {
  const as = (await (await fetch(`${env.base}/.well-known/oauth-authorization-server`)).json()) as { token_endpoint: string };
  const r = await fetch(as.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, resource: env.config.mcpUrl }),
  });
  assert.notEqual(r.status, 200, await r.text());
}

function putEmptyPlatform(db: DB, clientId: string, memberId: string, name: string, clientName: string): void {
  const t = new Date().toISOString();
  run(
    db,
    'INSERT INTO connection (client_id, member_id, name, client_name, created_at, approved_at, current_client_id) VALUES (?,?,?,?,?,?,?)',
    clientId,
    memberId,
    name,
    clientName,
    t,
    t,
    clientId,
  );
  run(
    db,
    `INSERT INTO event (member_id, at, actor_kind, connection_id, connection_name, claimed_role, agent, entity_type, entity_id, action, summary, data)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    memberId,
    t,
    'owner',
    null,
    name,
    null,
    null,
    'connection',
    clientId,
    'connection.approved',
    `Connection "${name}" approved`,
    '{}',
  );
}

function putEvent(
  db: DB,
  opts: {
    memberId: string;
    action: string;
    entityType?: string;
    entityId?: string | null;
    connectionId?: string | null;
    connectionName?: string | null;
    agent?: string | null;
    actorKind?: string;
    summary?: string;
  },
): void {
  const t = new Date().toISOString();
  run(
    db,
    `INSERT INTO event (member_id, at, actor_kind, connection_id, connection_name, claimed_role, agent, entity_type, entity_id, action, summary, data)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    opts.memberId,
    t,
    opts.actorKind ?? 'agent',
    opts.connectionId ?? null,
    opts.connectionName ?? null,
    null,
    opts.agent ?? null,
    opts.entityType ?? 'connection',
    opts.entityId ?? null,
    opts.action,
    opts.summary ?? opts.action,
    '{}',
  );
}

describe('re-auth with an empty same-type duplicate', () => {
  let env: TestEnv;
  let owner: Browser;

  before(async () => {
    env = await startService();
    owner = (await registerOwner(env)).browser;
  });
  after(async () => {
    await env.close();
  });

  it('auto-continues the configured original while an empty same-type duplicate is active, archives the empty one, and says so on the consent screen', async () => {
    const first = await connectAgent(env, owner, 'Both Active');
    const original = listConnections(env.svc.db).find((c) => c.name === 'Both Active')!;
    configurePlatform(env.svc.db, original.client_id, 'both-active-bot');
    const memberId = original.member_id;
    const dupId = await registerTestClient(env, 'Both Active');
    putEmptyPlatform(env.svc.db, dupId, memberId, 'Both Active leftover', 'Both Active');
    const probeId = await registerTestClient(env, 'Both Active');
    const info = await owner.json<{
      continue_with: { mode: string; target?: { client_id: string; name: string }; archive?: { client_id: string; name: string }[] };
    }>(`/api/owner/consent/client?client_id=${encodeURIComponent(probeId)}`);
    assert.equal(info.continue_with.mode, 'auto');
    assert.equal(info.continue_with.target?.client_id, original.client_id);
    const archivedNames = (info.continue_with.archive ?? []).map((a) => a.client_id);
    assert.ok(archivedNames.includes(dupId), 'consent payload lists the empty duplicate to archive');
    assert.equal((info.continue_with.archive ?? []).find((a) => a.client_id === dupId)?.name, 'Both Active leftover');

    const second = await connectAgent(env, owner, 'Both Active');
    const live = listConnections(env.svc.db).filter((c) => c.active && c.name === 'Both Active');
    assert.equal(live.length, 1);
    assert.equal(live[0]!.client_id, original.client_id);
    const newId = second.provider.clientInformation().client_id;
    assert.equal(live[0]!.current_client_id, newId);
    const leftover = getConnection(env.svc.db, dupId)!;
    assert.ok(leftover.merged_into_client_id);
    assert.equal(leftover.merged_into_client_id, original.client_id);
    assert.ok(leftover.revoked_at);
    assert.equal(leftover.current_client_id, null);
    assert.equal(checkAccess(env.svc.db, newId, Math.floor(Date.now() / 1000) + 60).ok, true);
    assert.equal(checkAccess(env.svc.db, first.provider.clientInformation().client_id, Math.floor(Date.now() / 1000) + 60).ok, false);
    const transfer = pendingTransfer(env.svc.db, original.client_id);
    assert.ok(transfer);
    assert.equal(transfer!.kind, 'reauth');
    assert.equal(transfer!.archived_client_id, dupId);
    assert.equal(get(env.svc.db, 'SELECT 1 FROM oauthRefreshToken WHERE clientId = ?', dupId), undefined);
  });

  it('rolls back a re-auth that archived an empty duplicate, restores it, and drops grants of every involved client', async () => {
    const first = await connectAgent(env, owner, 'Archive Rollback');
    const original = listConnections(env.svc.db).find((c) => c.name === 'Archive Rollback')!;
    configurePlatform(env.svc.db, original.client_id, 'archive-rollback-bot');
    const dupId = await registerTestClient(env, 'Archive Rollback');
    putEmptyPlatform(env.svc.db, dupId, original.member_id, 'Archive Rollback leftover', 'Archive Rollback');
    const firstTok = first.provider.tokens()!;
    const second = await connectAgent(env, owner, 'Archive Rollback');
    const secondTok = second.provider.tokens()!;
    const newId = second.provider.clientInformation().client_id;
    const oldId = first.provider.clientInformation().client_id;
    assert.ok(getConnection(env.svc.db, dupId)!.merged_into_client_id);
    const started = Date.now();
    const iat = Math.floor(Date.now() / 1000) - 60;
    const after = await owner.json<ConnectionRow>(
      `/api/owner/connections/${encodeURIComponent(original.client_id)}/rollback-transfer`,
      { method: 'POST' },
    );
    assert.equal(after.current_client_id, oldId);
    assert.ok(Date.parse(after.approved_at!) >= started);
    const restored = getConnection(env.svc.db, dupId)!;
    assert.equal(restored.merged_into_client_id, null);
    assert.equal(restored.revoked_at, null);
    assert.equal(restored.current_client_id, dupId);
    assert.ok(Date.parse(restored.approved_at) >= started);
    assert.equal(checkAccess(env.svc.db, oldId, iat).ok, false);
    assert.equal(checkAccess(env.svc.db, newId, iat).ok, false);
    assert.equal(checkAccess(env.svc.db, dupId, iat).ok, false);
    assert.equal(get(env.svc.db, 'SELECT 1 FROM oauthRefreshToken WHERE clientId IN (?, ?, ?)', oldId, newId, dupId), undefined);
    assert.equal(get(env.svc.db, 'SELECT 1 FROM oauthAccessToken WHERE clientId IN (?, ?, ?)', oldId, newId, dupId), undefined);
    await assertRefreshRejected(env, oldId, firstTok.refresh_token!);
    await assertRefreshRejected(env, newId, secondTok.refresh_token!);
    assert.equal(pendingTransfer(env.svc.db, original.client_id), undefined);
  });

  it('offers a choice and does not archive when two empty same-type platforms exist and none is configured', async () => {
    const memberId = get<{ id: string }>(env.svc.db, 'SELECT id FROM member')!.id;
    const aId = await registerTestClient(env, 'Empty Pair');
    const bId = await registerTestClient(env, 'Empty Pair');
    putEmptyPlatform(env.svc.db, aId, memberId, 'Empty Pair A', 'Empty Pair');
    putEmptyPlatform(env.svc.db, bId, memberId, 'Empty Pair B', 'Empty Pair');
    const incoming = await registerTestClient(env, 'Empty Pair');
    const info = await owner.json<{ continue_with: { mode: string; candidates?: { client_id: string }[]; target?: { client_id: string } } }>(
      `/api/owner/consent/client?client_id=${encodeURIComponent(incoming)}`,
    );
    assert.equal(info.continue_with.mode, 'choice');
    assert.ok(!info.continue_with.target);
    const opts = reauthContinueOptions(env.svc.db, memberId, incoming);
    assert.equal(opts.mode, 'choice');
    approveConnection(
      env.svc.db,
      { kind: 'owner', memberId },
      incoming,
      'Empty Pair new',
      { continueClientId: null, offeredChoice: true },
    );
    assert.equal(getConnection(env.svc.db, aId)!.merged_into_client_id, null);
    assert.equal(getConnection(env.svc.db, bId)!.merged_into_client_id, null);
    assert.ok(getConnection(env.svc.db, incoming));
    assert.notEqual(getConnection(env.svc.db, incoming)!.client_id, aId);
    assert.notEqual(getConnection(env.svc.db, incoming)!.client_id, bId);
  });

  it('does not archive a duplicate that has a journal entry besides approve, including one attributed through event.agent', async () => {
    const first = await connectAgent(env, owner, 'Journal Guard');
    const original = listConnections(env.svc.db).find((c) => c.name === 'Journal Guard')!;
    configurePlatform(env.svc.db, original.client_id, 'journal-guard-bot');
    const memberId = original.member_id;
    const callDup = await registerTestClient(env, 'Journal Guard');
    putEmptyPlatform(env.svc.db, callDup, memberId, 'Journal Guard leftover', 'Journal Guard');
    putEvent(env.svc.db, {
      memberId,
      action: 'start',
      connectionId: callDup,
      connectionName: 'Journal Guard leftover',
      entityType: 'connection',
      entityId: callDup,
    });
    assert.ok(journalEntriesBesidesApprove(env.svc.db, callDup) >= 1);

    const incoming = await registerTestClient(env, 'Journal Guard');
    const info = await owner.json<{
      continue_with: { mode: string; target?: { client_id: string }; archive?: { client_id: string }[] };
    }>(`/api/owner/consent/client?client_id=${encodeURIComponent(incoming)}`);
    assert.equal(info.continue_with.mode, 'auto');
    assert.equal(info.continue_with.target?.client_id, original.client_id);
    assert.ok(!(info.continue_with.archive ?? []).some((a) => a.client_id === callDup));

    const second = await connectAgent(env, owner, 'Journal Guard');
    const leftover = getConnection(env.svc.db, callDup)!;
    assert.equal(leftover.merged_into_client_id, null);
    assert.equal(leftover.revoked_at, null);
    const stay = listConnections(env.svc.db).filter((c) => c.active && c.name === 'Journal Guard');
    assert.equal(stay.length, 1);
    assert.equal(stay[0]!.client_id, original.client_id);
    assert.equal(stay[0]!.current_client_id, second.provider.clientInformation().client_id);
    void first;
  });

  it('does not archive a duplicate that has one agent or confirmed roles, and offers a choice with New platform as the default', async () => {
    const first = await connectAgent(env, owner, 'Configured Twin');
    const original = listConnections(env.svc.db).find((c) => c.name === 'Configured Twin')!;
    configurePlatform(env.svc.db, original.client_id, 'configured-twin-orig');
    const memberId = original.member_id;
    const agentDup = await registerTestClient(env, 'Configured Twin');
    putEmptyPlatform(env.svc.db, agentDup, memberId, 'Configured Twin agent', 'Configured Twin');
    addAgent(env.svc.db, agentDup, 'configured-twin-dup');
    const incoming = await registerTestClient(env, 'Configured Twin');
    const info = await owner.json<{ continue_with: { mode: string; candidates?: { client_id: string }[] } }>(
      `/api/owner/consent/client?client_id=${encodeURIComponent(incoming)}`,
    );
    assert.equal(info.continue_with.mode, 'choice');
    const ids = new Set((info.continue_with.candidates ?? []).map((c) => c.client_id));
    assert.ok(ids.has(original.client_id));
    assert.ok(ids.has(agentDup));
    approveConnection(env.svc.db, { kind: 'owner', memberId }, incoming, 'Configured Twin new', {
      continueClientId: null,
      offeredChoice: true,
    });
    assert.equal(getConnection(env.svc.db, agentDup)!.merged_into_client_id, null);
    assert.ok(getConnection(env.svc.db, incoming));
    void first;

    const roleOrig = await connectAgent(env, owner, 'Role Twin');
    const rolePlatform = listConnections(env.svc.db).find((c) => c.name === 'Role Twin')!;
    await owner.json('/api/owner/roles', { json: { name: 'Role Twin Dev', slug: 'role-twin-dev', instruction: 'A role for this test.' } });
    const roleId = get<{ id: string }>(env.svc.db, "SELECT id FROM role WHERE slug = 'role-twin-dev'")!.id;
    const t = new Date().toISOString();
    run(env.svc.db, "INSERT INTO connection_role (client_id, role_id, source) VALUES (?, ?, 'owner')", rolePlatform.client_id, roleId);
    run(env.svc.db, 'UPDATE connection SET roles_confirmed_at = ? WHERE client_id = ?', t, rolePlatform.client_id);
    const roleDup = await registerTestClient(env, 'Role Twin');
    putEmptyPlatform(env.svc.db, roleDup, rolePlatform.member_id, 'Role Twin leftover', 'Role Twin');
    confirmRoles(env.svc.db, roleDup, roleId);
    const roleIncoming = await registerTestClient(env, 'Role Twin');
    const roleInfo = await owner.json<{ continue_with: { mode: string; candidates?: { client_id: string }[] } }>(
      `/api/owner/consent/client?client_id=${encodeURIComponent(roleIncoming)}`,
    );
    assert.equal(roleInfo.continue_with.mode, 'choice');
    const roleIds = new Set((roleInfo.continue_with.candidates ?? []).map((c) => c.client_id));
    assert.ok(roleIds.has(rolePlatform.client_id));
    assert.ok(roleIds.has(roleDup));
    void roleOrig;
  });

  it('after an auto-continue that archived an empty duplicate, a further re-auth continues the same original', async () => {
    const first = await connectAgent(env, owner, 'Stay Original');
    const original = listConnections(env.svc.db).find((c) => c.name === 'Stay Original')!;
    configurePlatform(env.svc.db, original.client_id, 'stay-original-bot');
    const dupId = await registerTestClient(env, 'Stay Original');
    putEmptyPlatform(env.svc.db, dupId, original.member_id, 'Stay Original leftover', 'Stay Original');
    const second = await connectAgent(env, owner, 'Stay Original');
    assert.ok(getConnection(env.svc.db, dupId)!.merged_into_client_id);
    const third = await connectAgent(env, owner, 'Stay Original');
    const active = listConnections(env.svc.db).filter((c) => c.active && (c.name === 'Stay Original' || c.client_id === original.client_id));
    const stay = listConnections(env.svc.db).filter((c) => c.active && c.name === 'Stay Original');
    assert.equal(stay.length, 1, 'no third platform');
    assert.equal(stay[0]!.client_id, original.client_id);
    assert.equal(stay[0]!.current_client_id, third.provider.clientInformation().client_id);
    void first;
    void second;
    void active;
  });
});

describe('journalEntriesBesidesApprove attribution', () => {
  it('counts an event attributed only through event.agent, not only entity_id or connection_id', () => {
    const { db, close } = tmpDb();
    try {
      stubOauth(db);
      runAppMigrations(db);
      seedMember(db);
      putClient(db, 'plat_agent_attr', { name: 'Grok' });
      putConnection(db, 'plat_agent_attr', { name: 'Grok' });
      addAgent(db, 'plat_agent_attr', 'ghost-writer');
      putEvent(db, {
        memberId: 'mem_1',
        action: 'connection.approved',
        actorKind: 'owner',
        entityType: 'connection',
        entityId: 'plat_agent_attr',
        connectionId: null,
      });
      assert.equal(journalEntriesBesidesApprove(db, 'plat_agent_attr'), 0);
      putEvent(db, {
        memberId: 'mem_1',
        action: 'task.created',
        actorKind: 'agent',
        agent: 'ghost-writer',
        entityType: 'task',
        entityId: 'task_only_agent',
        connectionId: null,
      });
      assert.equal(journalEntriesBesidesApprove(db, 'plat_agent_attr'), 1);
      assert.equal(qualifiesAsEmptyDuplicate(db, getConnection(db, 'plat_agent_attr')!), false);
    } finally {
      close();
    }
  });
});
