/**
 * End-to-end smoke test against a running deployment (used by CI on the built container image).
 *
 *   node scripts/smoke.ts <base-url> <setup-code> [phase]
 *
 * phase "first" (default): sets up the owner passkey from the setup code, connects an agent through OAuth,
 * fills a little data through MCP and checks the web interface and security headers. It writes the
 * passkey and agent tokens to $SMOKE_STATE (default ./smoke-state.json) for phase "again".
 * phase "again": after a restart, signs in with the same passkey and reads the data back.
 * Runs only against loopback addresses; it is a test, not an administration tool.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Browser, call, connectAgent, TestOAuthProvider, type TestEnv } from '../test/helpers/harness.ts';
import { SoftAuthenticator } from '../test/helpers/webauthn.ts';

const [base, setupCode, phase = 'first'] = process.argv.slice(2);
if (!base || (phase === 'first' && !setupCode)) {
  process.stderr.write('usage: node scripts/smoke.ts <base-url> <setup-code> [first|again]\n');
  process.exit(2);
}
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(base).hostname)) {
  process.stderr.write('smoke.ts only runs against a local deployment\n');
  process.exit(2);
}
const stateFile = process.env.SMOKE_STATE || 'smoke-state.json';
const env = { base, config: { mcpUrl: `${base}/mcp`, publicUrl: base } } as unknown as TestEnv;
const step = (s: string) => process.stdout.write(`  ok  ${s}\n`);

async function first() {
  const health = await (await fetch(`${base}/healthz`)).json();
  assert.equal(health.status, 'ok');
  step(`healthz (version ${health.version})`);

  const page = await fetch(`${base}/setup`);
  assert.equal(page.status, 200);
  const csp = page.headers.get('content-security-policy') ?? '';
  assert.match(csp, /script-src 'self'/);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  const html = await page.text();
  assert.match(html, /<div id="app">/);
  assert.doesNotMatch(html, /<script>(?!<\/script>)/, 'no inline scripts');
  const js = /src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
  assert.ok(js, 'bundle referenced');
  assert.equal((await fetch(base + js)).status, 200);
  step('interface served with security headers, assets local');

  const unauth = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' });
  assert.equal(unauth.status, 401);
  assert.match(unauth.headers.get('www-authenticate') ?? '', /resource_metadata=/);
  const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.equal(prm.resource, `${base}/mcp`);
  step('MCP endpoint refuses anonymous calls and advertises its authorization server');

  const browser = new Browser(base);
  const auth = new SoftAuthenticator(new URL(base).hostname, base);
  const ctx = await browser.json<{ context: string }>('/api/setup/verify', { json: { code: setupCode } });
  const options = await browser.json(`/api/auth/passkey/generate-register-options?context=${encodeURIComponent(ctx.context)}`);
  await browser.json('/api/auth/passkey/verify-registration', { json: { response: auth.register(options), createSession: true } });
  const me = await browser.json('/api/owner/me');
  assert.equal(me.mcp_url, `${base}/mcp`);
  step('owner passkey registered from the setup code');

  const provider = new TestOAuthProvider('Smoke agent');
  const { client } = await connectAgent(env, browser, 'Smoke agent', provider);
  const start = await call(client, 'start');
  assert.equal(start.data.empty_workspace, true);
  await call(client, 'update_rules', { text: 'Smoke rules.' });
  await call(client, 'save_role', { name: 'Smoke', slug: 'smoke', instruction: 'Check the deployment.' });
  const task = await call(client, 'save_task', { title: 'Smoke task', role: 'smoke' });
  step('agent connected through OAuth and wrote rules, a role and a task');

  fs.writeFileSync(stateFile, JSON.stringify({ credential: auth.export(), provider: provider.export(), task: task.id }));
  await client.close();
}

async function again() {
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const auth = SoftAuthenticator.import(new URL(base).hostname, base, state.credential);
  const browser = new Browser(base);
  const options = await browser.json('/api/auth/passkey/generate-authenticate-options');
  await browser.json('/api/auth/passkey/verify-authentication', { json: { response: auth.authenticate(options) } });
  const tasks = await browser.json('/api/owner/tasks');
  assert.ok(tasks.tasks.some((t: { id: string }) => t.id === state.task));
  step('signed in again with the same passkey; data survived the restart');

  const provider = TestOAuthProvider.import('Smoke agent', state.provider);
  const client = new Client({ name: 'smoke', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { authProvider: provider }));
  const start = await call(client, 'start');
  assert.match(JSON.stringify(start), /Smoke rules\./);
  step('agent token (refreshed if needed) still works after the restart');
  await client.close();
}

try {
  await (phase === 'again' ? again() : first());
  process.stdout.write(`smoke ${phase}: passed\n`);
} catch (e) {
  process.stderr.write(`smoke ${phase}: FAILED\n${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  process.exit(1);
}
