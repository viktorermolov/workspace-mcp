import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { all, get, openDatabase, run, tx } from '../src/db/db.ts';
import { migrations } from '../src/db/schema.ts';
import { saveAgent } from '../src/domain/agents.ts';
import { DomainError, type Actor } from '../src/domain/core.ts';
import { call, connectAgent, registerOwner, startService, type Browser, type TestEnv } from './helpers/harness.ts';

interface AgentView {
  id: string;
  slug: string;
  name: string;
  rev: number;
  platform: { id: string; name: string; active: boolean };
  roles: { id: string; slug: string; name: string }[];
}

describe('agents on a platform', () => {
  let env: TestEnv;
  let owner: Browser;
  let grok: Awaited<ReturnType<typeof connectAgent>>['client'];
  let grokId: string;
  let otherId: string;

  before(async () => {
    env = await startService();
    owner = (await registerOwner(env)).browser;
    await owner.json('/api/owner/roles', { json: { name: 'Coordinator', slug: 'coordinator' } });
    await owner.json('/api/owner/roles', { json: { name: 'Developer', slug: 'developer' } });
    grok = (await connectAgent(env, owner, 'Grok')).client;
    await connectAgent(env, owner, 'Home server');
    const list = await owner.json<{ connections: { client_id: string; name: string }[] }>('/api/owner/connections');
    grokId = list.connections.find((c) => c.name === 'Grok')!.client_id;
    otherId = list.connections.find((c) => c.name === 'Home server')!.client_id;
  });

  after(async () => {
    await env.close();
  });

  it('the owner adds two agents on one platform, each with its own roles', async () => {
    const ada = await owner.json<AgentView>('/api/owner/agents', { json: { name: 'Ada', platform: grokId, roles: ['coordinator'] } });
    const bob = await owner.json<AgentView>('/api/owner/agents', { json: { name: 'Bob', platform: grokId, roles: ['developer', 'coordinator'] } });
    assert.equal(ada.slug, 'ada');
    assert.deepEqual(ada.platform, { id: grokId, name: 'Grok', active: true });
    assert.deepEqual(ada.roles.map((r) => r.slug), ['coordinator']);
    assert.deepEqual(bob.roles.map((r) => r.slug).sort(), ['coordinator', 'developer']);
    const listed = await owner.json<{ agents: AgentView[] }>('/api/owner/agents');
    assert.deepEqual(listed.agents.map((a) => a.slug), ['ada', 'bob']);
    const ev = get<{ summary: string; actor_kind: string }>(env.svc.db, "SELECT summary, actor_kind FROM event WHERE action = 'agent.created' ORDER BY id LIMIT 1");
    assert.deepEqual({ ...ev }, { summary: 'Agent "Ada" added on Grok', actor_kind: 'owner' });
  });

  it('one role can be taken by agents on different platforms', async () => {
    const hal = await owner.json<AgentView>('/api/owner/agents', { json: { name: 'Hal', platform: otherId, roles: ['developer'] } });
    assert.equal(hal.platform.name, 'Home server');
    const holders = all<{ slug: string }>(env.svc.db, "SELECT a.slug FROM agent a JOIN agent_role ar ON ar.agent_id = a.id JOIN role r ON r.id = ar.role_id WHERE r.slug = 'developer' ORDER BY a.slug");
    assert.deepEqual(holders.map((h) => h.slug), ['bob', 'hal']);
  });

  it('updates need the current rev, replace the role list and move an agent to another platform', async () => {
    const ada = (await owner.json<{ agents: AgentView[] }>('/api/owner/agents')).agents.find((a) => a.slug === 'ada')!;
    const stale = await owner.fetch('/api/owner/agents', { json: { id: ada.id, rev: ada.rev + 5, name: 'Ada L.' } });
    assert.equal(stale.status, 409);
    const same = await owner.json<AgentView & { unchanged?: boolean }>('/api/owner/agents', { json: { id: ada.id, rev: ada.rev, name: 'Ada', roles: ['coordinator'] } });
    assert.equal(same.unchanged, true);
    const moved = await owner.json<AgentView>('/api/owner/agents', { json: { id: ada.id, rev: ada.rev, name: 'Ada L.', platform: otherId, roles: ['developer'] } });
    assert.equal(moved.rev, ada.rev + 1);
    assert.equal(moved.name, 'Ada L.');
    assert.equal(moved.platform.id, otherId);
    assert.deepEqual(moved.roles.map((r) => r.slug), ['developer']);
  });

  it('rejects a duplicate slug, an unknown or archived role, an unknown platform and an empty name', async () => {
    const dup = await owner.fetch('/api/owner/agents', { json: { name: 'Other', slug: 'bob', platform: grokId } });
    assert.equal(dup.status, 409);
    for (const json of [
      { name: 'X1', platform: grokId, roles: ['no-such-role'] },
      { name: 'X2', platform: 'no-such-platform' },
      { name: '   ', platform: grokId },
      { name: 'X3' },
    ]) {
      const res = await owner.fetch('/api/owner/agents', { json });
      assert.equal(res.status, 400, JSON.stringify(json));
    }
    await owner.json('/api/owner/roles', { json: { name: 'Retired', slug: 'retired' } });
    await owner.json('/api/owner/archive', { json: { type: 'role', id: 'retired' } });
    const archived = await owner.fetch('/api/owner/agents', { json: { name: 'X4', platform: grokId, roles: ['retired'] } });
    assert.equal(archived.status, 400);
    assert.equal(get<{ n: number }>(env.svc.db, "SELECT count(*) AS n FROM agent WHERE name LIKE 'X%'")!.n, 0);
  });

  it('makes a free slug from the name, also for names without Latin letters', async () => {
    const made: AgentView[] = [];
    for (const name of ['Арина', 'Вера', 'Bob']) made.push(await owner.json<AgentView>('/api/owner/agents', { json: { name, platform: grokId } }));
    assert.deepEqual(made.map((a) => [a.name, a.slug]), [['Арина', 'agent'], ['Вера', 'agent-2'], ['Bob', 'bob-2']]);
    for (const a of made) await owner.json(`/api/owner/agents/${a.id}`, { method: 'DELETE' });
  });

  it('start lists agents with their platform and roles, and MCP has no tool that changes them', async () => {
    const start = await call<{ data: { agents: { slug: string; name: string; platform: string; roles: string[] }[] } }>(grok, 'start');
    assert.deepEqual(
      start.data.agents.map((a) => ({ ...a, roles: [...a.roles].sort() })),
      [
        { slug: 'bob', name: 'Bob', platform: 'Grok', roles: ['coordinator', 'developer'] },
        { slug: 'ada', name: 'Ada L.', platform: 'Home server', roles: ['developer'] },
        { slug: 'hal', name: 'Hal', platform: 'Home server', roles: ['developer'] },
      ],
    );
    const tools = (await grok.listTools()).tools.map((t) => t.name);
    assert.ok(!tools.some((t) => /agent/.test(t)), `no agent tool among ${tools.join(', ')}`);
    const agentActor: Actor = { kind: 'agent', memberId: get<{ member_id: string }>(env.svc.db, 'SELECT member_id FROM agent LIMIT 1')!.member_id, connectionId: grokId };
    assert.throws(
      () => saveAgent(env.svc.db, agentActor, { name: 'Sneaky', platform: grokId }),
      (e) => e instanceof DomainError && e.code === 'forbidden',
    );
  });

  it('an agent on a revoked platform is left out of start, and a new agent cannot be added to it', async () => {
    await owner.json(`/api/owner/connections/${encodeURIComponent(otherId)}/revoke`, { json: {} });
    const start = await call<{ data: { agents: { slug: string }[] } }>(grok, 'start');
    assert.deepEqual(start.data.agents.map((a) => a.slug), ['bob']);
    const res = await owner.fetch('/api/owner/agents', { json: { name: 'Late', platform: otherId } });
    assert.equal(res.status, 400);
    const listed = await owner.json<{ agents: AgentView[] }>('/api/owner/agents');
    assert.equal(listed.agents.find((a) => a.slug === 'hal')!.platform.active, false);
  });

  it('deleting a role removes it from agents; removing an agent keeps the log', async () => {
    await owner.json('/api/owner/archive', { json: { type: 'role', id: 'coordinator' } });
    await owner.json('/api/owner/purge', { json: { type: 'role', id: 'coordinator' } });
    const bob = (await owner.json<{ agents: AgentView[] }>('/api/owner/agents')).agents.find((a) => a.slug === 'bob')!;
    assert.deepEqual(bob.roles.map((r) => r.slug), ['developer']);
    const gone = await owner.json<{ deleted: boolean }>(`/api/owner/agents/${bob.id}`, { method: 'DELETE' });
    assert.equal(gone.deleted, true);
    assert.equal(get<{ n: number }>(env.svc.db, 'SELECT count(*) AS n FROM agent_role WHERE agent_id = ?', bob.id)!.n, 0);
    assert.ok(get(env.svc.db, "SELECT 1 FROM event WHERE action = 'agent.deleted' AND entity_id = ?", bob.id));
    assert.equal((await owner.fetch(`/api/owner/agents/${bob.id}`, { method: 'DELETE' })).status, 404);
  });
});

describe('agents migration', () => {
  it('turns what is already known about connections into agents, with nothing to re-enter', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-agents-'));
    const db = openDatabase(path.join(dir, 'w.sqlite'));
    try {
      db.exec('CREATE TABLE app_migration (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
      for (const m of migrations.filter((x) => x.id < 8)) tx(db, () => db.exec(m.sql));
      const t = '2026-01-01T00:00:00.000Z';
      run(db, "INSERT INTO member (id, name, is_owner, created_at) VALUES ('mem_1', 'Owner', 1, ?)", t);
      const role = (id: string, slug: string, name: string, archived: string | null = null) =>
        run(db, 'INSERT INTO role (id, member_id, slug, name, archived_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?)', id, 'mem_1', slug, name, archived, t, t);
      role('role_a', 'coordinator', 'Coordinator');
      role('role_b', 'developer', 'Developer');
      role('role_c', 'unused', 'Unused');
      role('role_d', 'old', 'Old', t);
      const conn = (id: string, name: string, created: string, revoked: string | null = null) =>
        run(db, 'INSERT INTO connection (client_id, member_id, name, created_at, approved_at, revoked_at) VALUES (?,?,?,?,?,?)', id, 'mem_1', name, created, created, revoked);
      conn('c1', 'First', '2026-01-01T00:00:00.000Z');
      conn('c2', 'Second', '2026-01-02T00:00:00.000Z');
      conn('c3', 'Revoked', '2026-01-03T00:00:00.000Z', t);
      // c1: on the confirmed list as coordinator, and has written as developer (by slug) and as an archived role.
      run(db, "INSERT INTO connection_role (client_id, role_id, source) VALUES ('c1', 'role_a', 'owner')");
      const wrote = (client: string, claimed: string) =>
        run(db, "INSERT INTO event (member_id, at, actor_kind, connection_id, claimed_role, entity_type, action, summary) VALUES ('mem_1', ?, 'agent', ?, ?, 'task', 'task.created', 's')", t, client, claimed);
      wrote('c1', 'developer');
      wrote('c1', 'old');
      // c2: has written as developer (by id) and under a name that is not a role.
      wrote('c2', 'role_b');
      wrote('c2', 'somebody');
      // c3 is revoked: nothing is created for it.
      run(db, "INSERT INTO connection_role (client_id, role_id, source) VALUES ('c3', 'role_a', 'owner')");

      tx(db, () => db.exec(migrations.find((m) => m.id === 8)!.sql));

      const agents = all<{ slug: string; name: string; client_id: string; role: string }>(
        db,
        'SELECT a.slug, a.name, a.client_id, r.slug AS role FROM agent a JOIN agent_role ar ON ar.agent_id = a.id JOIN role r ON r.id = ar.role_id ORDER BY a.client_id, a.slug',
      );
      assert.deepEqual(
        agents.map((a) => ({ ...a })),
        [
          { slug: 'coordinator', name: 'Coordinator', client_id: 'c1', role: 'coordinator' },
          { slug: 'developer', name: 'Developer', client_id: 'c1', role: 'developer' },
          { slug: 'developer-2', name: 'Developer', client_id: 'c2', role: 'developer' },
        ],
      );
      assert.equal(get<{ n: number }>(db, 'SELECT count(*) AS n FROM agent')!.n, 3);
      assert.equal(get(db, "SELECT 1 FROM sqlite_master WHERE name = 'agent_backfill'"), undefined);
      // The role lists that the checks on writes use are untouched.
      assert.equal(get<{ n: number }>(db, 'SELECT count(*) AS n FROM connection_role')!.n, 2);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
