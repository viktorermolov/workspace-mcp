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
  role?: string | null;
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

  const taskRow = (id: string) =>
    get<{
      status: string;
      result: string;
      blocking_reason: string;
      rev: number;
      agent_id: string | null;
      role_id: string | null;
      archived_at: string | null;
      claimed_by: string | null;
      claimed_agent: string | null;
    }>(env.svc.db, 'SELECT status, result, blocking_reason, rev, agent_id, role_id, archived_at, claimed_by, claimed_agent FROM task WHERE id = ?', id)!;

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
    const snapshot = () => taskRow(t.id);

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

  it('a coordinator without the task role is forbidden from changing status or result, and the task and rev stay the same', async () => {
    await setMode('enforce');
    const t = await addressed('Coordinator Forbidden');
    const routed = await call<Task>(grok, 'save_task', { id: t.id, rev: t.rev, for_agent: 'hal', claimed_role: 'coordinator', agent: 'mia' });
    assert.equal(routed.for_agent, 'hal');
    const before = taskRow(routed.id);
    await assert.rejects(
      call(grok, 'save_task', { id: routed.id, rev: routed.rev, status: 'done', claimed_role: 'coordinator', agent: 'mia' }),
      (e) => err(e).error === 'forbidden' && /belongs to role "developer"/.test(err(e).message),
    );
    assert.deepEqual(taskRow(routed.id), before);
    await assert.rejects(
      call(grok, 'save_task', { id: routed.id, rev: routed.rev, result: 'Mia wrote this', claimed_role: 'coordinator', agent: 'mia' }),
      (e) => err(e).error === 'forbidden' && /belongs to role "developer"/.test(err(e).message),
    );
    assert.deepEqual(taskRow(routed.id), before);
    assert.equal(taskRow(routed.id).rev, routed.rev);
    assert.equal(taskRow(routed.id).status, t.status);
    assert.equal(taskRow(routed.id).result, t.result);
  });

  it('a coordinator who also takes the task role is refused with conflict for status or result, and the task and rev stay the same', async () => {
    await setMode('enforce');
    const t = await addressed('Coordinator Conflict');
    const routed = await call<Task>(grok, 'save_task', { id: t.id, rev: t.rev, for_agent: 'hal', claimed_role: 'coordinator', agent: 'mia' });
    assert.equal(routed.for_agent, 'hal');
    const before = taskRow(routed.id);
    await assert.rejects(
      call(grok, 'save_task', { id: routed.id, rev: routed.rev, status: 'done', claimed_role: 'developer', agent: 'mia' }),
      (e) => err(e).error === 'conflict' && /addressed to agent "hal"/.test(err(e).message),
    );
    assert.deepEqual(taskRow(routed.id), before);
    await assert.rejects(
      call(grok, 'save_task', { id: routed.id, rev: routed.rev, result: 'Mia wrote this', claimed_role: 'developer', agent: 'mia' }),
      (e) => err(e).error === 'conflict' && /addressed to agent "hal"/.test(err(e).message),
    );
    assert.deepEqual(taskRow(routed.id), before);
    assert.equal(taskRow(routed.id).rev, routed.rev);
    assert.equal(taskRow(routed.id).status, t.status);
    assert.equal(taskRow(routed.id).result, t.result);
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
    const after = taskRow(t.id);
    assert.equal(after.status, t.status);
    assert.equal(after.rev, t.rev);
  });

  it('a second agent may still comment on an addressed task, and may still edit title, description and priority', async () => {
    await setMode('enforce');
    const t = await addressed('Comment Ok');
    const out = await call<{ comment_id: string }>(home, 'comment_task', { id: t.id, body: 'A note from Hal.', claimed_role: 'developer', agent: 'hal' });
    assert.ok(out.comment_id);
    const edited = await call<Task>(home, 'save_task', {
      id: t.id,
      rev: t.rev,
      title: 'Hal renamed it',
      description: 'A note in the description',
      priority: 'high',
      claimed_role: 'developer',
      agent: 'hal',
    });
    assert.equal(edited.title, 'Hal renamed it');
    assert.equal(edited.for_agent, 'ada');
    const row = taskRow(t.id);
    assert.equal(row.status, t.status);
    assert.equal(row.agent_id, taskRow(t.id).agent_id);
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
    const before = taskRow(t.id);
    await assert.rejects(
      call(home, 'save_task', { id: t.id, rev: claimed.rev, status: 'done', claimed_role: 'developer', agent: 'hal' }),
      (e) => err(e).error === 'conflict' && /claimed by agent "ada"/.test(err(e).message),
    );
    assert.deepEqual(taskRow(t.id), before);
    await assert.rejects(
      call(home, 'save_task', { id: t.id, rev: claimed.rev, result: 'Hal finished it', claimed_role: 'developer', agent: 'hal' }),
      (e) => err(e).error === 'conflict' && /claimed by agent "ada"/.test(err(e).message),
    );
    assert.deepEqual(taskRow(t.id), before);
    const done = await call<Task>(grok, 'save_task', { id: t.id, rev: claimed.rev, status: 'done', claimed_role: 'developer', agent: 'ada' });
    const afterDone = taskRow(t.id);
    await assert.rejects(
      call(home, 'save_task', { id: t.id, rev: done.rev, status: 'open', claimed_role: 'developer', agent: 'hal' }),
      (e) => err(e).error === 'conflict' && /claimed by agent "ada"/.test(err(e).message),
    );
    assert.deepEqual(taskRow(t.id), afterDone);
    assert.equal(taskRow(t.id).status, 'done');
    assert.equal(taskRow(t.id).rev, done.rev);
  });

  it('a second agent cannot clear the addressee or address a third agent, in warn or enforce mode; claim_task still fails after the refusal', async () => {
    for (const mode of ['enforce', 'warn'] as const) {
      await setMode(mode);
      const t = await addressed(`Bypass ${mode}`);
      const before = taskRow(t.id);
      await assert.rejects(
        call(home, 'save_task', { id: t.id, rev: t.rev, for_agent: null, claimed_role: 'developer', agent: 'hal' }),
        (e) => err(e).error === 'conflict' && /addressed to agent "ada"/.test(err(e).message),
      );
      assert.deepEqual(taskRow(t.id), before, `cleared for_agent in ${mode}`);
      await assert.rejects(
        call(home, 'claim_task', { id: t.id, claimed_role: 'developer', agent: 'hal' }),
        (e) => err(e).error === 'conflict' && /addressed to agent "ada"/.test(err(e).message),
      );
      assert.deepEqual(taskRow(t.id), before);
      await assert.rejects(
        call(home, 'save_task', { id: t.id, rev: t.rev, for_agent: 'mia', claimed_role: 'developer', agent: 'hal' }),
        (e) => err(e).error === 'conflict' && /addressed to agent "ada"/.test(err(e).message),
      );
      assert.deepEqual(taskRow(t.id), before, `addressed a third agent in ${mode}`);
      assert.equal(taskRow(t.id).rev, t.rev);
    }
  });

  it('a second agent cannot archive or change the role of an addressed task, in warn or enforce mode; title, description and priority stay editable', async () => {
    for (const mode of ['enforce', 'warn'] as const) {
      await setMode(mode);
      const t = await addressed(`Archive Role ${mode}`);
      const before = taskRow(t.id);
      await assert.rejects(
        call(home, 'archive', { type: 'task', id: t.id, claimed_role: 'developer', agent: 'hal' }),
        (e) => err(e).error === 'conflict' && /addressed to agent "ada"/.test(err(e).message),
      );
      assert.deepEqual(taskRow(t.id), before, `archived in ${mode}`);
      assert.equal(taskRow(t.id).archived_at, null);
      await assert.rejects(
        call(home, 'save_task', { id: t.id, rev: t.rev, role: 'coordinator', claimed_role: 'developer', agent: 'hal' }),
        (e) => err(e).error === 'conflict' && /addressed to agent "ada"/.test(err(e).message),
      );
      assert.deepEqual(taskRow(t.id), before, `role changed in ${mode}`);
      assert.equal(taskRow(t.id).rev, t.rev);
      const edited = await call<Task>(home, 'save_task', {
        id: t.id,
        rev: t.rev,
        title: `Still editable ${mode}`,
        description: 'ok',
        priority: 'low',
        claimed_role: 'developer',
        agent: 'hal',
      });
      assert.equal(edited.title, `Still editable ${mode}`);
      assert.equal(edited.for_agent, 'ada');
      assert.equal(taskRow(t.id).status, before.status);
      assert.equal(taskRow(t.id).agent_id, before.agent_id);
    }
  });

  it('re-addressing a claimed in_progress task clears the claim so the new addressee must claim it', async () => {
    await setMode('enforce');
    const t = await addressed('Reset Claim Owner');
    const claimed = await call<Task>(grok, 'claim_task', { id: t.id, claimed_role: 'developer', agent: 'ada' });
    assert.equal(claimed.status, 'in_progress');
    assert.equal(claimed.claimed_by?.agent, 'ada');
    const routed = await owner.json<Task>('/api/owner/tasks', { json: { id: t.id, rev: claimed.rev, for_agent: 'hal' } });
    assert.equal(routed.for_agent, 'hal');
    assert.equal(routed.status, 'open');
    assert.equal(routed.claimed_by, null);
    const ev = get<{ action: string; summary: string }>(
      env.svc.db,
      "SELECT action, summary FROM event WHERE entity_id = ? AND action = 'task.claim_reset'",
      t.id,
    );
    assert.ok(ev, 'expected a task.claim_reset journal event after the owner re-addressed');
    assert.match(ev.summary, /cleared after it was re-addressed/);
    const taken = await call<Task>(home, 'claim_task', { id: t.id, claimed_role: 'developer', agent: 'hal' });
    assert.equal(taken.status, 'in_progress');
    assert.equal(taken.claimed_by?.agent, 'hal');

    const t2 = await addressed('Reset Claim Coordinator');
    const claimed2 = await call<Task>(grok, 'claim_task', { id: t2.id, claimed_role: 'developer', agent: 'ada' });
    const routed2 = await call<Task>(grok, 'save_task', { id: t2.id, rev: claimed2.rev, for_agent: 'hal', claimed_role: 'coordinator', agent: 'mia' });
    assert.equal(routed2.for_agent, 'hal');
    assert.equal(routed2.status, 'open');
    assert.equal(routed2.claimed_by, null);
    const ev2 = get<{ action: string }>(
      env.svc.db,
      "SELECT action FROM event WHERE entity_id = ? AND action = 'task.claim_reset'",
      t2.id,
    );
    assert.ok(ev2, 'expected a task.claim_reset journal event after the coordinator re-addressed');
    const taken2 = await call<Task>(home, 'claim_task', { id: t2.id, claimed_role: 'developer', agent: 'hal' });
    assert.equal(taken2.claimed_by?.agent, 'hal');
  });

  it('in warn mode a second agent is also refused with the same conflict, the task and rev stay the same, and the refusal is audited', async () => {
    await setMode('warn');
    const t = await addressed('Warn Guard');
    const snapshot = () => taskRow(t.id);
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
    const claimedBefore = taskRow(claimed.id);
    await assert.rejects(
      call(home, 'save_task', { id: claimed.id, rev: claimed.rev, status: 'done', claimed_role: 'developer', agent: 'hal' }),
      (e) => err(e).error === 'conflict' && /claimed by agent "ada"/.test(err(e).message),
    );
    assert.deepEqual(taskRow(claimed.id), claimedBefore);
    const claimedAudit = get<{ n: number }>(
      env.svc.db,
      "SELECT count(*) AS n FROM oauth_diag WHERE step = 'role_check' AND outcome = 'rejected' AND detail LIKE '%task_claimed%'",
    )!;
    assert.ok(claimedAudit.n >= 1);
  });
});
