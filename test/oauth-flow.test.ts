import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Client, StreamableHTTPClientTransport, UnauthorizedError } from '@modelcontextprotocol/client';
import { Browser, call, connectAgent, registerOwner, startService, TestOAuthProvider, type TestEnv } from './helpers/harness.ts';

describe('OAuth path to a tool call', () => {
  let env: TestEnv;
  before(async () => {
    env = await startService();
  });
  after(async () => {
    await env.close();
  });

  it('discovers, registers, signs in with a passkey, consents and calls start', async () => {
    const { browser } = await registerOwner(env);
    const me = await browser.json('/api/owner/me');
    assert.equal(me.mcp_url, env.config.mcpUrl);

    const { client } = await connectAgent(env, browser, 'Claude test');
    const tools = await client.listTools();
    assert.ok(tools.tools.some((t) => t.name === 'start'));
    const s = await call(client, 'start', {});
    assert.ok(s);
    await client.close();
  });

  it('refreshes tokens with rotation, so a long-lived connection keeps working', async () => {
    const { browser } = await registerOwner(env, undefined, undefined, 'recovery');
    const { client, provider } = await connectAgent(env, browser, 'Refreshing platform');
    await client.close();
    const first = provider.tokens()!;
    assert.ok(first.refresh_token, 'a refresh token is issued');
    const as = await (await fetch(`${env.base}/.well-known/oauth-authorization-server`)).json();
    const refresh = (token: string) =>
      fetch(as.token_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token, client_id: provider.clientInformation()!.client_id, resource: env.config.mcpUrl }),
      });
    const r1 = await refresh(first.refresh_token!);
    assert.equal(r1.status, 200, await r1.clone().text());
    const next = await r1.json();
    assert.ok(next.access_token && next.refresh_token && next.refresh_token !== first.refresh_token, 'the refresh token rotates');
    const mcp = await fetch(env.config.mcpUrl, {
      method: 'POST',
      headers: { authorization: `Bearer ${next.access_token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }),
    });
    assert.equal(mcp.status, 200, 'the new access token is accepted');
    // A retry within the short grace window (network hiccup) gets the same answer, not a new grant.
    const retry = await refresh(first.refresh_token!);
    assert.equal(retry.status, 200);
    assert.equal((await retry.json()).refresh_token, next.refresh_token, 'a retry replays, it does not fork the grant');
  });
});

describe('OAuth sign-in from the login page', () => {
  let env: TestEnv;
  before(async () => {
    env = await startService();
  });
  after(async () => {
    await env.close();
  });

  it('continues the authorization after a passkey sign-in on /login', async () => {
    const { authenticator } = await registerOwner(env);
    const provider = new TestOAuthProvider('Signed-out platform');
    const client = new Client({ name: 'login-page-test', version: '1.0.0' });
    await assert.rejects(client.connect(new StreamableHTTPClientTransport(new URL(env.config.mcpUrl), { authProvider: provider })), UnauthorizedError);
    // A fresh browser with no session: authorize sends it to the login page with a signed query.
    const b = new Browser(env.base);
    const r = await b.fetch(provider.pendingAuthorization!.toString(), { headers: { accept: 'text/html', 'sec-fetch-mode': 'navigate' } });
    // Node's fetch always sends sec-fetch-mode: cors, so better-auth answers with JSON instead of a 302
    // (a real browser navigation gets the 302; checked with a raw HTTP request).
    const target = r.headers.get('location') ?? ((await r.json()) as { url: string }).url;
    const loc = new URL(target, env.base);
    assert.equal(loc.pathname, '/login');
    assert.ok(loc.searchParams.get('sig'), 'the login page gets a signed authorization query');
    const options = await b.json('/api/auth/passkey/generate-authenticate-options');
    const res = await b.json<{ redirect?: boolean; url?: string }>('/api/auth/passkey/verify-authentication', {
      json: { response: authenticator.authenticate(options), oauth_query: loc.search.slice(1) },
    });
    assert.ok(res.url, 'sign-in answers with where to continue');
    const next = new URL(res.url!, env.base);
    assert.equal(next.pathname, '/consent');
    const out = await b.json<{ url: string }>('/api/owner/consent', { json: { accept: true, name: 'Signed-out platform', oauth_query: next.search.slice(1) } });
    assert.ok(new URL(out.url).searchParams.get('code'));
  });
});
