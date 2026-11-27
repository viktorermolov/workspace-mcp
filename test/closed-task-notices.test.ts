import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';
import { all } from '../src/db/db.ts';
import { call, connectAgent, registerOwner, startService, type Browser, type TestEnv } from './helpers/harness.ts';

const confirmRoles = (owner: Browser, clientId: string, roles: string[]) =>
  owner.json(`/api/owner/connections/${encodeURIComponent(clientId)}/roles`, { json: { roles, confirm: true } });

type Client = Awaited<ReturnType<typeof connectAgent>>['client'];
type Start = {
  data: {
    closed_tasks_you_created?: { task_id: string; closed_as: string; status: string; closed_by: string; result: string }[];
    comments_on_closed_tasks?: { task_id: string; comment: string; you_are: string[]; by: string }[];
  };
};

describe('closed tasks reach their creator (#183)', () => {
  let env: TestEnv;
  let owner: Browser;
  let grok: Client;
  let home: Client;
  let legacy: Client;
  let receiver: http.Server;
  let received: { role: string; types: string[] }[] = [];
  const later = (s: number) => new Date(Date.now() + s * 1000);

  const start = (c: Client, args: Record<string, unknown>) => call<Start>(c, 'start', args);
  const closedFor = async (c: Client, args: Record<string, unknown>) => (await start(c, args)).data.closed_tasks_you_created ?? [];
  const commentsFor = async (c: Client, args: Record<string, unknown>) => (await start(c, args)).data.comments_on_closed_tasks ?? [];
  const notices = (taskId: string) => all<{ action: string }>(env.svc.db, "SELECT action FROM event WHERE entity_id = ? AND action = 'task.closed'", taskId);

  async function handOver(title: string) {
    const t = await call(grok, 'save_task', { title, role: 'builder', for_agent: 'hal', claimed_role: 'lead', agent: 'ada' });
    const claimed = await call(home, 'claim_task', { id: t.id, claimed_role: 'builder', agent: 'hal' });
    return claimed as { id: string; rev: number };
  }
  const close = (id: string, rev: number, status = 'done', result = 'Shipped') =>
    call<{ id: string; rev: number }>(home, 'save_task', { id, rev, status, result, claimed_role: 'builder', agent: 'hal' });

  before(async () => {
    receiver = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const p = JSON.parse(body);
        received.push({ role: p.role, types: p.events.map((e: { type: string }) => e.type) });
        res.writeHead(200).end('ok');
      });
    });
    await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
    const port = (receiver.address() as AddressInfo).port;
    env = await startService({ env: { WEBHOOK_ALLOW_PRIVATE_ADDRESSES: 'true' } });
    owner = (await registerOwner(env)).browser;
    await owner.json('/api/owner/roles', { json: { name: 'Lead', slug: 'lead' } });
    await owner.json('/api/owner/roles', { json: { name: 'Builder', slug: 'builder' } });
    grok = (await connectAgent(env, owner, 'Grok')).client;
    home = (await connectAgent(env, owner, 'Home server')).client;
    legacy = (await connectAgent(env, owner, 'Legacy')).client;
    const list = await owner.json<{ connections: { client_id: string; name: string }[] }>('/api/owner/connections');
    const id = (n: string) => list.connections.find((c) => c.name === n)!.client_id;
    await confirmRoles(owner, id('Grok'), ['lead']);
    await confirmRoles(owner, id('Home server'), ['builder']);
    await confirmRoles(owner, id('Legacy'), ['lead', 'builder']);
    await owner.json('/api/owner/agents', { json: { name: 'Ada', platform: id('Grok'), roles: ['lead'] } });
    await owner.json('/api/owner/agents', { json: { name: 'Ben', platform: id('Grok'), roles: ['lead'] } });
    await owner.json('/api/owner/agents', { json: { name: 'Hal', platform: id('Home server'), roles: ['builder'] } });
    for (const role of ['lead', 'builder']) {
      await owner.json('/api/owner/webhooks', { json: { role, url: `http://127.0.0.1:${port}/${role}`, events: ['task.updated', 'task.commented'] } });
    }
    // Markers for every caller, so each test sees only what happened after this point.
    for (const [c, a] of [[grok, { agent: 'ada' }], [grok, { agent: 'ben' }], [home, { agent: 'hal' }], [legacy, { role: 'lead' }], [legacy, { role: 'builder' }]] as const) await start(c, a);
  });

  beforeEach(async () => {
    await env.svc.webhooks.tick(later(3600));
    received = [];
  });

  after(async () => {
    await env.close();
    receiver.close();
  });

  it('closing a task tells its creator once, in start, and journals it', async () => {
    const t = await handOver('Build the export');
    const done = await close(t.id, t.rev);
    assert.equal(notices(t.id).length, 1, 'one task.closed entry');

    const seen = await closedFor(grok, { agent: 'ada' });
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.task_id, t.id);
    assert.equal(seen[0]!.closed_as, 'done');
    assert.equal(seen[0]!.result, 'Shipped');
    assert.match(seen[0]!.closed_by, /hal/);
    assert.deepEqual(await closedFor(grok, { agent: 'ada' }), [], 'an inbox item is shown once');
    assert.deepEqual(await closedFor(home, { agent: 'hal' }), [], 'the closer is not told about its own close');
    assert.deepEqual(await closedFor(grok, { agent: 'ben' }), [], 'another agent of the creator role is not the creator');

    // done -> cancelled, a repeat of done, and reopen + close again do not notify a second time.
    const cancelled = await close(done.id, done.rev, 'cancelled');
    const same = await call(home, 'save_task', { id: t.id, rev: cancelled.rev, status: 'cancelled', claimed_role: 'builder', agent: 'hal' });
    assert.equal(same.unchanged, true);
    const reopened = await call(home, 'save_task', { id: t.id, rev: cancelled.rev, status: 'in_progress', claimed_role: 'builder', agent: 'hal' });
    await close(t.id, reopened.rev);
    assert.equal(notices(t.id).length, 1, 'still one task.closed entry');
    assert.deepEqual(await closedFor(grok, { agent: 'ada' }), []);
  });

  it('wakes the creator role with the existing task.updated type, even when the closer has the same role', async () => {
    const t = await call(grok, 'save_task', { title: 'Ben closes this', role: 'lead', claimed_role: 'lead', agent: 'ada' });
    await env.svc.webhooks.tick(later(3600));
    received = [];
    await call(grok, 'save_task', { id: t.id, rev: t.rev, status: 'done', claimed_role: 'lead', agent: 'ben' });
    await env.svc.webhooks.tick(later(3600));
    const lead = received.filter((r) => r.role === 'lead');
    assert.equal(lead.length, 1, 'the creator role is woken');
    assert.ok(lead[0]!.types.includes('task.updated'));
    assert.equal((await closedFor(grok, { agent: 'ada' }))[0]?.task_id, t.id);
  });

  it('a creator closing its own task gets no notice', async () => {
    const t = await call(grok, 'save_task', { title: 'My own chore', role: 'lead', claimed_role: 'lead', agent: 'ada' });
    await env.svc.webhooks.tick(later(3600));
    received = [];
    await call(grok, 'save_task', { id: t.id, rev: t.rev, status: 'done', claimed_role: 'lead', agent: 'ada' });
    await env.svc.webhooks.tick(later(3600));
    assert.equal(notices(t.id).length, 0);
    assert.deepEqual(received, [], 'no wake-up for its own close');
    assert.deepEqual(await closedFor(grok, { agent: 'ada' }), []);
  });

  it('a comment on a closed task reaches the assignee and the creator, and wakes both roles', async () => {
    const t = await handOver('Closed then questioned');
    await close(t.id, t.rev);
    await start(grok, { agent: 'ada' });
    await env.svc.webhooks.tick(later(3600));
    received = [];

    await call(grok, 'comment_task', { id: t.id, body: 'Does this cover CSV too?', claimed_role: 'lead', agent: 'ben' });
    await env.svc.webhooks.tick(later(3600));
    assert.deepEqual(received.map((r) => r.role).sort(), ['builder', 'lead']);
    for (const r of received) assert.ok(r.types.includes('task.commented'));

    const forHal = await commentsFor(home, { agent: 'hal' });
    assert.equal(forHal.length, 1);
    assert.deepEqual(forHal[0]!.you_are, ['assignee']);
    assert.equal(forHal[0]!.comment, 'Does this cover CSV too?');
    const forAda = await commentsFor(grok, { agent: 'ada' });
    assert.equal(forAda.length, 1);
    assert.deepEqual(forAda[0]!.you_are, ['creator']);
    assert.match(forAda[0]!.by, /ben/);
    assert.deepEqual(await commentsFor(grok, { agent: 'ben' }), [], 'the writer does not see its own comment');

    // The assignee answers: the creator hears it, the assignee does not see its own answer.
    await call(home, 'comment_task', { id: t.id, body: 'Yes, CSV is included.', claimed_role: 'builder', agent: 'hal' });
    assert.deepEqual(await commentsFor(home, { agent: 'hal' }), []);
    const reply = await commentsFor(grok, { agent: 'ada' });
    assert.equal(reply.length, 1);
    assert.equal(reply[0]!.comment, 'Yes, CSV is included.');
  });

  it('comments on open tasks stay as they were', async () => {
    const t = await handOver('Still open');
    await call(grok, 'comment_task', { id: t.id, body: 'How is it going?', claimed_role: 'lead', agent: 'ada' });
    assert.deepEqual(await commentsFor(home, { agent: 'hal' }), []);
    const ev = all<{ data: string }>(env.svc.db, "SELECT data FROM event WHERE entity_id = ? AND action = 'task.commented'", t.id);
    assert.equal(ev.length, 1);
    assert.equal(JSON.parse(ev[0]!.data).on_closed_task, undefined);
  });

  it('an older connector that names no agent still gets the notice for the role it created the task with', async () => {
    const t = await call(legacy, 'save_task', { title: 'Legacy hand-over', role: 'builder', claimed_role: 'lead' });
    const claimed = await call(home, 'claim_task', { id: t.id, claimed_role: 'builder', agent: 'hal' });
    await close(claimed.id, claimed.rev, 'cancelled');
    assert.deepEqual(await closedFor(legacy, { role: 'builder' }), [], 'not under another role of the platform');
    // Many changes since this platform's last start: the changes list is paged, the notice is not held back.
    const s = await start(legacy, { role: 'lead' });
    assert.equal((s.data as { changes_since_previous_start?: { has_more?: boolean } }).changes_since_previous_start?.has_more, true);
    const seen = s.data.closed_tasks_you_created ?? [];
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.closed_as, 'cancelled');
    assert.deepEqual(await closedFor(grok, { agent: 'ada' }), [], 'another platform is not the creator');
  });

  it('the owner closing an agent task notifies the creator', async () => {
    const t = await call(grok, 'save_task', { title: 'Owner wraps this up', role: 'builder', claimed_role: 'lead', agent: 'ada' });
    await owner.json('/api/owner/tasks', { json: { id: t.id, rev: t.rev, status: 'done' } });
    assert.equal(notices(t.id).length, 1);
    assert.equal((await closedFor(grok, { agent: 'ada' }))[0]?.task_id, t.id);
    // An owner comment on the closed task reaches the creator too.
    await owner.json(`/api/owner/tasks/${t.id}/comment`, { json: { body: 'Closed it myself, thanks.' } });
    const c = await commentsFor(grok, { agent: 'ada' });
    assert.equal(c.length, 1);
    assert.deepEqual(c[0]!.you_are, ['creator']);
  });

  it('a task the owner created is journaled as closed and wakes no agent role', async () => {
    const t = await owner.json<{ id: string; rev: number }>('/api/owner/tasks', { json: { title: 'Owner errand', role: 'builder' } });
    const claimed = await call(home, 'claim_task', { id: t.id, claimed_role: 'builder', agent: 'hal' });
    await env.svc.webhooks.tick(later(3600));
    received = [];
    await close(claimed.id, claimed.rev);
    await env.svc.webhooks.tick(later(3600));
    assert.equal(notices(t.id).length, 1);
    assert.deepEqual(received.filter((r) => r.role === 'lead'), []);
    assert.deepEqual(await closedFor(grok, { agent: 'ada' }), []);
  });
});
