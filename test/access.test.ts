import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { issueCode } from '../src/auth/setup.ts';
import { get } from '../src/db/db.ts';
import { Browser, call, connectAgent, registerOwner, signIn, startService, TestOAuthProvider, type TestEnv } from './helpers/harness.ts';
import { SoftAuthenticator } from './helpers/webauthn.ts';

const CIMD_ID = 'https://agent.example.org/oauth/client.json';

describe('access control', () => {
  let env: TestEnv;
  let owner: Browser;
  let passkey: SoftAuthenticator;
  before(async () => {
    env = await startService({
      // A fake metadata host for the client ID metadata document (CIMD) test; the real fetcher blocks loopback.
      cimdFetch: async (input) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url !== CIMD_ID) return new Response('not found', { status: 404 });
        return Response.json({
          client_id: CIMD_ID,
          client_name: 'Metadata document agent',
          redirect_uris: ['http://127.0.0.1:9/callback'],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
        });
      },
    });
    ({ browser: owner, authenticator: passkey } = await registerOwner(env));
  });
  after(async () => {
    await env.close();
  });

  it('publishes discovery metadata for MCP clients', async () => {
    const prm = await (await fetch(`${env.base}/.well-known/oauth-protected-resource/mcp`)).json();
    assert.equal(prm.resource, env.config.mcpUrl);
    assert.ok(prm.authorization_servers.length >= 1);
    const as = await (await fetch(`${env.base}/.well-known/oauth-authorization-server`)).json();
    assert.ok(as.code_challenge_methods_supported.includes('S256'));
    assert.equal(as.authorization_response_iss_parameter_supported, true);
    assert.equal(as.client_id_metadata_document_supported, true);
    assert.ok(as.registration_endpoint);
  });

  it('rejects MCP calls without a token or with an invalid token, pointing to the metadata', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    const none = await fetch(env.config.mcpUrl, { method: 'POST', headers, body });
    assert.equal(none.status, 401);
    assert.match(none.headers.get('www-authenticate') ?? '', /resource_metadata="[^"]+\/\.well-known\/oauth-protected-resource\/mcp"/);
    const bad = await fetch(env.config.mcpUrl, { method: 'POST', headers: { ...headers, authorization: 'Bearer not-a-real-token' }, body });
    assert.equal(bad.status, 401);
  });

  it('protects the owner API: session required, cross-origin writes refused', async () => {
    const anon = new Browser(env.base);
    assert.equal((await anon.fetch('/api/owner/me')).status, 401);
    const cross = await fetch(`${env.base}/api/owner/rules`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example', cookie: [...owner.cookies].map(([k, v]) => `${k}=${v}`).join('; ') },
      body: JSON.stringify({ text: 'x' }),
    });
    assert.equal(cross.status, 403);
  });

  it('signs the owner in again with the passkey', async () => {
    const b = await signIn(env, passkey);
    const me = await b.json('/api/owner/me');
    assert.ok(me.member_id);
  });

  it('refuses a second owner and wrong codes', async () => {
    assert.throws(() => issueCode(env.svc.db, 'setup'), /already exists/);
    const r = await new Browser(env.base).fetch('/api/setup/verify', { json: { code: 'WRONG-CODE-0000' } });
    assert.equal(r.status, 400);
  });

  it('recovers access with a recovery code and a new passkey for the same owner', async () => {
    const { browser, authenticator } = await registerOwner(env, new Browser(env.base), undefined, 'recovery');
    const list = await browser.json('/api/owner/passkeys');
    assert.equal(list.passkeys.length, 2);
    const again = await signIn(env, authenticator);
    assert.ok((await again.json('/api/owner/me')).member_id);
  });

  it('revoking a connection cuts it off at once; other connections keep working', async () => {
    const a = await connectAgent(env, owner, 'Revoked platform');
    const b = await connectAgent(env, owner, 'Kept platform');
    await call(a.client, 'start');
    const conns = await owner.json('/api/owner/connections');
    const target = conns.connections.find((c: any) => c.name === 'Revoked platform');
    await owner.json(`/api/owner/connections/${encodeURIComponent(target.client_id)}/revoke`, { method: 'POST', json: {} });
    await assert.rejects(call(a.client, 'start'));
    assert.ok(await call(b.client, 'start'));
    // The old access token itself is refused, not only the client session.
    const token = a.provider.tokens()?.access_token;
    if (token) {
      const r = await fetch(env.config.mcpUrl, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      assert.equal(r.status, 401);
    }
    const diag = await owner.json(`/api/owner/diagnostics?client_id=${encodeURIComponent(target.client_id)}`);
    assert.ok(diag.entries.some((e: any) => e.step === 'mcp'));
    await b.client.close();
  });

  it('connects a client identified by a metadata document URL (CIMD)', async () => {
    const provider = new TestOAuthProvider('Metadata document agent', CIMD_ID);
    const { client } = await connectAgent(env, owner, 'CIMD agent', provider);
    assert.ok(await call(client, 'start'));
    const row = get<{ clientId: string }>(env.svc.db, 'SELECT clientId FROM oauthClient WHERE clientId = ?', CIMD_ID);
    assert.equal(row?.clientId, CIMD_ID);
    await client.close();
  });

  it('accepts dynamic registration with the documented platform callbacks', async () => {
    const as = await (await fetch(`${env.base}/.well-known/oauth-authorization-server`)).json();
    // Callbacks named in the platform guides under docs/platforms/.
    const callbacks = [
      'https://claude.ai/api/mcp/auth_callback',
      'https://chatgpt.com/connector_platform_oauth_redirect',
      'https://chatgpt.com/connector/oauth/test-callback-id',
      'https://grok.com/connectors-oauth-exchange-code/',
      'https://grok.com/connectors-oauth-exchange-code',
    ];
    for (const uri of callbacks) {
      const r = await fetch(as.registration_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_name: 'Platform', redirect_uris: [uri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }),
      });
      assert.equal(r.status, 201, `${uri}: ${r.status} ${await r.clone().text()}`);
      const c = await r.json();
      assert.deepEqual(c.redirect_uris, [uri]);
    }
  });

  it('refuses self-registered clients that ask for tokens without the owner (client_credentials)', async () => {
    const as = await (await fetch(`${env.base}/.well-known/oauth-authorization-server`)).json();
    const r = await fetch(as.registration_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'No owner', redirect_uris: ['https://e.example/cb'], grant_types: ['client_credentials'], response_types: [], token_endpoint_auth_method: 'client_secret_post' }),
    });
    assert.equal(r.status, 400);
  });

  it('lets only the owner delete permanently, and only archived items', async () => {
    const d = await owner.json('/api/owner/documents', { json: { title: 'Disposable note', body: 'Purgeable text' } });
    await assert.rejects(() => owner.json('/api/owner/purge', { json: { type: 'document', id: d.id } }), /archive the item first/);
    await owner.json('/api/owner/archive', { json: { type: 'document', id: d.id } });
    const r = await owner.json('/api/owner/purge', { json: { type: 'document', id: d.id } });
    assert.equal(r.deleted, true);
    assert.equal(get(env.svc.db, 'SELECT id FROM document WHERE id = ?', d.id), undefined);
    assert.equal(get<{ n: number }>(env.svc.db, "SELECT count(*) AS n FROM version WHERE entity_type = 'document' AND entity_id = ?", d.id)!.n, 0);
    const found = await owner.json(`/api/owner/search?query=${encodeURIComponent('Purgeable')}&include_archived=true`);
    assert.ok(!JSON.stringify(found).includes(d.id));
    const { client } = await connectAgent(env, owner, 'Purge check');
    const tools = await client.listTools();
    assert.ok(!tools.tools.some((t) => /purge|delete/.test(t.name)));
    await client.close();
  });

  it('creates a manual client for platforms without registration and shows the secret once', async () => {
    const created = await owner.json('/api/owner/clients', { json: { name: 'Manual platform', redirect_uris: ['https://platform.example/callback'], confidential: true } });
    assert.ok(created.client_id);
    assert.ok(created.client_secret);
    const conns = await owner.json('/api/owner/connections');
    assert.ok(JSON.stringify(conns).includes(created.client_id));
    assert.ok(!JSON.stringify(conns).includes(created.client_secret));
  });

  // Last in this file: the server closes a connection whose oversized body it did not read.
  it('limits the MCP request size, also for bodies sent without a length', async () => {
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    const big = 'x'.repeat(1024 * 1024 + 10);
    const sized = await fetch(env.config.mcpUrl, { method: 'POST', headers, body: big });
    assert.equal(sized.status, 413);
    const chunks = [big.slice(0, 600_000), big.slice(600_000)];
    const stream = new ReadableStream({
      pull(ctl) {
        const next = chunks.shift();
        if (next) ctl.enqueue(new TextEncoder().encode(next));
        else ctl.close();
      },
    });
    const chunked = await fetch(env.config.mcpUrl, { method: 'POST', headers, body: stream, duplex: 'half' } as RequestInit);
    assert.equal(chunked.status, 413);
  });
});
