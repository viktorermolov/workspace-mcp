import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { get } from '../src/db/db.ts';
import { call, connectAgent, registerOwner, startService, type Browser, type TestEnv } from './helpers/harness.ts';

// #181: a task of a role that several agents may take must name its agent (or "*" for any of them).

const confirmRoles = (owner: Browser, clientId: string, roles: string[]) =>
  owner.json(`/api/owner/connections/${encodeURIComponent(clientId)}/roles`, { json: { roles, confirm: true } });

type Task = { id: string; rev: number; status: string; result: string; role: string | null; for_agent: string | null };
type Err = { error: string; message: string; role?: string; candidates?: string[] };

const errOf = (e: unknown) => JSON.parse((e as Error).message) as Err;
const devRefusal = (verb: 'created' | 'changed') =>
  `role "developer" has more than one agent (ada, hal); pass for_agent with one of these slugs, or for_agent "*" for any of them. Nothing was ${verb}.`;

describe('for_agent is required for a role with several agents (#181)', () => {
  let env: TestEnv;
  let owner: Browser;
  let grok: Awaited<ReturnType<typeof connectAgent>>['client'];
  let home: Awaited<ReturnType<typeof connectAgent>>['client'];
  /** A connector whose tool list predates agents: it passes neither agent nor for_agent. */
  let legacy: Awaited<ReturnType<typeof connectAgent>>['client'];
  let homeId: string;
  let oldId: string;

  const row = (id: string) =>
    get<{ rev: number; status: string; result: string; role_id: string | null; agent_id: string | null; updated_at: string }>(
      env.svc.db,
      'SELECT rev, status, result, role_id, agent_id, updated_at FROM task WHERE id = ?',
      id,
    )!;
  const count = (title: string) => get<{ n: number }>(env.svc.db, 'SELECT count(*) AS n FROM task WHERE title = ?', title)!.n;
  const asCora = (args: Record<string, unknown>) => call<Task>(grok, 'save_task', { ...args, claimed_role: 'coordinator', agent: 'cora' });

  /** A create that must be refused: the error matches and no row was written. */
  async function refusedCreate(make: () => Promise<unknown>, title: string, message: string | RegExp) {
    await assert.rejects(make, (e) => {
      const x = errOf(e);
      assert.equal(x.error, 'invalid');
      if (typeof message === 'string') assert.equal(x.message, message);
      else assert.match(x.message, message);
      assert.doesNotMatch((e as Error).message, /reconnect/i);
      return true;
    });
    assert.equal(count(title), 0, `a task "${title}" was created`);
  }

  /** An update that must be refused: the error matches and the row, including rev, is unchanged. */
  async function refusedUpdate(make: () => Promise<unknown>, id: string, message: string | RegExp, code = 'invalid') {
    const before = row(id);
    await assert.rejects(make, (e) => {
      const x = errOf(e);
      assert.equal(x.error, code);
      if (typeof message === 'string') assert.equal(x.message, message);
      else assert.match(x.message, message);
      assert.doesNotMatch((e as Error).message, /reconnect/i);
      return true;
    });
    assert.deepEqual(row(id), before, 'the task changed after a refusal');
  }

  before(async () => {
    env = await startService();
    owner = (await registerOwner(env)).browser;
    for (const [name, slug] of [
      ['Coordinator', 'coordinator'],
      ['Developer', 'developer'],
      ['Designer', 'designer'],
      ['Writer', 'writer'],
      ['QA', 'qa'],
      ['Ops', 'ops'],
    ]) {
      await owner.json('/api/owner/roles', { json: { name, slug } });
    }
    grok = (await connectAgent(env, owner, 'Grok')).client;
    home = (await connectAgent(env, owner, 'Home server')).client;
    await connectAgent(env, owner, 'Old platform');
    legacy = (await connectAgent(env, owner, 'Legacy client')).client;
    const list = await owner.json<{ connections: { client_id: string; name: string }[] }>('/api/owner/connections');
    const id = (n: string) => list.connections.find((c) => c.name === n)!.client_id;
    homeId = id('Home server');
    oldId = id('Old platform');
    await confirmRoles(owner, id('Grok'), ['coordinator', 'developer', 'designer', 'qa', 'ops']);
    await confirmRoles(owner, homeId, ['developer', 'ops']);
    await confirmRoles(owner, oldId, ['qa']);
    await confirmRoles(owner, id('Legacy client'), ['developer', 'designer', 'writer']);
    const agent = (name: string, platform: string, roles: string[]) => owner.json('/api/owner/agents', { json: { name, platform, roles } });
    await agent('Cora', id('Grok'), ['coordinator']);
    await agent('Ada', id('Grok'), ['developer']);
    await agent('Hal', homeId, ['developer']);
    await agent('Dee', id('Grok'), ['designer']);
    await agent('Quinn', id('Grok'), ['qa']);
    await agent('Rex', oldId, ['qa']);
    await owner.json(`/api/owner/connections/${encodeURIComponent(oldId)}/revoke`, { json: {} });
    await owner.json('/api/owner/roles/coordinator/routes-tasks', { json: { routes_tasks: true } });
  });

  after(async () => {
    await env.close();
  });

  it('1. creating a task of a role with 2+ agents without for_agent is refused, lists the agents, and creates nothing', async () => {
    await refusedCreate(() => asCora({ title: 'No agent 1', role: 'developer' }), 'No agent 1', devRefusal('created'));
    await assert.rejects(asCora({ title: 'No agent 1', role: 'developer' }), (e) => {
      assert.deepEqual({ role: errOf(e).role, candidates: errOf(e).candidates }, { role: 'developer', candidates: ['ada', 'hal'] });
      return true;
    });
    for (const none of [null, '', '  ']) {
      await refusedCreate(() => asCora({ title: 'No agent 1b', role: 'developer', for_agent: none }), 'No agent 1b', devRefusal('created'));
    }
  });

  it('2. the same call with an agent of the role succeeds', async () => {
    const t = await asCora({ title: 'For Hal 2', role: 'developer', for_agent: 'hal' });
    assert.equal(t.for_agent, 'hal');
  });

  it('3. an unknown agent or one that cannot take the role is refused, as before', async () => {
    await refusedCreate(() => asCora({ title: 'Bad 3', role: 'developer', for_agent: 'nobody' }), 'Bad 3', /agent not found: nobody/);
    await refusedCreate(() => asCora({ title: 'Bad 3', role: 'developer', for_agent: 'dee' }), 'Bad 3', /agent "dee" may not take the role "developer"/);
  });

  it('4. a role with one agent is addressed to that agent when for_agent is left out', async () => {
    assert.equal((await asCora({ title: 'Design 4', role: 'designer' })).for_agent, 'dee');
    assert.equal((await asCora({ title: 'Design 4b', role: 'designer', for_agent: null })).for_agent, 'dee');
  });

  it('5. a role with no agents, or no role at all, stays unaddressed as before', async () => {
    assert.equal((await asCora({ title: 'Write 5', role: 'writer' })).for_agent, null);
    assert.equal((await asCora({ title: 'Loose 5' })).for_agent, null);
  });

  it('6. for_agent "*" is the explicit "any agent of the role"; without a role it is refused', async () => {
    const t = await asCora({ title: 'Any dev 6', role: 'developer', for_agent: '*' });
    assert.equal(t.for_agent, null);
    // Any agent of the role may claim it.
    await call(home, 'claim_task', { id: t.id, claimed_role: 'developer', agent: 'hal' });
    await refusedCreate(() => asCora({ title: 'Star 6', for_agent: '*' }), 'Star 6', 'for_agent "*" means any agent with the task\'s role, and this task has no role: pass role as well, or name an agent');
    const loose = await asCora({ title: 'Loose 6' });
    await refusedUpdate(() => asCora({ id: loose.id, rev: loose.rev, for_agent: '*' }), loose.id, /for_agent "\*" means any agent with the task's role, and this task has no role/);
  });

  it('7. moving a task to a role with 2+ agents without for_agent is refused and nothing changes', async () => {
    const t = await asCora({ title: 'Move 7', role: 'writer' });
    const ownerSave = async (json: Record<string, unknown>) => {
      const res = await owner.fetch('/api/owner/tasks', { json });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    };
    await refusedUpdate(() => ownerSave({ id: t.id, rev: t.rev, role: 'developer' }), t.id, devRefusal('changed'));
    const moved = await owner.json<Task>('/api/owner/tasks', { json: { id: t.id, rev: t.rev, role: 'developer', for_agent: 'ada' } });
    assert.deepEqual([moved.role, moved.for_agent], ['developer', 'ada']);
  });

  it('8. moving a task to a role with one agent addresses it to that agent', async () => {
    const t = await asCora({ title: 'Move 8', role: 'writer' });
    const moved = await owner.json<Task>('/api/owner/tasks', { json: { id: t.id, rev: t.rev, role: 'designer' } });
    assert.deepEqual([moved.role, moved.for_agent], ['designer', 'dee']);
  });

  it('9. other edits of an unaddressed task of a role with 2+ agents are not re-checked, from MCP or the task form', async () => {
    const t = await asCora({ title: 'Old any 9', role: 'developer', for_agent: '*' });
    const byAda = await call<Task>(grok, 'save_task', { id: t.id, rev: t.rev, status: 'in_progress', result: 'started', claimed_role: 'developer', agent: 'ada' });
    assert.deepEqual([byAda.status, byAda.result, byAda.for_agent], ['in_progress', 'started', null]);
    // The task form sends role and for_agent: null with every save; unchanged, they are not a change of address.
    const form = await owner.json<Task>('/api/owner/tasks', { json: { id: t.id, rev: byAda.rev, title: 'Old any 9', status: 'blocked', blocking_reason: 'wait', role: 'developer', for_agent: null } });
    assert.deepEqual([form.status, form.for_agent], ['blocked', null]);
  });

  it('10. a coordinator routing a task of a role with 2+ agents must pass an agent or "*", and still changes nothing else (#180)', async () => {
    const t = await asCora({ title: 'Route 10', role: 'developer', for_agent: 'ada' });
    for (const none of [null, '']) {
      await refusedUpdate(() => asCora({ id: t.id, rev: t.rev, for_agent: none }), t.id, devRefusal('changed'));
    }
    const toHal = await asCora({ id: t.id, rev: t.rev, for_agent: 'hal' });
    assert.equal(toHal.for_agent, 'hal');
    const anyone = await asCora({ id: t.id, rev: toHal.rev, for_agent: '*' });
    assert.equal(anyone.for_agent, null);
    const back = await asCora({ id: t.id, rev: anyone.rev, for_agent: 'hal' });
    // The permission check of #180 runs first: routing is all a coordinator may do.
    await refusedUpdate(() => asCora({ id: t.id, rev: back.rev, status: 'done' }), t.id, /addressed to agent "hal"/, 'conflict');
  });

  it('11. a role that gains a second agent keeps its old unaddressed tasks; new ones must name an agent', async () => {
    const before0 = await asCora({ title: 'Ops 11 none', role: 'ops' });
    assert.equal(before0.for_agent, null);
    await owner.json('/api/owner/agents', { json: { name: 'Olga', platform: homeId, roles: ['ops'] } });
    const one = await asCora({ title: 'Ops 11 one', role: 'ops' });
    assert.equal(one.for_agent, 'olga');
    const anyOps = await asCora({ title: 'Ops 11 any', role: 'ops', for_agent: '*' });
    const snapshot = [row(before0.id), row(anyOps.id)];
    const grokId = (await owner.json<{ connections: { client_id: string; name: string }[] }>('/api/owner/connections')).connections.find((c) => c.name === 'Grok')!.client_id;
    await owner.json('/api/owner/agents', { json: { name: 'Otto', platform: grokId, roles: ['ops'] } });
    assert.deepEqual([row(before0.id), row(anyOps.id)], snapshot, 'adding an agent rewrote existing tasks');
    await refusedCreate(
      () => asCora({ title: 'Ops 11 new', role: 'ops' }),
      'Ops 11 new',
      'role "ops" has more than one agent (olga, otto); pass for_agent with one of these slugs, or for_agent "*" for any of them. Nothing was created.',
    );
    const edited = await call<Task>(home, 'save_task', { id: before0.id, rev: before0.rev, status: 'in_progress', claimed_role: 'ops', agent: 'olga' });
    assert.deepEqual([edited.status, edited.for_agent], ['in_progress', null]);
  });

  it('12. an agent on a revoked platform is not counted', async () => {
    const t = await asCora({ title: 'QA 12', role: 'qa' });
    assert.equal(t.for_agent, 'quinn');
  });

  it('13. a connector without for_agent in its tools keeps working: one agent auto-addresses, several are refused with the same error', async () => {
    const tools = await legacy.listTools();
    assert.ok(tools.tools.some((t) => t.name === 'save_task'));
    const one = await call<Task>(legacy, 'save_task', { title: 'Legacy design', role: 'designer', claimed_role: 'designer' });
    assert.equal(one.for_agent, 'dee');
    await refusedCreate(() => call(legacy, 'save_task', { title: 'Legacy dev', role: 'developer', claimed_role: 'developer' }), 'Legacy dev', devRefusal('created'));
    await refusedCreate(() => call(legacy, 'save_task', { title: 'Legacy dev', role: 'developer', for_agent: '', claimed_role: 'developer' }), 'Legacy dev', devRefusal('created'));
    const none = await call<Task>(legacy, 'save_task', { title: 'Legacy write', role: 'writer', claimed_role: 'writer' });
    assert.equal(none.for_agent, null);
  });

  it('14. the owner task form is held to the same rule', async () => {
    const res = await owner.fetch('/api/owner/tasks', { json: { title: 'Form 14', role: 'developer', for_agent: null } });
    assert.equal(res.status, 400);
    const body = (await res.json()) as Err;
    assert.equal(body.message, devRefusal('created'));
    assert.equal(count('Form 14'), 0);
    const ok = await owner.json<Task>('/api/owner/tasks', { json: { title: 'Form 14', role: 'developer', for_agent: '*' } });
    assert.equal(ok.for_agent, null);
  });
});
