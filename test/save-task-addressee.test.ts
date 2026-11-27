import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { get } from '../src/db/db.ts';
import { call, connectAgent, registerOwner, startService, type Browser, type TestEnv } from './helpers/harness.ts';

const confirmRoles = (owner: Browser, clientId: string, roles: string[]) =>
  owner.json(`/api/owner/connections/${encodeURIComponent(clientId)}/roles`, { json: { roles, confirm: true } });

const err = (e: unknown) => JSON.parse((e as Error).message) as { error: string; message: string };

type Task = {
  id: string;
  rev: number;
  title: string;
  status: string;
  result: string;
  blocking_reason: string;
  for_agent: string | null;
  claimed_by: { agent?: string } | null;
  warnings?: { code: string; message: string }[];
};

describe('save_task respects the addressee and the claimed agent', () => {
  let env: TestEnv;
  let owner: Browser;
  let grok: Awaited<ReturnType<typeof connectAgent>>['client'];
  let home: Awaited<ReturnType<typeof connectAgent>>['client'];
  let grokId: string;
  let homeId: string;

  const setMode = (mode: 'warn' | 'enforce') =>
    owner.json('/api/owner/settings/role-enforcement', { json: mode === 'enforce' ? { mode, override: true } : { mode } });

  async function addressed(title: string): Promise<Task> {
    return call<Task>(grok, 'save_task', { title, role: 'developer', for_agent: 'ada', claimed_role: 'developer', agent: 'ada' });
  }

  before(async () => {
    env = await startService();
    owner = (await registerOwner(env)).browser;
    await owner.json('/api/owner/roles', { json: { name: 'Developer', slug: 'developer' } });
    await owner.json('/api/owner/roles', { json: { name: 'Coordinator', slug: 'coordinator' } });
    grok = (await connectAgent(env, owner, 'Grok')).client;
    home = (await connectAgent(env, owner, 'Home server')).client;
    const list = await owner.json<{ connections: { client_id: string; name: string }[] }>('/api/owner/connections');
    grokId = list.connections.find((c) => c.name === 'Grok')!.client_id;
    homeId = list.connections.find((c) => c.name === 'Home server')!.client_id;
    await confirmRoles(owner, grokId, ['developer', 'coordinator']);
    await confirmRoles(owner, homeId, ['developer']);
    await owner.json('/api/owner/agents', { json: { name: 'Ada', platform: grokId, roles: ['developer'] } });
    await owner.json('/api/owner/agents', { json: { name: 'Hal', platform: homeId, roles: ['developer'] } });
    await owner.json('/api/owner/agents', { json: { name: 'Mia', platform: grokId, roles: ['coordinator', 'developer'] } });
    await owner.json('/api/owner/roles/coordinator/routes-tasks', { json: { routes_tasks: true } });
  });

  after(async () => {
    await env.close();
  });

  it('in enforce mode a second agent with the same role is refused for status, result, blocking reason, reopen and re-address to itself; the task and its rev stay the same', async () => {
    await setMode('enforce');
    const t = await addressed('Enforce Guard');
    const snapshot = () => get<Task>(env.svc.db, 'SELECT status, result, blocking_reason, rev, agent_id FROM task WHERE id = ?', t.id)!;

    const attempts: Record<string, unknown>[] = [
      { status: 'in_progress' },
      { result: 'Hal did this' },
      { status: 'blocked', blocking_reason: 'waiting' },
      { for_agent: 'hal' },
    ];
    for (const patch of attempts) {
      const before = snapshot();
      await assert.rejects(
        call(home, 'save_task', { id: t.id, rev: t.rev, ...patch, claimed_role: 'developer', agent: 'hal' }),
        (e) => err(e).error === 'conflict' && /addressed to agent "ada"/.test(err(e).message),
      );
      const after = snapshot();
      assert.deepEqual(after, before, `task changed on ${JSON.stringify(patch)}`);
      assert.equal(after.rev, t.rev);
    }

    await call<Task>(grok, 'save_task', { id: t.id, rev: t.rev, status: 'done', claimed_role: 'developer', agent: 'ada' });
    const done = snapshot();
    await assert.rejects(
      call(home, 'save_task', { id: t.id, rev: done.rev, status: 'open', claimed_role: 'developer', agent: 'hal' }),
      (e) => err(e).error === 'conflict' && /addressed to agent "ada"/.test(err(e).message),
    );
    assert.equal(snapshot().status, 'done');
    assert.equal(snapshot().rev, done.rev);
    const rejected = get<{ n: number }>(
      env.svc.db,
      "SELECT count(*) AS n FROM oauth_diag WHERE step = 'role_check' AND outcome = 'rejected' AND detail LIKE '%task_addressed%'",
    )!;
    assert.ok(rejected.n >= 1);
  });

  it('the addressee can change status, result, blocking reason, reopen, and address the task to itself', async () => {
    await setMode('enforce');
    const t = await addressed('Ada Own');
    const progressed = await call<Task>(grok, 'save_task', { id: t.id, rev: t.rev, status: 'in_progress', claimed_role: 'developer', agent: 'ada' });
    assert.equal(progressed.status, 'in_progress');
    const withResult = await call<Task>(grok, 'save_task', { id: progressed.id, rev: progressed.rev, result: 'Ada did this', claimed_role: 'developer', agent: 'ada' });
    assert.equal(withResult.result, 'Ada did this');
    const blocked = await call<Task>(grok, 'save_task', {
      id: withResult.id,
      rev: withResult.rev,
      status: 'blocked',
      blocking_reason: 'needs a review',
      claimed_role: 'developer',
      agent: 'ada',
    });
    assert.equal(blocked.status, 'blocked');
    assert.equal(blocked.blocking_reason, 'needs a review');
    const done = await call<Task>(grok, 'save_task', { id: blocked.id, rev: blocked.rev, status: 'done', claimed_role: 'developer', agent: 'ada' });
    const reopened = await call<Task>(grok, 'save_task', { id: done.id, rev: done.rev, status: 'open', claimed_role: 'developer', agent: 'ada' });
    assert.equal(reopened.status, 'open');
    const toSelf = await call<Task>(grok, 'save_task', { id: reopened.id, rev: reopened.rev, for_agent: 'ada', claimed_role: 'developer', agent: 'ada' });
    assert.equal(toSelf.for_agent, 'ada');
  });

  it('a coordinator can re-address the task, but cannot change its status or result', async () => {
    await setMode('enforce');
    const t = await addressed('Coordinator Route');
    const routed = await call<Task>(grok, 'save_task', { id: t.id, rev: t.rev, for_agent: 'hal', claimed_role: 'coordinator', agent: 'mia' });
    assert.equal(routed.for_agent, 'hal');
    const row = () => get<{ status: string; result: string; rev: number }>(env.svc.db, 'SELECT status, result, rev FROM task WHERE id = ?', routed.id)!;

    // Forbidden-first: acting as coordinator is refused by the role check.
    const beforeForbidden = row();
    await assert.rejects(
      call(grok, 'save_task', { id: routed.id, rev: routed.rev, status: 'done', claimed_role: 'coordinator', agent: 'mia' }),
      (e) => err(e).error === 'forbidden' && /belongs to role "developer"/.test(err(e).message),
    );
    assert.deepEqual(row(), beforeForbidden);
    await assert.rejects(
      call(grok, 'save_task', { id: routed.id, rev: routed.rev, result: 'Mia wrote this', claimed_role: 'coordinator', agent: 'mia' }),
      (e) => err(e).error === 'forbidden' && /belongs to role "developer"/.test(err(e).message),
    );
    assert.deepEqual(row(), beforeForbidden);
    assert.equal(row().rev, routed.rev);

    // Conflict: even when the coordinator also takes the task's role, the addressee check refuses.
    const beforeConflict = row();
    await assert.rejects(
      call(grok, 'save_task', { id: routed.id, rev: routed.rev, status: 'done', claimed_role: 'developer', agent: 'mia' }),
      (e) => err(e).error === 'conflict' && /addressed to agent "hal"/.test(err(e).message),
    );
    assert.deepEqual(row(), beforeConflict);
    await assert.rejects(
      call(grok, 'save_task', { id: routed.id, rev: routed.rev, result: 'Mia wrote this', claimed_role: 'developer', agent: 'mia' }),
      (e) => err(e).error === 'conflict' && /addressed to agent "hal"/.test(err(e).message),
    );
    assert.deepEqual(row(), beforeConflict);
    assert.equal(row().status, t.status);
    assert.equal(row().result, t.result);
    assert.equal(row().rev, routed.rev);
  });

  it('the owner can change status, result, reopen, and re-address an addressed task', async () => {
    await setMode('enforce');
    const t = await addressed('Owner Can');
    const updated = await owner.json<Task>('/api/owner/tasks', { json: { id: t.id, rev: t.rev, status: 'in_progress', result: 'Owner note' } });
    assert.equal(updated.status, 'in_progress');
    assert.equal(updated.result, 'Owner note');
    const done = await owner.json<Task>('/api/owner/tasks', { json: { id: t.id, rev: updated.rev, status: 'done' } });
    const reopened = await owner.json<Task>('/api/owner/tasks', { json: { id: t.id, rev: done.rev, status: 'open' } });
    assert.equal(reopened.status, 'open');
    const routed = await owner.json<Task>('/api/owner/tasks', { json: { id: t.id, rev: reopened.rev, for_agent: 'hal' } });
    assert.equal(routed.for_agent, 'hal');
  });

  it('a call with no agent, on a platform with agents, is refused for an addressed task', async () => {
    await setMode('enforce');
    const t = await addressed('Nameless Call');
    for (const c of [grok, home]) {
      await assert.rejects(
        call(c, 'save_task', { id: t.id, rev: t.rev, status: 'in_progress', claimed_role: 'developer' }),
        (e) => err(e).error === 'conflict' && /addressed to agent "ada".*named no agent/.test(err(e).message),
      );
    }
    const after = get<{ status: string; rev: number }>(env.svc.db, 'SELECT status, rev FROM task WHERE id = ?', t.id)!;
    assert.equal(after.status, t.status);
    assert.equal(after.rev, t.rev);
  });

  it('a second agent may still comment on an addressed task', async () => {
    await setMode('enforce');
    const t = await addressed('Comment Ok');
    const out = await call<{ comment_id: string }>(home, 'comment_task', { id: t.id, body: 'A note from Hal.', claimed_role: 'developer', agent: 'hal' });
    assert.ok(out.comment_id);
  });

  it('a task with no for_agent behaves as today', async () => {
    await setMode('enforce');
    const t = await call<Task>(grok, 'save_task', { title: 'Any Developer', role: 'developer', claimed_role: 'developer', agent: 'ada' });
    assert.equal(t.for_agent, null);
    const byHal = await call<Task>(home, 'save_task', { id: t.id, rev: t.rev, status: 'in_progress', result: 'Hal picked it up', claimed_role: 'developer', agent: 'hal' });
    assert.equal(byHal.status, 'in_progress');
    assert.equal(byHal.result, 'Hal picked it up');
  });

  it('in enforce mode a task claimed by a named agent cannot have its status changed or be reopened by another agent', async () => {
    await setMode('enforce');
    const t = await call<Task>(grok, 'save_task', { title: 'Claimed Guard', role: 'developer', claimed_role: 'developer', agent: 'ada' });
    const claimed = await call<Task>(grok, 'claim_task', { id: t.id, claimed_role: 'developer', agent: 'ada' });
    assert.equal(claimed.claimed_by?.agent, 'ada');
    const before = get<{ status: string; rev: number }>(env.svc.db, 'SELECT status, rev FROM task WHERE id = ?', t.id)!;
    await assert.rejects(
      call(home, 'save_task', { id: t.id, rev: claimed.rev, status: 'done', claimed_role: 'developer', agent: 'hal' }),
      (e) => err(e).error === 'conflict' && /claimed by agent "ada"/.test(err(e).message),
    );
    await assert.rejects(
      call(home, 'save_task', { id: t.id, rev: claimed.rev, result: 'Hal finished it', claimed_role: 'developer', agent: 'hal' }),
      (e) => err(e).error === 'conflict' && /claimed by agent "ada"/.test(err(e).message),
    );
    const done = await call<Task>(grok, 'save_task', { id: t.id, rev: claimed.rev, status: 'done', claimed_role: 'developer', agent: 'ada' });
    await assert.rejects(
      call(home, 'save_task', { id: t.id, rev: done.rev, status: 'open', claimed_role: 'developer', agent: 'hal' }),
      (e) => err(e).error === 'conflict' && /claimed by agent "ada"/.test(err(e).message),
    );
    const after = get<{ status: string; rev: number }>(env.svc.db, 'SELECT status, rev FROM task WHERE id = ?', t.id)!;
    assert.equal(after.status, 'done');
    assert.equal(after.rev, done.rev);
    assert.ok(after.rev >= before.rev);
    const routed = await call<Task>(grok, 'save_task', { id: t.id, rev: done.rev, for_agent: 'hal', claimed_role: 'coordinator', agent: 'mia' });
    assert.equal(routed.for_agent, 'hal');
  });

  it('in warn mode a second agent is also refused with the same conflict, the task and rev stay the same, and the refusal is audited', async () => {
    await setMode('warn');
    const t = await addressed('Warn Guard');
    const snapshot = () => get<{ status: string; result: string; blocking_reason: string; rev: number; agent_id: string | null }>(env.svc.db, 'SELECT status, result, blocking_reason, rev, agent_id FROM task WHERE id = ?', t.id)!;
    const before = snapshot();
    const auditsBefore = get<{ n: number }>(
      env.svc.db,
      "SELECT count(*) AS n FROM oauth_diag WHERE step = 'role_check' AND outcome = 'rejected' AND detail LIKE '%task_addressed%'",
    )!.n;

    for (const patch of [{ status: 'in_progress' }, { result: 'Hal in warn' }, { status: 'blocked', blocking_reason: 'waiting' }, { for_agent: 'hal' }]) {
      await assert.rejects(
        call(home, 'save_task', { id: t.id, rev: t.rev, ...patch, claimed_role: 'developer', agent: 'hal' }),
        (e) => err(e).error === 'conflict' && /addressed to agent "ada"/.test(err(e).message),
      );
      assert.deepEqual(snapshot(), before, `task changed on ${JSON.stringify(patch)} in warn mode`);
      assert.equal(snapshot().rev, t.rev);
    }

    await call<Task>(grok, 'save_task', { id: t.id, rev: t.rev, status: 'done', claimed_role: 'developer', agent: 'ada' });
    const done = snapshot();
    await assert.rejects(
      call(home, 'save_task', { id: t.id, rev: done.rev, status: 'open', claimed_role: 'developer', agent: 'hal' }),
      (e) => err(e).error === 'conflict' && /addressed to agent "ada"/.test(err(e).message),
    );
    assert.equal(snapshot().status, 'done');
    assert.equal(snapshot().rev, done.rev);
    const auditsAfter = get<{ n: number }>(
      env.svc.db,
      "SELECT count(*) AS n FROM oauth_diag WHERE step = 'role_check' AND outcome = 'rejected' AND detail LIKE '%task_addressed%'",
    )!.n;
    assert.ok(auditsAfter >= auditsBefore + 5, `expected refusal audits in warn mode, got ${auditsAfter - auditsBefore}`);

    const claimedSrc = await call<Task>(grok, 'save_task', { title: 'Warn Claimed', role: 'developer', claimed_role: 'developer', agent: 'ada' });
    const claimed = await call<Task>(grok, 'claim_task', { id: claimedSrc.id, claimed_role: 'developer', agent: 'ada' });
    const claimedBefore = get<{ status: string; rev: number }>(env.svc.db, 'SELECT status, rev FROM task WHERE id = ?', claimed.id)!;
    await assert.rejects(
      call(home, 'save_task', { id: claimed.id, rev: claimed.rev, status: 'done', claimed_role: 'developer', agent: 'hal' }),
      (e) => err(e).error === 'conflict' && /claimed by agent "ada"/.test(err(e).message),
    );
    const claimedAfter = get<{ status: string; rev: number }>(env.svc.db, 'SELECT status, rev FROM task WHERE id = ?', claimed.id)!;
    assert.deepEqual(claimedAfter, claimedBefore);
    const claimedAudit = get<{ n: number }>(
      env.svc.db,
      "SELECT count(*) AS n FROM oauth_diag WHERE step = 'role_check' AND outcome = 'rejected' AND detail LIKE '%task_claimed%'",
    )!;
    assert.ok(claimedAudit.n >= 1);
  });
});
