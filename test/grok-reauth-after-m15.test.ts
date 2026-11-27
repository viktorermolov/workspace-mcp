import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Client, StreamableHTTPClientTransport, UnauthorizedError } from '@modelcontextprotocol/client';
import { checkAccess, expireUnusedClients, getConnection, getPendingBind, listConnections, listUnapprovedClients } from '../src/auth/connections.ts';
import { all, run, type DB } from '../src/db/db.ts';
import { repairEmptyActiveDuplicates } from '../src/db/repair-empty-active-duplicates.ts';
import {
  Browser,
  call,
  connectAgent,
  registerOwner,
  startService,
  TestOAuthProvider,
  type TestEnv,
} from './helpers/harness.ts';

const GROK_CB = 'https://grok.com/connectors-oauth-exchange-code/';

function grokProvider(): TestOAuthProvider {
  const p = new TestOAuthProvider('Grok');
  p.redirect = GROK_CB;
  return p;
}

function repairedOf(logs: { fields: Record<string, unknown> }[]): number {
  const last = [...logs].reverse().find((l) => typeof l.fields.repaired === 'number');
  return (last?.fields.repaired as number | undefined) ?? -1;
}

async function registerGrokClient(env: TestEnv): Promise<string> {
  const reg = await fetch(`${env.base}/api/auth/oauth2/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Grok',
      redirect_uris: [GROK_CB],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  const body = (await reg.json()) as { client_id: string };
  if (!body.client_id) throw new Error(`register failed: ${JSON.stringify(body)}`);
  return body.client_id;
}

function putEmptyPlatform(db: DB, clientId: string, memberId: string, name: string, at = '2026-11-20T00:00:00.000Z'): void {
  const t = at;
  run(
    db,
    'INSERT INTO connection (client_id, member_id, name, client_name, created_at, approved_at, current_client_id) VALUES (?,?,?,?,?,?,?)',
    clientId,
    memberId,
    name,
    'Grok',
    t,
    t,
    clientId,
  );
  run(
    db,
    `INSERT INTO event (member_id, at, actor_kind, connection_id, connection_name, claimed_role, agent, entity_type, entity_id, action, summary, data)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    memberId,
    t,
    'owner',
    null,
    name,
    null,
    null,
    'connection',
    clientId,
    'connection.approved',
    `Connection "${name}" approved`,
    '{}',
  );
}

type Ctx = {
  env: TestEnv;
  owner: Browser;
  originalId: string;
  leftoverId: string;
  first: Awaited<ReturnType<typeof connectAgent>>;
};

async function setupPostM15(): Promise<Ctx> {
  const env = await startService();
  try {
    const owner = (await registerOwner(env)).browser;
    const first = await connectAgent(env, owner, 'Grok', grokProvider());
    const originalId = listConnections(env.svc.db).find((c) => c.name === 'Grok')!.client_id;
    const memberId = getConnection(env.svc.db, originalId)!.member_id;
    const t = '2026-11-01T00:00:00.000Z';
    run(
      env.svc.db,
      'INSERT INTO agent (id, member_id, slug, name, client_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
      'agt_grok-dev',
      memberId,
      'grok-dev',
      'Grok Dev',
      originalId,
      t,
      t,
    );
    // m15 requires the leftover to be created later than the original, and the original
    // to have activity after the leftover was approved.
    run(
      env.svc.db,
      'UPDATE connection SET created_at = ?, approved_at = ? WHERE client_id = ?',
      '2026-11-01T00:00:00.000Z',
      '2026-11-01T00:00:00.000Z',
      originalId,
    );
    const leftoverId = await registerGrokClient(env);
    putEmptyPlatform(env.svc.db, leftoverId, memberId, 'Grok leftover', '2026-11-20T00:00:00.000Z');
    run(env.svc.db, 'UPDATE connection SET last_activity_at = ? WHERE client_id = ?', '2026-11-21T00:00:00.000Z', originalId);
    const logs = repairEmptyActiveDuplicates(env.svc.db);
    assert.equal(repairedOf(logs), 1, 'migration 15 archives the empty Grok duplicate');
    const leftover = getConnection(env.svc.db, leftoverId)!;
    assert.equal(leftover.merged_into_client_id, originalId);
    assert.ok(leftover.revoked_at);
    const original = getConnection(env.svc.db, originalId)!;
    assert.equal(original.current_client_id, originalId);
    assert.equal(original.merged_into_client_id, null);
    assert.ok(first.provider.tokens()?.access_token);
    assert.ok(first.provider.tokens()?.refresh_token);
    return { env, owner, originalId, leftoverId, first };
  } catch (e) {
    await env.close();
    throw e;
  }
}

async function closeCtx(ctx: Ctx): Promise<void> {
  await ctx.first.client.close().catch(() => undefined);
  await ctx.env.close();
}

async function approveConsent(owner: Browser, authorizationUrl: URL, connectionName: string): Promise<{ callback: URL; oauthQuery: string }> {
  const nav = { headers: { accept: 'text/html', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' } };
  const next = async (r: Response) => {
    const l = r.headers.get('location');
    if (l) return l;
    if ((r.headers.get('content-type') ?? '').includes('json')) {
      const j = (await r.clone().json()) as { url?: string; redirect?: boolean };
      if (j.redirect && j.url) return j.url;
    }
    return null;
  };
  let r = await owner.fetch(authorizationUrl.toString(), nav);
  let loc = await next(r);
  for (let i = 0; i < 5 && loc && !new URL(loc, owner.base).pathname.startsWith('/consent') && !loc.startsWith('https://grok.com/'); i++) {
    r = await owner.fetch(new URL(loc, owner.base).toString(), nav);
    loc = await next(r);
  }
  if (!loc) throw new Error(`authorize did not redirect: ${r.status} ${await r.text()}`);
  const target = new URL(loc, owner.base);
  if (!target.pathname.startsWith('/consent')) throw new Error(`expected consent, got ${target.href}`);
  const oauthQuery = target.search.slice(1);
  const clientId = new URLSearchParams(oauthQuery).get('client_id') ?? '';
  const info = await owner.json<{ continue_with?: { mode: string; target?: { client_id: string } } }>(
    `/api/owner/consent/client?client_id=${encodeURIComponent(clientId)}`,
  );
  const chosen = info.continue_with?.mode === 'auto' ? (info.continue_with.target?.client_id ?? null) : null;
  const out = await owner.json<{ url: string }>('/api/owner/consent', { json: { accept: true, name: connectionName, oauth_query: oauthQuery, continue_client_id: chosen } });
  return { callback: new URL(out.url), oauthQuery };
}

async function consentWithoutExchange(ctx: Ctx, provider = grokProvider()) {
  const url = new URL(ctx.env.config.mcpUrl);
  const transport = new StreamableHTTPClientTransport(url, { authProvider: provider });
  const client = new Client({ name: 'test-agent', version: '1.0.0' });
  try {
    await client.connect(transport);
    throw new Error('expected unauthorized before consent');
  } catch (e) {
    if (!(e instanceof UnauthorizedError) || !provider.pendingAuthorization) throw e;
  }
  const approved = await approveConsent(ctx.owner, provider.pendingAuthorization!, 'Grok');
  provider.pendingAuthorization = null;
  return { provider, callback: approved.callback, transport, url, oauthQuery: approved.oauthQuery };
}

async function exchangeAndConnect(started: Awaited<ReturnType<typeof consentWithoutExchange>>) {
  await started.transport.finishAuth(started.callback.searchParams);
  const transport = new StreamableHTTPClientTransport(started.url, { authProvider: started.provider });
  const client = new Client({ name: 'test-agent', version: '1.0.0' });
  await client.connect(transport);
  return { client, provider: started.provider };
}

async function postRefresh(env: TestEnv, clientId: string, refreshToken: string): Promise<Response> {
  const as = (await (await fetch(`${env.base}/.well-known/oauth-authorization-server`)).json()) as { token_endpoint: string };
  return fetch(as.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      resource: env.config.mcpUrl,
    }),
  });
}

async function postMcpInitialize(env: TestEnv, accessToken: string): Promise<Response> {
  return fetch(env.config.mcpUrl, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-06-18',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } },
    }),
  });
}

function reauthTransfers(db: DB, platformId: string) {
  return all<{ id: number; to_client_id: string }>(
    db,
    "SELECT id, to_client_id FROM connection_transfer WHERE kind = 'reauth' AND platform_client_id = ? ORDER BY id",
    platformId,
  );
}

function jwtClaims(token: string): { iat: number; azp?: string; client_id?: string } {
  const payload = token.split('.')[1];
  assert.ok(payload, 'access token is a JWT');
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { iat: number; azp?: string; client_id?: string };
}

describe('Grok re-auth after migration 15 (#189)', () => {
  it('(a) consent without a code exchange keeps the old refresh and /mcp, and does not rebind', async () => {
    const ctx = await setupPostM15();
    try {
      const oldAccess = ctx.first.provider.tokens()!.access_token;
      const oldRefresh = ctx.first.provider.tokens()!.refresh_token!;
      const oldClient = ctx.first.provider.clientInformation()!.client_id;

      const started = await consentWithoutExchange(ctx);
      const incoming = started.provider.clientInformation()!.client_id;
      assert.ok(incoming);
      assert.notEqual(incoming, ctx.originalId);

      const original = getConnection(ctx.env.svc.db, ctx.originalId)!;
      assert.equal(original.current_client_id, ctx.originalId, 'current_client_id is unchanged');
      assert.equal(reauthTransfers(ctx.env.svc.db, ctx.originalId).length, 0, 'no reauth transfer yet');
      const pending = getPendingBind(ctx.env.svc.db, ctx.originalId);
      assert.ok(pending, 'a pending bind is recorded');
      assert.equal(pending!.incoming_client_id, incoming);

      const mcp = await postMcpInitialize(ctx.env, oldAccess);
      assert.equal(mcp.status, 200, `mcp status ${mcp.status}`);
      const refresh = await postRefresh(ctx.env, oldClient, oldRefresh);
      assert.equal(refresh.status, 200, `refresh status ${refresh.status}`);
      const rotated = (await refresh.json()) as { access_token: string };
      assert.equal((await postMcpInitialize(ctx.env, rotated.access_token)).status, 200);

      assert.equal(getConnection(ctx.env.svc.db, ctx.leftoverId)!.merged_into_client_id, ctx.originalId);
      const pendingIds = new Set(listUnapprovedClients(ctx.env.svc.db).map((c) => c?.client_id));
      assert.ok(!pendingIds.has(incoming), 'the incoming client is not listed as unapproved while pending');
      expireUnusedClients(ctx.env.svc.db, 0);
      assert.ok(getConnection(ctx.env.svc.db, ctx.originalId));
      assert.ok(
        all(ctx.env.svc.db, 'SELECT 1 FROM oauthClient WHERE clientId = ?', incoming).length,
        'pending incoming client is not expired',
      );
    } finally {
      await closeCtx(ctx);
    }
  });

  it('(b) a code exchange rebinds, new /mcp works, and old tokens are rejected', async () => {
    const ctx = await setupPostM15();
    try {
      const oldAccess = ctx.first.provider.tokens()!.access_token;
      const oldRefresh = ctx.first.provider.tokens()!.refresh_token!;
      const oldClient = ctx.first.provider.clientInformation()!.client_id;

      const started = await consentWithoutExchange(ctx);
      const connected = await exchangeAndConnect(started);
      const newId = connected.provider.clientInformation()!.client_id;

      const original = getConnection(ctx.env.svc.db, ctx.originalId)!;
      assert.equal(original.current_client_id, newId);
      assert.equal(getPendingBind(ctx.env.svc.db, ctx.originalId), undefined);
      const transfers = reauthTransfers(ctx.env.svc.db, ctx.originalId);
      assert.equal(transfers.length, 1, 'exactly one reauth transfer');
      assert.equal(transfers[0]!.to_client_id, newId);

      const tokens = connected.provider.tokens();
      assert.ok(tokens?.access_token);
      const claims = jwtClaims(tokens.access_token);
      assert.equal(claims.azp ?? claims.client_id, newId);
      const approvedSec = Math.floor(Date.parse(original.approved_at) / 1000);
      assert.ok(claims.iat >= approvedSec, `iat ${claims.iat} >= approved_at ${approvedSec}`);
      const access = checkAccess(ctx.env.svc.db, newId, claims.iat);
      assert.equal(access.ok, true, access.ok ? '' : access.reason);

      const startedCall = await call(connected.client, 'start', {});
      assert.ok(startedCall);

      assert.equal((await postMcpInitialize(ctx.env, oldAccess)).status, 401);
      assert.notEqual((await postRefresh(ctx.env, oldClient, oldRefresh)).status, 200);
      assert.equal(checkAccess(ctx.env.svc.db, oldClient, claims.iat).ok, false);

      const leftover = getConnection(ctx.env.svc.db, ctx.leftoverId)!;
      assert.equal(leftover.merged_into_client_id, ctx.originalId);
      const activeGrok = listConnections(ctx.env.svc.db).filter((c) => c.active && (c.name === 'Grok' || c.client_id === ctx.originalId));
      assert.equal(activeGrok.length, 1, 'no new Grok platform');
      assert.equal(activeGrok[0]!.client_id, ctx.originalId);

      await connected.client.close();
    } finally {
      await closeCtx(ctx);
    }
  });

  it('(c) two consents before any exchange produce exactly one rebind on the later exchange', async () => {
    const ctx = await setupPostM15();
    try {
      const oldAccess = ctx.first.provider.tokens()!.access_token;
      const oldRefresh = ctx.first.provider.tokens()!.refresh_token!;
      const oldClient = ctx.first.provider.clientInformation()!.client_id;

      const firstConsent = await consentWithoutExchange(ctx);
      const firstIncoming = firstConsent.provider.clientInformation()!.client_id;
      assert.equal(getPendingBind(ctx.env.svc.db, ctx.originalId)?.incoming_client_id, firstIncoming);
      assert.equal(getConnection(ctx.env.svc.db, ctx.originalId)!.current_client_id, ctx.originalId);
      assert.equal(reauthTransfers(ctx.env.svc.db, ctx.originalId).length, 0);

      const secondConsent = await consentWithoutExchange(ctx);
      const secondIncoming = secondConsent.provider.clientInformation()!.client_id;
      assert.notEqual(secondIncoming, firstIncoming);
      const pending = getPendingBind(ctx.env.svc.db, ctx.originalId);
      assert.equal(pending?.incoming_client_id, secondIncoming, 'the later consent replaces the pending bind');
      assert.equal(getConnection(ctx.env.svc.db, ctx.originalId)!.current_client_id, ctx.originalId);
      assert.equal(reauthTransfers(ctx.env.svc.db, ctx.originalId).length, 0, 'still no rebind before exchange');
      assert.equal((await postMcpInitialize(ctx.env, oldAccess)).status, 200, 'old access still works between consents');
      assert.equal((await postRefresh(ctx.env, oldClient, oldRefresh)).status, 200, 'old refresh still works between consents');

      const connected = await exchangeAndConnect(secondConsent);
      assert.equal(connected.provider.clientInformation()!.client_id, secondIncoming);
      const original = getConnection(ctx.env.svc.db, ctx.originalId)!;
      assert.equal(original.current_client_id, secondIncoming);
      const transfers = reauthTransfers(ctx.env.svc.db, ctx.originalId);
      assert.equal(transfers.length, 1, 'exactly one rebind');
      assert.equal(transfers[0]!.to_client_id, secondIncoming);
      assert.equal(getPendingBind(ctx.env.svc.db, ctx.originalId), undefined);
      assert.ok(await call(connected.client, 'start', {}));
      assert.equal((await postMcpInitialize(ctx.env, oldAccess)).status, 401);

      await connected.client.close();
    } finally {
      await closeCtx(ctx);
    }
  });

  it('two Approves of the same consent do not switch the client or drop the old tokens', async () => {
    const ctx = await setupPostM15();
    try {
      const oldAccess = ctx.first.provider.tokens()!.access_token;
      const oldRefresh = ctx.first.provider.tokens()!.refresh_token!;
      const oldClient = ctx.first.provider.clientInformation()!.client_id;

      const started = await consentWithoutExchange(ctx);
      const incoming = started.provider.clientInformation()!.client_id;
      const second = await ctx.owner.fetch('/api/owner/consent', {
        method: 'POST',
        json: { accept: true, name: 'Grok', oauth_query: started.oauthQuery, continue_client_id: ctx.originalId },
      });
      // A replay may succeed (replace the pending bind) or fail if the authorization
      // request was already used. Either way there must be no rebind and no dropped grants.
      assert.ok(second.status === 200 || second.status >= 400, `second Approve status ${second.status}`);
      assert.equal(getConnection(ctx.env.svc.db, ctx.originalId)!.current_client_id, ctx.originalId);
      assert.equal(reauthTransfers(ctx.env.svc.db, ctx.originalId).length, 0);
      const pending = getPendingBind(ctx.env.svc.db, ctx.originalId);
      assert.ok(pending);
      assert.equal(pending!.incoming_client_id, incoming);
      assert.equal((await postMcpInitialize(ctx.env, oldAccess)).status, 200);
      assert.equal((await postRefresh(ctx.env, oldClient, oldRefresh)).status, 200);
    } finally {
      await closeCtx(ctx);
    }
  });

  it('the full DCR → auto-continue → token → start path binds the new client to the original platform', async () => {
    const ctx = await setupPostM15();
    try {
      const incoming = grokProvider();
      const reconnect = await connectAgent(ctx.env, ctx.owner, 'Grok', incoming);
      const newId = incoming.clientInformation()!.client_id;
      assert.ok(newId);
      assert.notEqual(newId, ctx.originalId);
      assert.notEqual(newId, ctx.leftoverId);

      const tokens = incoming.tokens();
      assert.ok(tokens?.access_token, 'token exchange issues an access token');
      const claims = jwtClaims(tokens.access_token);
      assert.equal(claims.azp ?? claims.client_id, newId);

      const original = getConnection(ctx.env.svc.db, ctx.originalId)!;
      assert.equal(original.current_client_id, newId);
      assert.equal(getPendingBind(ctx.env.svc.db, ctx.originalId), undefined);
      assert.equal(reauthTransfers(ctx.env.svc.db, ctx.originalId).length, 1);
      const access = checkAccess(ctx.env.svc.db, newId, claims.iat);
      assert.equal(access.ok, true, access.ok ? '' : access.reason);

      const started = await call(reconnect.client, 'start', {});
      assert.ok(started);

      const leftover = getConnection(ctx.env.svc.db, ctx.leftoverId)!;
      assert.equal(leftover.merged_into_client_id, ctx.originalId);
      const activeGrok = listConnections(ctx.env.svc.db).filter((c) => c.active && (c.name === 'Grok' || c.client_id === ctx.originalId));
      assert.equal(activeGrok.length, 1, 'no new Grok platform');
      assert.equal(activeGrok[0]!.client_id, ctx.originalId);

      await reconnect.client.close();
    } finally {
      await closeCtx(ctx);
    }
  });
});
