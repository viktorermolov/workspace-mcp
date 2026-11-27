import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { strFromU8, unzipSync } from 'fflate';
import { buildExport, importExport } from '../src/backup/export.ts';
import { all, get, openDatabase, run, tx } from '../src/db/db.ts';
import { migrations } from '../src/db/schema.ts';
import { saveAgent } from '../src/domain/agents.ts';
import { DomainError, type Actor } from '../src/domain/core.ts';
import { call, connectAgent, registerOwner, startService, type Browser, type TestEnv } from './helpers/harness.ts';

/** The owner confirms the roles a platform may act as; an agent can be given only roles from that list. */
const confirmRoles = (owner: Browser, clientId: string, roles: string[]) =>
  owner.json(`/api/owner/connections/${encodeURIComponent(clientId)}/roles`, { json: { roles, confirm: true } });

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
    await confirmRoles(owner, grokId, ['coordinator', 'developer']);
    await confirmRoles(owner, otherId, ['developer']);
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

  it('makes a free slug from the name, and asks for one when the name has no Latin letters', async () => {
    const noLatin = await owner.fetch('/api/owner/agents', { json: { name: 'Арина', platform: grokId } });
    assert.equal(noLatin.status, 400);
    assert.match(((await noLatin.json()) as { message: string }).message, /no Latin letters or digits.*pass slug/);
    const made: AgentView[] = [];
    made.push(await owner.json<AgentView>('/api/owner/agents', { json: { name: 'Арина', slug: 'arina', platform: grokId } }));
    made.push(await owner.json<AgentView>('/api/owner/agents', { json: { name: 'Bob', platform: grokId } }));
    assert.deepEqual(made.map((a) => [a.name, a.slug]), [['Арина', 'arina'], ['Bob', 'bob-2']]);
    for (const a of made) await owner.json(`/api/owner/agents/${a.id}`, { method: 'DELETE' });
  });

  it('a slug stays with its agent: it cannot be changed, and a removed agent with history does not hand it on', async () => {
    const tmp = await owner.json<AgentView>('/api/owner/agents', { json: { name: 'Temp', platform: grokId, roles: ['developer'] } });
    const renamed = await owner.fetch('/api/owner/agents', { json: { id: tmp.id, rev: tmp.rev, slug: 'temp-2' } });
    assert.equal(renamed.status, 400);
    assert.match(((await renamed.json()) as { message: string }).message, /slug cannot be changed/);
    // Sending the same slug back is not a change.
    const same = await owner.json<AgentView & { unchanged?: boolean }>('/api/owner/agents', { json: { id: tmp.id, rev: tmp.rev, slug: 'temp' } });
    assert.equal(same.unchanged, true);
    await call(grok, 'save_task', { title: 'By Temp', claimed_role: 'developer', agent: 'temp' });
    await owner.json(`/api/owner/agents/${tmp.id}`, { method: 'DELETE' });
    const reuse = await owner.fetch('/api/owner/agents', { json: { name: 'Other', slug: 'temp', platform: grokId } });
    assert.equal(reuse.status, 409);
    assert.match(((await reuse.json()) as { message: string }).message, /belonged to a removed agent/);
    // A slug made from the name steps over it too, so the new agent does not inherit the old one's history.
    const next = await owner.json<AgentView>('/api/owner/agents', { json: { name: 'Temp', platform: grokId } });
    assert.equal(next.slug, 'temp-2');
    await owner.json(`/api/owner/agents/${next.id}`, { method: 'DELETE' });
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
  it('migration 12 adds an agent migration 8 skipped over a slug collision, and only that', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-agents-'));
    const db = openDatabase(path.join(dir, 'w.sqlite'));
    const apply = (id: number, at: string) =>
      tx(db, () => {
        const m = migrations.find((x) => x.id === id)!;
        db.exec(m.sql);
        run(db, 'INSERT INTO app_migration (id, name, applied_at) VALUES (?, ?, ?)', m.id, m.name, at);
      });
    const pairs = () =>
      all<{ client_id: string; role: string }>(db, 'SELECT a.client_id, r.slug AS role FROM agent a JOIN agent_role ar ON ar.agent_id = a.id JOIN role r ON r.id = ar.role_id ORDER BY a.client_id, r.slug').map((p) => `${p.client_id}/${p.role}`);
    try {
      db.exec('CREATE TABLE app_migration (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
      for (const m of migrations.filter((x) => x.id < 8)) tx(db, () => db.exec(m.sql));
      const t = '2026-01-01T00:00:00.000Z';
      run(db, "INSERT INTO member (id, name, is_owner, created_at) VALUES ('mem_1', 'Owner', 1, ?)", t);
      for (const [id, slug] of [['role_b', 'builder'], ['role_b2', 'builder-2'], ['role_x', 'extra']] as const) {
        run(db, 'INSERT INTO role (id, member_id, slug, name, created_at, updated_at) VALUES (?,?,?,?,?,?)', id, 'mem_1', slug, slug, t, t);
      }
      for (const [id, created] of [['cA', '2026-01-01T00:00:00.000Z'], ['cB', '2026-01-02T00:00:00.000Z']] as const) {
        run(db, 'INSERT INTO connection (client_id, member_id, name, created_at, approved_at, roles_confirmed_at) VALUES (?,?,?,?,?,?)', id, 'mem_1', id, created, created, t);
      }
      // The case from #154: A is confirmed for builder and builder-2, B (newer) for builder, whose numbered slug is builder-2.
      for (const [c, r] of [['cA', 'role_b'], ['cA', 'role_b2'], ['cB', 'role_b']] as const) run(db, "INSERT INTO connection_role (client_id, role_id, source) VALUES (?, ?, 'owner')", c, r);
      apply(8, '2026-02-01T00:00:00.000Z');
      assert.equal(pairs().length, 2, 'migration 8 skips one of the three pairs');
      for (const id of [9, 10, 11]) apply(id, '2026-02-01T00:00:00.000Z');
      // Confirmed after migration 8: no agent for it is the owner's state, not a skipped one.
      run(db, "INSERT INTO connection (client_id, member_id, name, created_at, approved_at, roles_confirmed_at) VALUES ('cC', 'mem_1', 'cC', ?, ?, '2026-03-01T00:00:00.000Z')", t, t);
      run(db, "INSERT INTO connection_role (client_id, role_id, source) VALUES ('cC', 'role_x', 'owner')");

      apply(12, '2026-04-01T00:00:00.000Z');
      assert.deepEqual(pairs(), ['cA/builder', 'cA/builder-2', 'cB/builder']);
      const slugs = all<{ slug: string }>(db, 'SELECT slug FROM agent ORDER BY slug').map((a) => a.slug);
      assert.equal(new Set(slugs).size, 3);
      assert.ok(slugs.some((x) => /^builder(-2)?-[0-9a-f]{6}$/.test(x)), slugs.join());
      assert.equal(get(db, "SELECT 1 FROM sqlite_master WHERE name = 'agent_backfill'"), undefined);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('migration 12 adds nothing once the owner has changed any agent', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-agents-'));
    const db = openDatabase(path.join(dir, 'w.sqlite'));
    try {
      db.exec('CREATE TABLE app_migration (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
      const t = '2026-01-01T00:00:00.000Z';
      for (const m of migrations.filter((x) => x.id < 12)) {
        tx(db, () => db.exec(m.sql));
        run(db, 'INSERT INTO app_migration (id, name, applied_at) VALUES (?, ?, ?)', m.id, m.name, '2026-02-01T00:00:00.000Z');
      }
      run(db, "INSERT INTO member (id, name, is_owner, created_at) VALUES ('mem_1', 'Owner', 1, ?)", t);
      run(db, "INSERT INTO role (id, member_id, slug, name, created_at, updated_at) VALUES ('role_b', 'mem_1', 'builder', 'Builder', ?, ?)", t, t);
      run(db, "INSERT INTO connection (client_id, member_id, name, created_at, approved_at, roles_confirmed_at) VALUES ('cA', 'mem_1', 'cA', ?, ?, ?)", t, t, t);
      run(db, "INSERT INTO connection_role (client_id, role_id, source) VALUES ('cA', 'role_b', 'owner')");
      // The owner removed the agent migration 8 made: the pair has no agent on purpose.
      run(db, "INSERT INTO event (member_id, at, actor_kind, entity_type, action, summary) VALUES ('mem_1', ?, 'owner', 'agent', 'agent.deleted', 'Agent removed')", t);
      tx(db, () => db.exec(migrations.find((m) => m.id === 12)!.sql));
      assert.equal(get<{ n: number }>(db, 'SELECT count(*) AS n FROM agent')!.n, 0);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates agents only from the roles the owner confirmed for a connection', () => {
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
      conn('c4', 'Draft', '2026-01-04T00:00:00.000Z');
      conn('c2', 'Second', '2026-01-02T00:00:00.000Z');
      conn('c3', 'Revoked', '2026-01-03T00:00:00.000Z', t);
      // c1: confirmed by the owner as coordinator and as an archived role; developer is only suggested, and it has written as developer.
      run(db, "INSERT INTO connection_role (client_id, role_id, source) VALUES ('c1', 'role_a', 'owner')");
      const wrote = (client: string, claimed: string) =>
        run(db, "INSERT INTO event (member_id, at, actor_kind, connection_id, claimed_role, entity_type, action, summary) VALUES ('mem_1', ?, 'agent', ?, ?, 'task', 'task.created', 's')", t, client, claimed);
      run(db, "INSERT INTO connection_role (client_id, role_id, source) VALUES ('c1', 'role_d', 'owner')");
      run(db, "INSERT INTO connection_role (client_id, role_id, source) VALUES ('c1', 'role_b', 'suggested')");
      wrote('c1', 'developer');
      // c2: nothing confirmed; it has written as developer (by id) and under a name that is not a role.
      wrote('c2', 'role_b');
      wrote('c2', 'somebody');
      // c4: the owner saved a list and did not confirm it, so it is still a draft and creates nothing.
      run(db, "INSERT INTO connection_role (client_id, role_id, source) VALUES ('c4', 'role_a', 'owner')");
      run(db, "UPDATE connection SET roles_confirmed_at = ? WHERE client_id IN ('c1', 'c3')", t);
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
        ],
        'a role a connection only claimed, or that was only suggested, is not granted',
      );
      assert.equal(get<{ n: number }>(db, 'SELECT count(*) AS n FROM agent')!.n, 1);
      assert.equal(get(db, "SELECT 1 FROM sqlite_master WHERE name = 'agent_backfill'"), undefined);
      // The role lists that the checks on writes use are untouched.
      assert.equal(get<{ n: number }>(db, 'SELECT count(*) AS n FROM connection_role')!.n, 5);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('agents name themselves', () => {
  let env: TestEnv;
  let owner: Browser;
  let grok: Awaited<ReturnType<typeof connectAgent>>['client'];
  let other: Awaited<ReturnType<typeof connectAgent>>['client'];
  let grokId: string;
  let otherId: string;
  const err = (e: unknown) => JSON.parse((e as Error).message) as { error: string; message: string };
  type Warned = { id: string; rev: number; warnings?: { code: string }[] };
  const codes = (r: Warned) => (r.warnings ?? []).map((w) => w.code);

  before(async () => {
    env = await startService();
    owner = (await registerOwner(env)).browser;
    for (const [name, slug] of [['Developer', 'developer'], ['Marketer', 'marketer']]) await owner.json('/api/owner/roles', { json: { name, slug } });
    grok = (await connectAgent(env, owner, 'Grok')).client;
    other = (await connectAgent(env, owner, 'Home server')).client;
    const list = await owner.json<{ connections: { client_id: string; name: string }[] }>('/api/owner/connections');
    grokId = list.connections.find((c) => c.name === 'Grok')!.client_id;
    otherId = list.connections.find((c) => c.name === 'Home server')!.client_id;
    await confirmRoles(owner, grokId, ['developer', 'marketer']);
    await confirmRoles(owner, otherId, ['developer']);
    await owner.json('/api/owner/agents', { json: { name: 'Ada', platform: grokId, roles: ['developer'] } });
    await owner.json('/api/owner/agents', { json: { name: 'Bob', platform: grokId, roles: ['developer', 'marketer'] } });
    await owner.json('/api/owner/agents', { json: { name: 'Hal', platform: otherId, roles: ['developer'] } });
  });

  after(async () => {
    await env.close();
  });

  it('two agents with the same role on one platform are told apart in the log, comments, versions and checkpoints', async () => {
    const t1 = await call<Warned>(grok, 'save_task', { title: 'By Ada', claimed_role: 'developer', agent: 'ada' });
    const t2 = await call<Warned>(grok, 'save_task', { title: 'By Bob', claimed_role: 'developer', agent: 'bob' });
    assert.deepEqual([codes(t1), codes(t2)], [[], []]);
    const log = await call<{ events: { by: string; agent?: string; summary: string }[] }>(grok, 'changes', { entity_type: 'task' });
    assert.deepEqual(
      log.events.map((e) => [e.summary, e.by, e.agent]),
      [
        ['Task "By Ada" created', 'Grok: ada as developer', 'ada'],
        ['Task "By Bob" created', 'Grok: bob as developer', 'bob'],
      ],
    );
    await call(grok, 'comment_task', { id: t1.id, body: 'On it.', claimed_role: 'developer', agent: 'bob' });
    const task = await call<{ comments: { agent: string | null; claimed_role: string }[] }>(grok, 'get', { type: 'task', id: t1.id });
    assert.deepEqual(task.comments.map((c) => [c.agent, c.claimed_role]), [['bob', 'developer']]);
    const doc = await call<{ id: string }>(grok, 'save_document', { title: 'Notes', body: 'v1', claimed_role: 'developer', agent: 'ada' });
    const history = await call<{ versions: { author: { connection: string; role: string; agent?: string } }[] }>(grok, 'versions', { type: 'document', id: doc.id });
    assert.deepEqual(history.versions[0]!.author, { connection: 'Grok', role: 'developer', agent: 'ada' });
    await call(grok, 'checkpoint', { role: 'developer', claimed_role: 'developer', agent: 'bob', done: 'd', stopped_at: 's', next: 'n' });
    const start = await call<{ instructions: { agent?: { slug: string; platform: string; roles: string[] } }; data: { last_checkpoint: { agent: string | null } }; warnings?: unknown }>(grok, 'start', { role: 'developer', agent: 'bob' });
    assert.deepEqual(start.instructions.agent, { slug: 'bob', name: 'Bob', platform: 'Grok', roles: ['developer', 'marketer'] });
    assert.equal(start.data.last_checkpoint.agent, 'bob');
  });

  it('a call that names no agent still works; on a platform with agents the response asks for the name', async () => {
    const t = await call<Warned>(grok, 'save_task', { title: 'Anonymous', claimed_role: 'developer' });
    assert.ok(t.id);
    assert.ok(codes(t).includes('agent_missing'));
    assert.equal(get<{ agent: string | null }>(env.svc.db, "SELECT agent FROM event WHERE entity_id = ? AND action = 'task.created'", t.id)!.agent, null);
  });

  it('in warning mode a wrong agent or role is reported and the wrong name is not recorded', async () => {
    const unknown = await call<Warned>(grok, 'save_task', { title: 'W1', claimed_role: 'developer', agent: 'nobody' });
    const elsewhere = await call<Warned>(grok, 'save_task', { title: 'W2', claimed_role: 'developer', agent: 'hal' });
    const wrongRole = await call<Warned>(grok, 'save_task', { title: 'W3', claimed_role: 'marketer', agent: 'ada' });
    assert.ok(codes(unknown).includes('agent_not_found'));
    assert.ok(codes(elsewhere).includes('agent_wrong_platform'));
    assert.ok(codes(wrongRole).includes('agent_role_not_allowed'));
    const recorded = (id: string) => get<{ agent: string | null }>(env.svc.db, "SELECT agent FROM event WHERE entity_id = ? AND action = 'task.created'", id)!.agent;
    assert.deepEqual([recorded(unknown.id), recorded(elsewhere.id), recorded(wrongRole.id)], [null, null, 'ada']);
  });

  it('with enforcement on, a named agent answers with its own roles and a wrong name or role is refused', async () => {
    await owner.json('/api/owner/settings/role-enforcement', { json: { mode: 'enforce', override: true } });
    // Grok is confirmed for developer and marketer, Home server for developer; each agent holds part of its platform's list.
    const ok = await call<Warned>(grok, 'save_task', { title: 'E1', claimed_role: 'marketer', agent: 'bob' });
    assert.deepEqual(codes(ok), []);
    const okElsewhere = await call<Warned>(other, 'save_task', { title: 'E2', claimed_role: 'developer', agent: 'hal' });
    assert.ok(okElsewhere.id);
    for (const [client, args, reason] of [
      [grok, { title: 'X', claimed_role: 'marketer', agent: 'ada' }, /may not take the role "marketer"/],
      [grok, { title: 'X', claimed_role: 'developer', agent: 'hal' }, /does not run on this platform/],
      [grok, { title: 'X', claimed_role: 'developer', agent: 'nobody' }, /agent not found/],
      [other, { title: 'X', claimed_role: 'marketer' }, /confirmed allow-list/],
    ] as const) {
      await assert.rejects(call(client, 'save_task', args), (e) => err(e).error === 'forbidden' && reason.test(err(e).message));
    }
    await assert.rejects(call(grok, 'start', { role: 'marketer', agent: 'ada' }), (e) => err(e).error === 'forbidden');
    const start = await call<{ instructions: { role: string } }>(grok, 'start', { role: 'marketer', agent: 'bob' });
    assert.equal(start.instructions.role, 'marketer');
    assert.equal(get<{ n: number }>(env.svc.db, "SELECT count(*) AS n FROM task WHERE title = 'X'")!.n, 0);
    // A call that names no agent is checked against the platform's list, as before.
    const unnamed = await call<Warned>(grok, 'save_task', { title: 'E3', claimed_role: 'developer' });
    assert.ok(unnamed.id);
  });

  it('the platform list is the ceiling: an agent gets only roles confirmed for its platform, for start and for writes alike', async () => {
    // Home server is confirmed for developer only, so Hal cannot be given marketer there.
    const hal = (await owner.json<{ agents: AgentView[] }>('/api/owner/agents')).agents.find((a) => a.slug === 'hal')!;
    const res = await owner.fetch('/api/owner/agents', { json: { id: hal.id, rev: hal.rev, roles: ['developer', 'marketer'] } });
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { message: string }).message, /not confirmed for the platform "Home server": marketer/);
    const fresh = await owner.fetch('/api/owner/agents', { json: { name: 'Eve', platform: otherId, roles: ['marketer'] } });
    assert.equal(fresh.status, 400);
    // Taking marketer off Grok takes it off Bob too: start and a write refuse it the same way.
    await confirmRoles(owner, grokId, ['developer']);
    const bob = (await owner.json<{ agents: AgentView[] }>('/api/owner/agents')).agents.find((a) => a.slug === 'bob')!;
    assert.deepEqual(bob.roles.map((r) => r.slug), ['developer']);
    for (const tool of ['start', 'save_task'] as const) {
      const args = tool === 'start' ? { role: 'marketer', agent: 'bob' } : { title: 'X', claimed_role: 'marketer', agent: 'bob' };
      await assert.rejects(call(grok, tool, args), (e) => err(e).error === 'forbidden' && /agent "bob" may not take the role "marketer"/.test(err(e).message), tool);
    }
    // An unconfirmed platform list allows nothing, whatever the agent's own list says.
    await owner.json(`/api/owner/connections/${encodeURIComponent(grokId)}/roles`, { json: { roles: ['developer'], confirm: false } });
    await assert.rejects(call(grok, 'save_task', { title: 'X', claimed_role: 'developer', agent: 'bob' }), (e) => err(e).error === 'forbidden');
    const start = await call<{ data: { agents: { slug: string; roles: string[] }[] } }>(other, 'start');
    assert.deepEqual(start.data.agents.find((a) => a.slug === 'bob')!.roles, []);
  });
});

describe('tasks addressed to an agent', () => {
  let env: TestEnv;
  let owner: Browser;
  let grok: Awaited<ReturnType<typeof connectAgent>>['client'];
  let other: Awaited<ReturnType<typeof connectAgent>>['client'];
  const err = (e: unknown) => JSON.parse((e as Error).message) as { error: string; message: string };
  type Task = { id: string; rev: number; for_agent: string | null; claimed_by: { agent?: string } | null };
  type Start = { data: { open_tasks: { title: string; for_agent: string | null }[]; last_checkpoint: { done: string; agent: string | null } | null; newer_checkpoint_by_another_agent?: { agent: string | null; platform: string | null } } };

  before(async () => {
    env = await startService();
    owner = (await registerOwner(env)).browser;
    for (const [name, slug] of [['Developer', 'developer'], ['Marketer', 'marketer']]) await owner.json('/api/owner/roles', { json: { name, slug } });
    grok = (await connectAgent(env, owner, 'Grok')).client;
    other = (await connectAgent(env, owner, 'Home server')).client;
    const list = await owner.json<{ connections: { client_id: string; name: string }[] }>('/api/owner/connections');
    const id = (n: string) => list.connections.find((c) => c.name === n)!.client_id;
    await confirmRoles(owner, id('Grok'), ['developer', 'marketer']);
    await confirmRoles(owner, id('Home server'), ['developer']);
    await owner.json('/api/owner/agents', { json: { name: 'Ada', platform: id('Grok'), roles: ['developer'] } });
    await owner.json('/api/owner/agents', { json: { name: 'Hal', platform: id('Home server'), roles: ['developer'] } });
    await owner.json('/api/owner/agents', { json: { name: 'Mia', platform: id('Grok'), roles: ['marketer'] } });
  });

  after(async () => {
    await env.close();
  });

  it('a coordinator gives one task to the developer on one platform and one to the developer on another', async () => {
    const forAda = await call<Task>(grok, 'save_task', { title: 'For Ada', role: 'developer', for_agent: 'ada', claimed_role: 'marketer', agent: 'mia' });
    await call<Task>(grok, 'save_task', { title: 'For Hal', role: 'developer', for_agent: 'hal', claimed_role: 'marketer', agent: 'mia' });
    await call<Task>(grok, 'save_task', { title: 'For any developer', role: 'developer', claimed_role: 'marketer', agent: 'mia' });
    assert.equal(forAda.for_agent, 'ada');
    const ada = await call<Start>(grok, 'start', { role: 'developer', agent: 'ada' });
    const hal = await call<Start>(other, 'start', { role: 'developer', agent: 'hal' });
    const anyone = await call<Start>(other, 'start', { role: 'developer' });
    assert.deepEqual(ada.data.open_tasks.map((t) => t.title), ['For Ada', 'For any developer']);
    assert.deepEqual(hal.data.open_tasks.map((t) => t.title), ['For Hal', 'For any developer']);
    assert.deepEqual(anyone.data.open_tasks.map((t) => t.title).sort(), ['For Ada', 'For Hal', 'For any developer']);
  });

  it('an addressed task is claimed only by its agent, and the claim records the agent', async () => {
    const found = await call<{ results: { id: string; title: string }[] }>(grok, 'search', { types: ['task'] });
    const forHal = found.results.find((t) => t.title === 'For Hal')!;
    await assert.rejects(call(grok, 'claim_task', { id: forHal.id, claimed_role: 'developer', agent: 'ada' }), (e) => err(e).error === 'conflict' && /addressed to agent "hal"/.test(err(e).message));
    // A call without agent is not the addressee, on another platform or on the addressee's own.
    for (const c of [grok, other]) {
      await assert.rejects(call(c, 'claim_task', { id: forHal.id, claimed_role: 'developer' }), (e) => err(e).error === 'conflict' && /addressed to agent "hal".*named no agent/.test(err(e).message));
    }
    const claimed = await call<Task>(other, 'claim_task', { id: forHal.id, claimed_role: 'developer', agent: 'hal' });
    assert.deepEqual(claimed.claimed_by?.agent, 'hal');
  });

  it('a role the owner marked may re-address a task of another role, and change nothing else on it', async () => {
    await owner.json('/api/owner/settings/role-enforcement', { json: { mode: 'enforce', override: true } });
    try {
      const t = await call<Task>(grok, 'save_task', { title: 'Routed', role: 'developer', claimed_role: 'developer', agent: 'ada' });
      // Marketer does not own the task, so it cannot address it.
      await assert.rejects(call(grok, 'save_task', { id: t.id, rev: t.rev, for_agent: 'ada', claimed_role: 'marketer', agent: 'mia' }), (e) => err(e).error === 'forbidden');
      // MCP cannot grant the mark; the owner sets it.
      const tools = (await grok.listTools()).tools;
      assert.ok(!JSON.stringify(tools).includes('routes_tasks'));
      const set = await owner.json<{ roles: { slug: string; routes_tasks: boolean }[] }>('/api/owner/roles/marketer/routes-tasks', { json: { routes_tasks: true } });
      assert.equal(set.roles.find((r) => r.slug === 'marketer')!.routes_tasks, true);
      const routed = await call<Task>(grok, 'save_task', { id: t.id, rev: t.rev, for_agent: 'ada', claimed_role: 'marketer', agent: 'mia' });
      assert.equal(routed.for_agent, 'ada');
      // The agent must still be able to take the task's role, and nothing else may change in the same call.
      await assert.rejects(call(grok, 'save_task', { id: t.id, rev: routed.rev, for_agent: 'mia', claimed_role: 'marketer', agent: 'mia' }), (e) => err(e).error === 'invalid' && /may not take the role "developer"/.test(err(e).message));
      await assert.rejects(call(grok, 'save_task', { id: t.id, rev: routed.rev, for_agent: null, title: 'Renamed', claimed_role: 'marketer', agent: 'mia' }), (e) => err(e).error === 'forbidden');
      await assert.rejects(call(grok, 'save_task', { id: t.id, rev: routed.rev, status: 'done', claimed_role: 'marketer', agent: 'mia' }), (e) => err(e).error === 'forbidden');
      const cleared = await call<Task>(grok, 'save_task', { id: t.id, rev: routed.rev, for_agent: null, claimed_role: 'marketer', agent: 'mia' });
      assert.equal(cleared.for_agent, null);
      const ev = get<{ summary: string }>(env.svc.db, "SELECT summary FROM event WHERE action = 'role.privilege_updated' ORDER BY id DESC LIMIT 1");
      assert.equal(ev!.summary, 'Role "Marketer" may address any task to an agent');
      await owner.json('/api/owner/roles/marketer/routes-tasks', { json: { routes_tasks: false } });
      await assert.rejects(call(grok, 'save_task', { id: t.id, rev: cleared.rev, for_agent: 'ada', claimed_role: 'marketer', agent: 'mia' }), (e) => err(e).error === 'forbidden');
    } finally {
      await owner.json('/api/owner/settings/role-enforcement', { json: { mode: 'warn' } });
    }
  });

  it('refuses an unknown agent, an agent that cannot take the role, and an address without a role; null clears it', async () => {
    for (const [args, reason] of [
      [{ title: 'X', role: 'developer', for_agent: 'nobody' }, /agent not found/],
      [{ title: 'X', role: 'developer', for_agent: 'mia' }, /may not take the role "developer"/],
      [{ title: 'X', for_agent: 'ada' }, /needs a role/],
    ] as const) {
      await assert.rejects(call(grok, 'save_task', { ...args, claimed_role: 'marketer', agent: 'mia' }), (e) => err(e).error === 'invalid' && reason.test(err(e).message));
    }
    const t = await call<Task>(grok, 'save_task', { title: 'Movable', role: 'developer', for_agent: 'ada', claimed_role: 'developer', agent: 'ada' });
    await assert.rejects(call(grok, 'save_task', { id: t.id, rev: t.rev, role: 'marketer', claimed_role: 'developer', agent: 'ada' }), (e) => /may not take the role "marketer"/.test(err(e).message));
    const cleared = await call<Task>(grok, 'save_task', { id: t.id, rev: t.rev, for_agent: null, claimed_role: 'developer', agent: 'ada' });
    assert.equal(cleared.for_agent, null);
    assert.equal(get<{ n: number }>(env.svc.db, "SELECT count(*) AS n FROM task WHERE title = 'X'")!.n, 0);
  });

  it('start shows an agent its own last checkpoint and points to a newer one by another agent of the role', async () => {
    await call(grok, 'checkpoint', { role: 'developer', claimed_role: 'developer', agent: 'ada', done: 'Ada did this', stopped_at: 's', next: 'n' });
    await call(other, 'checkpoint', { role: 'developer', claimed_role: 'developer', agent: 'hal', done: 'Hal did this', stopped_at: 's', next: 'n' });
    const ada = await call<Start>(grok, 'start', { role: 'developer', agent: 'ada' });
    assert.equal(ada.data.last_checkpoint?.done, 'Ada did this');
    assert.deepEqual({ agent: ada.data.newer_checkpoint_by_another_agent?.agent, platform: ada.data.newer_checkpoint_by_another_agent?.platform }, { agent: 'hal', platform: 'Home server' });
    const hal = await call<Start>(other, 'start', { role: 'developer', agent: 'hal' });
    assert.equal(hal.data.last_checkpoint?.done, 'Hal did this');
    assert.equal(hal.data.newer_checkpoint_by_another_agent, undefined);
    // A caller that names no agent continues from the role's latest checkpoint, as before.
    const anyone = await call<Start>(grok, 'start', { role: 'developer' });
    assert.equal(anyone.data.last_checkpoint?.done, 'Hal did this');
  });

  it('a zip export carries agents without their platform; after an import the owner attaches them and tasks keep their addressee', async () => {
    const memberId = get<{ member_id: string }>(env.svc.db, 'SELECT member_id FROM agent LIMIT 1')!.member_id;
    const { zip } = buildExport(env.svc.db, memberId);
    const data = JSON.parse(strFromU8(unzipSync(zip)['workspace.json']!)) as { tables: Record<string, Record<string, unknown>[]> };
    const exported = data.tables.agent!.map((a) => [a.slug, a.client_id, a.platform_name]);
    assert.deepEqual(exported.sort(), [['ada', null, 'Grok'], ['hal', null, 'Home server'], ['mia', null, 'Grok']]);
    assert.ok(data.tables.task!.some((t) => t.agent_id !== null));

    const dst = await startService();
    try {
      const dstOwner = (await registerOwner(dst)).browser;
      const dstMember = get<{ id: string }>(dst.svc.db, 'SELECT id FROM member')!.id;
      importExport(dst.svc.db, dstMember, zip);
      const agents = (await dstOwner.json<{ agents: (Omit<AgentView, 'platform'> & { platform: null | { id: string } })[] }>('/api/owner/agents')).agents;
      assert.deepEqual(agents.map((a) => [a.slug, a.platform, a.roles.map((r) => r.slug)]), [['ada', null, ['developer']], ['hal', null, ['developer']], ['mia', null, ['marketer']]]);
      const addressed = all<{ title: string; slug: string }>(dst.svc.db, 'SELECT t.title, a.slug FROM task t JOIN agent a ON a.id = t.agent_id ORDER BY t.title');
      assert.ok(addressed.some((t) => t.title === 'For Hal' && t.slug === 'hal'));
      // The agent page still shows what the agent did before the move.
      const page = await dstOwner.json<{ platform: null; last_checkpoint: { done: string } | null; recent: unknown[] }>('/api/owner/agents/hal');
      assert.equal(page.platform, null);
      assert.equal(page.last_checkpoint?.done, 'Hal did this');
      assert.ok(page.recent.length > 0);

      // Without a platform an agent can do nothing and cannot be given roles.
      const ada = agents.find((a) => a.slug === 'ada')!;
      const client = (await connectAgent(dst, dstOwner, 'New Grok')).client;
      const stray = await call<{ warnings?: { code: string }[] }>(client, 'save_task', { title: 'Before attach', claimed_role: 'developer', agent: 'ada' });
      assert.ok((stray.warnings ?? []).some((w) => w.code === 'agent_wrong_platform'));
      assert.equal(get<{ agent: string | null }>(dst.svc.db, "SELECT agent FROM event WHERE action = 'task.created' ORDER BY id DESC LIMIT 1")!.agent, null);
      const noRoles = await dstOwner.fetch('/api/owner/agents', { json: { id: ada.id, rev: ada.rev, roles: ['developer', 'marketer'] } });
      assert.equal(noRoles.status, 400);
      // The owner connects the platform, confirms its roles and attaches the agent.
      const list = await dstOwner.json<{ connections: { client_id: string; name: string }[] }>('/api/owner/connections');
      const newId = list.connections.find((c) => c.name === 'New Grok')!.client_id;
      await confirmRoles(dstOwner, newId, ['developer']);
      const attached = await dstOwner.json<AgentView>('/api/owner/agents', { json: { id: ada.id, rev: ada.rev, platform: newId, roles: ['developer'] } });
      assert.equal(attached.platform.name, 'New Grok');
      const ok = await call<{ id: string; warnings?: unknown[] }>(client, 'save_task', { title: 'After attach', claimed_role: 'developer', agent: 'ada' });
      assert.ok(ok.id);
      const start = await call<{ data: { agents: { slug: string }[] } }>(client, 'start');
      assert.deepEqual(start.data.agents.map((a) => a.slug), ['ada']);
    } finally {
      await dst.close();
    }
  });

  it('the owner page of an agent shows its tasks, its own checkpoint and what it changed', async () => {
    const hal = await owner.json<{
      slug: string;
      platform: { name: string };
      roles: { slug: string }[];
      tasks_for_agent: { title: string; status: string; role: string }[];
      tasks_claimed: unknown[];
      last_checkpoint: { done: string; role: string } | null;
      recent: { action: string }[];
    }>('/api/owner/agents/hal');
    assert.deepEqual([hal.slug, hal.platform.name, hal.roles.map((r) => r.slug)], ['hal', 'Home server', ['developer']]);
    assert.deepEqual(hal.tasks_for_agent.map((t) => [t.title, t.status, t.role]), [['For Hal', 'in_progress', 'developer']]);
    assert.deepEqual(hal.tasks_claimed, []);
    assert.deepEqual([hal.last_checkpoint?.done, hal.last_checkpoint?.role], ['Hal did this', 'developer']);
    assert.deepEqual(hal.recent.map((e) => e.action), ['checkpoint.created', 'task.claimed']);
    const mia = await owner.json<{ tasks_for_agent: unknown[]; last_checkpoint: unknown; recent: { action: string }[] }>('/api/owner/agents/mia');
    assert.deepEqual([mia.tasks_for_agent, mia.last_checkpoint], [[], null]);
    assert.ok(mia.recent.length > 0 && mia.recent.every((e) => e.action.startsWith('task.')));
    assert.equal((await owner.fetch('/api/owner/agents/nobody')).status, 404);
  });

  it('removing an agent leaves its tasks with the role, addressed to nobody', async () => {
    const ada = (await owner.json<{ agents: AgentView[] }>('/api/owner/agents')).agents.find((a) => a.slug === 'ada')!;
    await owner.json(`/api/owner/agents/${ada.id}`, { method: 'DELETE' });
    const row = get<{ agent_id: string | null; role: string }>(env.svc.db, "SELECT t.agent_id, r.slug AS role FROM task t JOIN role r ON r.id = t.role_id WHERE t.title = 'For Ada'")!;
    assert.deepEqual({ ...row }, { agent_id: null, role: 'developer' });
  });
});

describe('owner comments reach the responsible agent', () => {
  let env: TestEnv;
  let owner: Browser;
  let grok: Awaited<ReturnType<typeof connectAgent>>['client'];
  type Start = {
    data: {
      owner_comments_waiting_on_tasks?: { task_id: string; title: string; comment: string }[];
      review_comments?: { id: string; target_type: string; target_id: string; body: string }[];
    };
  };

  before(async () => {
    env = await startService();
    owner = (await registerOwner(env)).browser;
    await owner.json('/api/owner/roles', { json: { name: 'Developer', slug: 'developer' } });
    await owner.json('/api/owner/roles', { json: { name: 'Marketer', slug: 'marketer' } });
    grok = (await connectAgent(env, owner, 'Grok')).client;
  });

  after(async () => {
    await env.close();
  });

  it('an owner comment on a task shows in start for the task role until an agent answers', async () => {
    const task = await call<{ id: string }>(grok, 'save_task', { title: 'Ship it', role: 'developer', claimed_role: 'developer' });
    await call(grok, 'comment_task', { id: task.id, body: 'Started.', claimed_role: 'developer' });
    assert.equal((await call<Start>(grok, 'start', { role: 'developer' })).data.owner_comments_waiting_on_tasks, undefined);
    await owner.json(`/api/owner/tasks/${task.id}/comment`, { json: { body: 'Why is this taking so long?' } });
    const waiting = (await call<Start>(grok, 'start', { role: 'developer' })).data.owner_comments_waiting_on_tasks;
    assert.deepEqual(waiting?.map((c) => [c.task_id, c.title, c.comment]), [[task.id, 'Ship it', 'Why is this taking so long?']]);
    assert.equal((await call<Start>(grok, 'start', { role: 'marketer' })).data.owner_comments_waiting_on_tasks, undefined);
    await call(grok, 'comment_task', { id: task.id, body: 'Blocked on review, done tomorrow.', claimed_role: 'developer' });
    assert.equal((await call<Start>(grok, 'start', { role: 'developer' })).data.owner_comments_waiting_on_tasks, undefined);
  });

  it('the owner comments on a routine, its role sees and answers it, and the owner resolves it', async () => {
    const routine = await call<{ id: string }>(grok, 'save_routine', { name: 'Morning brief', role: 'developer', schedule: '30 8 * * 1-5', claimed_role: 'developer' });
    const comment = await owner.json<{ id: string; target_type: string; anchor_state: string; responsible_role: string }>('/api/owner/reviews', {
      json: { target_type: 'routine', target_id: routine.id, field: 'item', body: 'Too early, move it to 9:30.' },
    });
    assert.deepEqual([comment.target_type, comment.anchor_state, comment.responsible_role], ['routine', 'none', 'developer']);
    const start = await call<Start>(grok, 'start', { role: 'developer' });
    assert.deepEqual(start.data.review_comments?.map((c) => [c.id, c.target_type, c.target_id]), [[comment.id, 'routine', routine.id]]);
    assert.equal((await call<Start>(grok, 'start', { role: 'marketer' })).data.review_comments?.length ?? 0, 0);
    const got = await call<{ open_review_comments: { id: string }[] }>(grok, 'get', { type: 'routine', id: routine.id });
    assert.deepEqual(got.open_review_comments.map((c) => c.id), [comment.id]);
    const replied = await call<{ status: string }>(grok, 'reply_review_comment', { id: comment.id, body: 'Moved to 9:30.', status: 'answered', claimed_role: 'developer' });
    assert.equal(replied.status, 'answered');
    const bad = await owner.fetch('/api/owner/reviews', { json: { target_type: 'routine', target_id: routine.id, field: 'body', body: 'x' } });
    assert.equal(bad.status, 400);
    // Deleting the routine removes its comments.
    await owner.json('/api/owner/archive', { json: { type: 'routine', id: routine.id } });
    await owner.json('/api/owner/purge', { json: { type: 'routine', id: routine.id } });
    assert.equal(get<{ n: number }>(env.svc.db, 'SELECT count(*) AS n FROM review_comment WHERE target_id = ?', routine.id)!.n, 0);
  });
});

describe('the map shows who runs where', () => {
  let env: TestEnv;
  let owner: Browser;

  before(async () => {
    env = await startService();
    owner = (await registerOwner(env)).browser;
    await owner.json('/api/owner/roles', { json: { name: 'Developer', slug: 'developer' } });
    await owner.json('/api/owner/roles', { json: { name: 'Coordinator', slug: 'coordinator' } });
    await connectAgent(env, owner, 'Grok');
    await connectAgent(env, owner, 'Home server');
    await connectAgent(env, owner, 'Gone');
    const list = await owner.json<{ connections: { client_id: string; name: string }[] }>('/api/owner/connections');
    const id = (n: string) => list.connections.find((c) => c.name === n)!.client_id;
    await confirmRoles(owner, id('Grok'), ['coordinator', 'developer']);
    for (const n of ['Home server', 'Gone']) await confirmRoles(owner, id(n), ['developer']);
    await owner.json('/api/owner/agents', { json: { name: 'Ada', platform: id('Grok'), roles: ['coordinator', 'developer'] } });
    await owner.json('/api/owner/agents', { json: { name: 'Hal', platform: id('Home server'), roles: ['developer'] } });
    await owner.json('/api/owner/agents', { json: { name: 'Old', platform: id('Gone'), roles: ['developer'] } });
    await owner.json(`/api/owner/connections/${encodeURIComponent(id('Gone'))}/revoke`, { json: {} });
  });

  after(async () => {
    await env.close();
  });

  it('lists active platforms with their agents and roles, and on each role the agents that may take it', async () => {
    const map = await owner.json<{
      platforms: { name: string; agents: { slug: string; roles: { slug: string }[] }[] }[];
      roles: { slug: string; agents: { slug: string; platform: string }[] }[];
    }>('/api/owner/map');
    assert.deepEqual(
      map.platforms.map((p) => [p.name, p.agents.map((a) => [a.slug, a.roles.map((r) => r.slug)])]),
      [
        ['Grok', [['ada', ['coordinator', 'developer']]]],
        ['Home server', [['hal', ['developer']]]],
      ],
    );
    const role = (slug: string) => map.roles.find((r) => r.slug === slug)!.agents;
    assert.deepEqual(role('developer'), [
      { slug: 'ada', name: 'Ada', platform: 'Grok' },
      { slug: 'hal', name: 'Hal', platform: 'Home server' },
    ]);
    assert.deepEqual(role('coordinator'), [{ slug: 'ada', name: 'Ada', platform: 'Grok' }]);
  });
});
