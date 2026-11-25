import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { get } from '../src/db/db.ts';
import { hmacSha256Hex } from '../src/util/crypto.ts';
import { MAX_ATTEMPTS } from '../src/webhooks/dispatcher.ts';
import { isPublicAddress, postJson, validateWebhookUrl } from '../src/webhooks/transport.ts';
import { call, connectAgent, freePort, registerOwner, startService, type Browser, type TestEnv } from './helpers/harness.ts';

describe('webhook address checks', () => {
  it('blocks internal, private and special addresses', () => {
    for (const a of ['127.0.0.1', '10.1.2.3', '172.16.0.5', '192.168.1.10', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fc00::1', '::ffff:127.0.0.1', '224.0.0.1']) {
      assert.equal(isPublicAddress(a), false, a);
    }
    for (const a of ['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111']) assert.equal(isPublicAddress(a), true, a);
  });
  it('validates URLs', () => {
    assert.throws(() => validateWebhookUrl('http://hooks.example.org/x', false), /https/);
    assert.throws(() => validateWebhookUrl('https://127.0.0.1/x', false), /blocked/);
    assert.throws(() => validateWebhookUrl('https://[::1]/x', false), /blocked/);
    assert.throws(() => validateWebhookUrl('https://localhost/x', false), /blocked/);
    assert.throws(() => validateWebhookUrl('https://router.local/x', false), /blocked/);
    assert.throws(() => validateWebhookUrl('https://user:pass@hooks.example.org/x', false), /credentials/);
    assert.ok(validateWebhookUrl('https://hooks.example.org/x', false));
  });
  it('refuses to connect when a name resolves only to private addresses', async () => {
    // IP literals are refused before any connection is attempted.
    await assert.rejects(postJson('https://127.0.0.1:1/x', {}, '{}', { timeoutMs: 1000, allowPrivate: false }), /blocked/);
  });
});

describe('webhook deliveries', () => {
  let env: TestEnv;
  let owner: Browser;
  let receiver: http.Server;
  let received: { headers: http.IncomingHttpHeaders; body: string }[] = [];
  let status = 200;
  let port = 0;
  before(async () => {
    receiver = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push({ headers: req.headers, body });
        res.writeHead(status).end('ok');
      });
    });
    await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
    port = (receiver.address() as AddressInfo).port;
    // Local receivers need the explicit opt-in, as in a home lab.
    env = await startService({ env: { WEBHOOK_ALLOW_PRIVATE_ADDRESSES: 'true' } });
    owner = (await registerOwner(env)).browser;
  });
  after(async () => {
    await env.close();
    receiver.close();
  });

  const later = (s: number) => new Date(Date.now() + s * 1000);

  it('wakes a role with a signed signal that carries no content', async () => {
    const a = (await connectAgent(env, owner, 'Lead platform')).client;
    await call(a, 'save_role', { name: 'Lead', slug: 'lead' });
    await call(a, 'save_role', { name: 'Builder', slug: 'builder' });
    const hook = await owner.json('/api/owner/webhooks', {
      json: { role: 'builder', url: `http://127.0.0.1:${port}/wake`, authorization: 'Bearer test-receiver-key', events: ['task.assigned', 'task.commented'] },
    });
    const { signing_secret } = await owner.json(`/api/owner/webhooks/${hook.id}/secret`);

    const t = await call(a, 'save_task', { title: 'Secret plan for launch', role: 'builder', claimed_role: 'lead' });
    await call(a, 'comment_task', { id: t.id, body: 'More detail', claimed_role: 'lead' });
    assert.equal(await env.svc.webhooks.tick(), 0, 'coalescing window not over yet');
    received = [];
    await env.svc.webhooks.tick(later(11));
    assert.equal(received.length, 1, 'two events coalesced into one request');
    const r = received[0]!;
    assert.equal(r.headers.authorization, 'Bearer test-receiver-key');
    const ts = String(r.headers['x-workspace-timestamp']);
    assert.equal(r.headers['x-workspace-signature'], `sha256=${hmacSha256Hex(signing_secret, `${ts}.${r.body}`)}`);
    const payload = JSON.parse(r.body);
    assert.equal(payload.role, 'builder');
    assert.deepEqual(
      payload.events.map((e: any) => e.type),
      ['task.assigned', 'task.commented'],
    );
    assert.ok(!r.body.includes('Secret plan'), 'no workspace content in the request');
    const log = await owner.json(`/api/owner/webhooks/${hook.id}/deliveries`);
    assert.equal(log.deliveries[0].status, 'delivered');
    await a.close();
  });

  it('does not wake a role for its own changes', async () => {
    const a = (await connectAgent(env, owner, 'Builder platform')).client;
    received = [];
    const t = await call(a, 'save_task', { title: 'Own task', role: 'builder', claimed_role: 'builder' });
    await call(a, 'comment_task', { id: t.id, body: 'note to self', claimed_role: 'builder' });
    await env.svc.webhooks.tick(later(11));
    assert.equal(received.length, 0);
    await a.close();
  });

  it('retries an unreachable endpoint with backoff, then gives up and logs it', async () => {
    const dead = await freePort();
    const hook = await owner.json('/api/owner/webhooks', { json: { role: 'lead', url: `http://127.0.0.1:${dead}/gone`, events: ['task.assigned'] } });
    const a = (await connectAgent(env, owner, 'Retry platform')).client;
    await call(a, 'save_task', { title: 'Wake the lead', role: 'lead', claimed_role: 'builder' });
    let at = 11;
    await env.svc.webhooks.tick(later(at));
    let d = get<{ status: string; attempts: number; last_error: string; next_attempt_at: string }>(env.svc.db, 'SELECT * FROM webhook_delivery WHERE webhook_id = ?', hook.id)!;
    assert.equal(d.status, 'pending');
    assert.equal(d.attempts, 1);
    assert.match(d.last_error, /ECONNREFUSED|connect/);
    assert.ok(Date.parse(d.next_attempt_at) > Date.now() + 20_000, 'backs off');
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      at += 3 * 3600;
      await env.svc.webhooks.tick(later(at));
    }
    d = get(env.svc.db, 'SELECT * FROM webhook_delivery WHERE webhook_id = ?', hook.id)!;
    assert.equal(d.status, 'failed');
    assert.equal(d.attempts, MAX_ATTEMPTS);
    await a.close();
  });

  it('logs a non-2xx answer as a failed attempt', async () => {
    status = 500;
    const hook = await owner.json('/api/owner/webhooks', { json: { role: 'lead', url: `http://127.0.0.1:${port}/err`, events: ['task.assigned'] } });
    await owner.json(`/api/owner/webhooks/${hook.id}/test`, { method: 'POST', json: {} });
    await env.svc.webhooks.drain();
    await env.svc.webhooks.tick();
    const d = get<{ last_status: number; last_error: string }>(env.svc.db, 'SELECT * FROM webhook_delivery WHERE webhook_id = ?', hook.id)!;
    assert.equal(d.last_status, 500);
    assert.match(d.last_error, /HTTP 500/);
    status = 200;
  });

  it('refuses private targets unless the operator opts in', async () => {
    const strict = await startService();
    const b = (await registerOwner(strict)).browser;
    await b.json('/api/owner/roles', { json: { name: 'X', slug: 'x' } });
    const r = await b.fetch('/api/owner/webhooks', { json: { role: 'x', url: 'https://10.0.0.5/hook', events: ['task.assigned'] } });
    assert.equal(r.status, 400);
    const bad = await b.fetch('/api/owner/webhooks', { json: { role: 'x', url: 'https://hooks.example.org/x', events: ['everything'] } });
    assert.equal(bad.status, 400);
    await strict.close();
  });
});
