import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { all, get } from '../src/db/db.ts';
import { saveRole } from '../src/domain/entities.ts';
import { DomainError, type Actor } from '../src/domain/core.ts';
import { call, connectAgent, registerOwner, startService, ToolError, type Browser, type TestEnv } from './helpers/harness.ts';

const err = (e: unknown) => JSON.parse((e as ToolError).message) as { error: string; message: string };

interface Warning {
  code: string;
  message: string;
}

describe('role checks on writes', () => {
  let env: TestEnv;
  let owner: Browser;
  let agent: Awaited<ReturnType<typeof connectAgent>>['client'];
  let clientId: string;
  let leadId: string;
  let internId: string;
  let memberId: string;
  let otherClientId: string;

  before(async () => {
    env = await startService();
    owner = (await registerOwner(env)).browser;
    const lead = await owner.json<{ id: string; slug: string; rev: number }>('/api/owner/roles', { json: { name: 'Lead', slug: 'lead' } });
    const intern = await owner.json<{ id: string; slug: string }>('/api/owner/roles', { json: { name: 'Intern', slug: 'intern' } });
    leadId = lead.id;
    internId = intern.id;
    memberId = get<{ member_id: string }>(env.svc.db, 'SELECT member_id FROM role WHERE id = ?', leadId)!.member_id;
    const conn = await connectAgent(env, owner, 'Grok');
    agent = conn.client;
    const list = await owner.json<{ connections: { client_id: string; name: string }[] }>('/api/owner/connections');
    const grok = list.connections.find((c) => c.name === 'Grok');
    assert.ok(grok, 'Grok connection is listed');
    clientId = grok.client_id;
  });

  after(async () => {
    await env.close();
  });

  it('applies migration connection_roles after routines and #49\'s titled-rules-sets', () => {
    const applied = all<{ id: number; name: string }>(env.svc.db, 'SELECT id, name FROM app_migration ORDER BY id');
    assert.deepEqual(
      applied.map((m) => [m.id, m.name]),
      [
        [1, 'initial'],
        [2, 'routines'],
        [3, 'titled-rules-sets'],
        [4, 'connection_roles'],
        [6, 'review-comments'],
      ],
    );
  });

  it('in warning mode, a write without a confirmed list succeeds, warns, and records connection, role and owner_role', async () => {
    const settings = await owner.json<{ role_enforcement: string }>('/api/owner/connections');
    assert.equal(settings.role_enforcement, 'warn');
    const task = await call<{ id: string; warnings?: Warning[] }>(agent, 'save_task', { title: 'Lead task', role: 'lead', claimed_role: 'lead' });
    assert.ok(task.warnings?.some((w) => w.code === 'role_not_allowed'), 'expected a not-on-list warning');
    const ev = get<{ claimed_role: string; connection_id: string; connection_name: string; data: string }>(
      env.svc.db,
      "SELECT claimed_role, connection_id, connection_name, data FROM event WHERE action = 'task.created' AND summary LIKE '%Lead task%' ORDER BY id DESC LIMIT 1",
    )!;
    assert.equal(ev.claimed_role, 'lead');
    assert.equal(ev.connection_id, clientId);
    assert.equal(ev.connection_name, 'Grok');
    assert.equal(JSON.parse(ev.data).owner_role, 'lead');
  });

  it('prefills a draft list from this connection\'s history only, unconfirmed', async () => {
    const other = (await connectAgent(env, owner, 'Other platform')).client;
    await call(other, 'save_task', { title: 'Other intern task', role: 'intern', claimed_role: 'intern' });
    const list = await owner.json<{
      connections: {
        client_id: string;
        name: string;
        roles: { slug: string; source: string }[];
        roles_confirmed: boolean;
        roles_suggested_at: string | null;
      }[];
    }>('/api/owner/connections');
    const grok = list.connections.find((c) => c.client_id === clientId)!;
    const otherConn = list.connections.find((c) => c.name === 'Other platform')!;
    assert.equal(grok.roles_confirmed, false);
    assert.deepEqual(grok.roles.map((r) => r.slug).sort(), ['lead']);
    assert.ok(grok.roles.every((r) => r.source === 'suggested'));
    assert.ok(!grok.roles.some((r) => r.slug === 'intern'), 'prefill must not include roles only seen on another connection');
    assert.deepEqual(otherConn.roles.map((r) => r.slug).sort(), ['intern']);
    assert.equal(grok.roles_suggested_at, null, 'GET must not persist the suggestion');
    assert.equal(otherConn.roles_suggested_at, null, 'GET must not persist the suggestion');
    assert.equal(get(env.svc.db, 'SELECT 1 FROM connection_role WHERE client_id = ?', clientId), undefined);
    assert.equal(get(env.svc.db, 'SELECT 1 FROM connection_role WHERE client_id = ?', otherConn.client_id), undefined);
    otherClientId = otherConn.client_id;
  });


  it('logs saving an already-empty unconfirmed connection role list', async () => {
    const before = get<{ n: number }>(
      env.svc.db,
      "SELECT count(*) AS n FROM event WHERE action = 'connection.roles_updated' AND entity_id = ?",
      otherClientId,
    )!.n;
    await owner.json(`/api/owner/connections/${encodeURIComponent(otherClientId)}/roles`, { json: { roles: [], confirm: false } });
    const ev = get<{ actor_kind: string; data: string }>(
      env.svc.db,
      "SELECT actor_kind, data FROM event WHERE action = 'connection.roles_updated' AND entity_id = ? ORDER BY id DESC LIMIT 1",
      otherClientId,
    )!;
    assert.equal(ev.actor_kind, 'owner');
    const data = JSON.parse(ev.data) as { role_ids: string[]; confirmed: boolean };
    assert.equal(data.confirmed, false);
    assert.deepEqual(data.role_ids, []);
    assert.equal(
      get<{ n: number }>(env.svc.db, "SELECT count(*) AS n FROM event WHERE action = 'connection.roles_updated' AND entity_id = ?", otherClientId)!.n,
      before + 1,
    );
    const other = (
      await owner.json<{ connections: { client_id: string; roles_confirmed: boolean; roles_suggested_at: string | null }[] }>('/api/owner/connections')
    ).connections.find((c) => c.client_id === otherClientId)!;
    assert.equal(other.roles_confirmed, false);
    assert.ok(other.roles_suggested_at, 'saving an empty draft still locks it');
  });

  it('logs saving a connection role list without confirming it', async () => {
    await owner.json(`/api/owner/connections/${encodeURIComponent(clientId)}/roles`, { json: { roles: ['lead'], confirm: false } });
    const ev = get<{ actor_kind: string; data: string }>(
      env.svc.db,
      "SELECT actor_kind, data FROM event WHERE action = 'connection.roles_updated' AND entity_id = ? ORDER BY id DESC LIMIT 1",
      clientId,
    )!;
    assert.equal(ev.actor_kind, 'owner');
    const data = JSON.parse(ev.data) as { role_ids: string[]; confirmed: boolean };
    assert.equal(data.confirmed, false);
    assert.deepEqual(data.role_ids, [leadId]);
    const grok = (
      await owner.json<{ connections: { client_id: string; roles_confirmed: boolean; roles_suggested_at: string | null }[] }>('/api/owner/connections')
    ).connections.find((c) => c.client_id === clientId)!;
    assert.equal(grok.roles_confirmed, false);
    assert.ok(grok.roles_suggested_at, 'saving a draft locks it so a later prefill cannot add removed roles');
  });

  it('refuses to turn on enforcement while an active connection has no confirmed list, unless the owner overrides', async () => {
    const blocked = await owner.fetch('/api/owner/settings/role-enforcement', { json: { mode: 'enforce' } });
    assert.equal(blocked.status, 400);
    const body = (await blocked.json()) as { error: string; unconfirmed?: { name: string }[] };
    assert.equal(body.error, 'invalid');
    assert.ok(body.unconfirmed && body.unconfirmed.length >= 1);

    const ok = await owner.json<{ role_enforcement: string; override: boolean }>('/api/owner/settings/role-enforcement', {
      json: { mode: 'enforce', override: true },
    });
    assert.equal(ok.role_enforcement, 'enforce');
    assert.equal(ok.override, true);
    const ev = get<{ data: string; actor_kind: string }>(
      env.svc.db,
      "SELECT data, actor_kind FROM event WHERE action = 'settings.role_enforcement' ORDER BY id DESC LIMIT 1",
    )!;
    assert.equal(ev.actor_kind, 'owner');
    const data = JSON.parse(ev.data) as { mode: string; override: boolean };
    assert.equal(data.mode, 'enforce');
    assert.equal(data.override, true);
  });

  it('gives a draft (unconfirmed) list no effect in enforce', async () => {
    await assert.rejects(() => call(agent, 'save_task', { title: 'Should fail', role: 'lead', claimed_role: 'lead' }), (e: unknown) => {
      const b = err(e);
      assert.equal(b.error, 'forbidden');
      assert.match(b.message, /confirmed allow-list|no effect/i);
      return true;
    });
    assert.equal(
      get(env.svc.db, "SELECT 1 FROM event WHERE action = 'task.created' AND summary LIKE '%Should fail%'"),
      undefined,
    );
    await assert.rejects(() => call(agent, 'start', { role: 'lead' }), (e: unknown) => {
      assert.equal(err(e).error, 'forbidden');
      return true;
    });
  });

  it('after the list is confirmed, the allowed role can write and a role off the list cannot', async () => {
    await owner.json(`/api/owner/connections/${encodeURIComponent(clientId)}/roles`, { json: { roles: ['lead'], confirm: true } });
    const task = await call<{ id: string; warnings?: Warning[] }>(agent, 'save_task', { title: 'Allowed lead task', role: 'lead', claimed_role: 'lead' });
    assert.ok(!task.warnings?.some((w) => w.code === 'role_not_allowed'));
    await assert.rejects(() => call(agent, 'save_task', { title: 'Intern off list', role: 'intern', claimed_role: 'intern' }), (e: unknown) => {
      assert.equal(err(e).error, 'forbidden');
      return true;
    });
    await assert.rejects(() => call(agent, 'save_routine', { name: 'Intern daily', role: 'intern', schedule: 'every day', claimed_role: 'intern' }), (e: unknown) => {
      assert.equal(err(e).error, 'forbidden');
      return true;
    });
  });

  it('two roles on one connection sign as themselves; editing another role\'s item needs edit_any', async () => {
    await owner.json(`/api/owner/connections/${encodeURIComponent(clientId)}/roles`, { json: { roles: ['lead', 'intern'], confirm: true } });
    const leadTask = await call<{ id: string; rev: number }>(agent, 'save_task', { title: 'Owned by lead', role: 'lead', claimed_role: 'lead' });
    const internTask = await call<{ id: string; rev: number }>(agent, 'save_task', { title: 'Owned by intern', role: 'intern', claimed_role: 'intern' });
    const asLead = get<{ claimed_role: string }>(env.svc.db, "SELECT claimed_role FROM event WHERE summary LIKE '%Owned by lead%' AND action = 'task.created' ORDER BY id DESC LIMIT 1")!;
    const asIntern = get<{ claimed_role: string }>(env.svc.db, "SELECT claimed_role FROM event WHERE summary LIKE '%Owned by intern%' AND action = 'task.created' ORDER BY id DESC LIMIT 1")!;
    assert.equal(asLead.claimed_role, 'lead');
    assert.equal(asIntern.claimed_role, 'intern');

    await assert.rejects(
      () => call(agent, 'save_task', { id: leadTask.id, rev: leadTask.rev, result: 'intern tried', claimed_role: 'intern' }),
      (e: unknown) => {
        assert.equal(err(e).error, 'forbidden');
        assert.match(err(e).message, /belongs to role "lead"/);
        return true;
      },
    );

    const routine = await call<{ id: string; rev: number }>(agent, 'save_routine', { name: 'Lead morning', role: 'lead', schedule: 'weekdays 9am', claimed_role: 'lead' });
    await assert.rejects(
      () => call(agent, 'save_routine', { id: routine.id, rev: routine.rev, status: 'paused', claimed_role: 'intern' }),
      (e: unknown) => {
        assert.equal(err(e).error, 'forbidden');
        return true;
      },
    );

    // MCP cannot grant edit_any (the field is stripped by the tool schema and rejected in the domain).
    const roleBefore = await call<{ edit_any: boolean; rev: number }>(agent, 'get', { type: 'role', id: leadId });
    assert.equal(roleBefore.edit_any, false);
    await call(agent, 'save_role', { id: leadId, rev: roleBefore.rev, area: 'still lead', claimed_role: 'lead', edit_any: true });
    const roleAfterMcp = await call<{ edit_any: boolean; rev: number }>(agent, 'get', { type: 'role', id: leadId });
    assert.equal(roleAfterMcp.edit_any, false);

    const agentActor: Actor = { kind: 'agent', memberId, connectionId: clientId, connectionName: 'Grok', role: 'lead' };
    assert.throws(
      () => saveRole(env.svc.db, agentActor, { id: leadId, rev: roleAfterMcp.rev, edit_any: true }),
      (e: unknown) => e instanceof DomainError && e.code === 'invalid' && /edit_any can only be set by the owner/.test(e.message),
    );

    await owner.json(`/api/owner/roles/${encodeURIComponent(leadId)}/edit-any`, { json: { edit_any: true } });
    const edited = await call<{ result: string }>(agent, 'save_task', { id: internTask.id, rev: internTask.rev, result: 'lead helped', claimed_role: 'lead' });
    assert.equal(edited.result, 'lead helped');
    const ev = get<{ claimed_role: string; data: string }>(
      env.svc.db,
      "SELECT claimed_role, data FROM event WHERE action = 'task.updated' AND summary LIKE '%Owned by intern%' ORDER BY id DESC LIMIT 1",
    )!;
    assert.equal(ev.claimed_role, 'lead');
    assert.equal(JSON.parse(ev.data).owner_role, 'intern');
  });

  it('lets only a role marked edit_any (or the owner) change a rules set', async () => {
    await owner.json(`/api/owner/connections/${encodeURIComponent(clientId)}/roles`, { json: { roles: ['lead', 'intern'], confirm: true } });
    await assert.rejects(
      () => call(agent, 'update_rules', { text: 'Intern must not change rules.', claimed_role: 'intern' }),
      (e: unknown) => {
        assert.equal(err(e).error, 'forbidden');
        assert.match(err(e).message, /working rules|edit any item/i);
        return true;
      },
    );
    await assert.rejects(
      () => call(agent, 'update_rules', { slug: 'test-rules', text: 'A second set.', title: 'Test rules', claimed_role: 'intern' }),
      (e: unknown) => {
        assert.equal(err(e).error, 'forbidden');
        return true;
      },
    );
    const updated = await call<{ text: string }>(agent, 'update_rules', { text: 'Lead may change the working rules.', claimed_role: 'lead' });
    assert.match(updated.text, /Lead may change/);
    const created = await call<{ slug: string; is_default: boolean }>(agent, 'update_rules', { slug: 'lead-extra', text: 'Extra set.', title: 'Lead extra', claimed_role: 'lead' });
    assert.equal(created.slug, 'lead-extra');
    assert.equal(created.is_default, false);
  });

  it('rejects a missing claimed_role in enforce, and treats the old role argument as a deprecated synonym in warn', async () => {
    await assert.rejects(() => call(agent, 'save_task', { title: 'No author' }), (e: unknown) => {
      assert.equal(err(e).error, 'invalid');
      assert.match(err(e).message, /claimed_role is required/);
      return true;
    });

    await owner.json('/api/owner/settings/role-enforcement', { json: { mode: 'warn' } });
    const claimed = await call<{ id: string; status: string; warnings?: Warning[] }>(agent, 'save_task', { title: 'To claim', role: 'lead', claimed_role: 'lead' });
    const out = await call<{ status: string; warnings?: Warning[] }>(agent, 'claim_task', { id: claimed.id, role: 'lead' });
    assert.equal(out.status, 'in_progress');
    const syn = out.warnings?.find((w) => w.code === 'role_synonym_deprecated');
    assert.ok(syn, 'expected a deprecation warning');
    assert.match(syn!.message, /deprecated/);
    assert.match(syn!.message, /will be removed/);
  });

  it('in warning mode, claim_task with an unknown claimed_role and no role proceeds with a warning', async () => {
    await owner.json('/api/owner/settings/role-enforcement', { json: { mode: 'warn' } });
    const task = await call<{ id: string }>(agent, 'save_task', { title: 'Claim with unknown role', role: 'lead', claimed_role: 'lead' });
    const out = await call<{ id: string; status: string; claimed_by: { role: string | null } | null; warnings?: Warning[] }>(
      agent,
      'claim_task',
      { id: task.id, claimed_role: 'no-such-role' },
    );
    assert.equal(out.status, 'in_progress');
    assert.ok(out.warnings?.some((w) => w.code === 'role_not_found'), 'expected a role_not_found warning');
    assert.equal(out.claimed_by?.role, 'no-such-role');
  });


  it('in enforce mode, claim_task with an unknown claimed_role and no role is forbidden', async () => {
    await owner.json(`/api/owner/connections/${encodeURIComponent(clientId)}/roles`, { json: { roles: ['lead'], confirm: true } });
    if (otherClientId) {
      await owner.json(`/api/owner/connections/${encodeURIComponent(otherClientId)}/roles`, { json: { roles: ['intern'], confirm: true } });
    }
    await owner.json('/api/owner/settings/role-enforcement', { json: { mode: 'enforce' } });
    try {
      const task = await call<{ id: string }>(agent, 'save_task', { title: 'Claim unknown in enforce', role: 'lead', claimed_role: 'lead' });
      await assert.rejects(() => call(agent, 'claim_task', { id: task.id, claimed_role: 'no-such-role' }), (e: unknown) => {
        assert.equal(err(e).error, 'forbidden');
        assert.match(err(e).message, /role not found: no-such-role/);
        return true;
      });
    } finally {
      await owner.json('/api/owner/settings/role-enforcement', { json: { mode: 'warn' } });
    }
  });

  it('lets the owner write as before, and a role removed from the list is refused in enforce', async () => {
    const created = await owner.json<{ id: string; title: string }>('/api/owner/tasks', { json: { title: 'Owner task', role: 'lead' } });
    assert.equal(created.title, 'Owner task');

    await owner.json(`/api/owner/connections/${encodeURIComponent(clientId)}/roles`, { json: { roles: ['intern'], confirm: true } });
    // The second connection from the prefill test is still unconfirmed; confirm it so enforce can be turned on without an override.
    await owner.json(`/api/owner/connections/${encodeURIComponent(otherClientId)}/roles`, { json: { roles: ['intern'], confirm: true } });
    await owner.json('/api/owner/settings/role-enforcement', { json: { mode: 'enforce' } });
    await assert.rejects(() => call(agent, 'save_task', { title: 'Lead after removal', role: 'lead', claimed_role: 'lead' }), (e: unknown) => {
      assert.equal(err(e).error, 'forbidden');
      return true;
    });
  });

  it('clears a purged role from allow-lists', async () => {
    const extra = await owner.json<{ id: string; slug: string }>('/api/owner/roles', { json: { name: 'Temp', slug: 'temp' } });
    await owner.json(`/api/owner/connections/${encodeURIComponent(clientId)}/roles`, { json: { roles: ['intern', 'temp'], confirm: true } });
    await owner.json('/api/owner/archive', { json: { type: 'role', id: extra.id } });
    await owner.json('/api/owner/purge', { json: { type: 'role', id: extra.id } });
    const list = await owner.json<{ connections: { client_id: string; roles: { slug: string }[] }[] }>('/api/owner/connections');
    const grok = list.connections.find((c) => c.client_id === clientId)!;
    assert.ok(!grok.roles.some((r) => r.slug === 'temp'));
  });
});
