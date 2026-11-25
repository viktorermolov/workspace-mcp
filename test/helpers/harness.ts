import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { Client, StreamableHTTPClientTransport, UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/client';
import type { ClientMetadataResourceFetch } from '@better-auth/oauth-provider';
import { issueCode } from '../../src/auth/setup.ts';
import { loadConfig, type Config } from '../../src/config.ts';
import { createService, type Service } from '../../src/service.ts';
import { setLogLevel } from '../../src/util/log.ts';
import { SoftAuthenticator } from './webauthn.ts';

/**
 * Test harness: a real service on a random loopback port, a cookie-keeping "browser", a soft
 * passkey authenticator, and a real MCP client that goes through discovery and OAuth.
 * No real tokens or personal data: everything is generated per test run.
 */

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

export interface TestEnv {
  svc: Service;
  config: Config;
  base: string;
  dataDir: string;
  close(): Promise<void>;
}

export async function startService(
  opts: { dataDir?: string; env?: Record<string, string>; cimdFetch?: ClientMetadataResourceFetch; fetchImpl?: typeof fetch; jobs?: boolean; port?: number; announceSetupCode?: boolean } = {},
): Promise<TestEnv> {
  const port = opts.port ?? (await freePort());
  const dataDir = opts.dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'wsmcp-test-'));
  const config = loadConfig({
    PUBLIC_URL: `http://localhost:${port}`,
    SECRET_KEY: Buffer.alloc(32, 3).toString('base64'),
    DATA_DIR: dataDir,
    HOST: '127.0.0.1',
    PORT: String(port),
    LOG_LEVEL: 'error',
    UI_DIR: path.join(dataDir, 'no-ui'),
    ...opts.env,
  });
  setLogLevel(config.logLevel);
  const svc = await createService(config, { jobs: opts.jobs ?? false, announceSetupCode: opts.announceSetupCode ?? false, cimdFetch: opts.cimdFetch, fetchImpl: opts.fetchImpl });
  await svc.listen();
  return {
    svc,
    config,
    base: config.publicUrl,
    dataDir,
    close: () => svc.close(),
  };
}

/** A minimal browser: keeps cookies, sends our Origin, never follows redirects on its own. */
export class Browser {
  base: string;
  cookies = new Map<string, string>();
  constructor(base: string) {
    this.base = base;
  }
  async fetch(pathOrUrl: string, init: RequestInit & { json?: unknown } = {}): Promise<Response> {
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : this.base + pathOrUrl;
    const headers = new Headers(init.headers);
    if (this.cookies.size) headers.set('cookie', [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '));
    let body = init.body;
    if (init.json !== undefined) {
      headers.set('content-type', 'application/json');
      body = JSON.stringify(init.json);
    }
    const method = init.method ?? (body ? 'POST' : 'GET');
    if (method !== 'GET') headers.set('origin', this.base);
    const res = await fetch(url, { ...init, method, headers, body, redirect: 'manual' });
    for (const sc of res.headers.getSetCookie()) {
      const [pair] = sc.split(';');
      const i = pair!.indexOf('=');
      const k = pair!.slice(0, i).trim();
      const v = pair!.slice(i + 1).trim();
      if (/max-age=0/i.test(sc) || v === '') this.cookies.delete(k);
      else this.cookies.set(k, v);
    }
    return res;
  }
  async json<T = any>(pathOrUrl: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
    const r = await this.fetch(pathOrUrl, init);
    const text = await r.text();
    if (!r.ok) throw new Error(`${init.method ?? 'GET'} ${pathOrUrl} -> ${r.status}: ${text.slice(0, 500)}`);
    return (text ? JSON.parse(text) : null) as T;
  }
}

/** Registers the owner passkey with a setup code (or recovery code), leaving the browser signed in. */
export async function registerOwner(env: TestEnv, browser = new Browser(env.base), authenticator?: SoftAuthenticator, purpose: 'setup' | 'recovery' = 'setup') {
  const auth = authenticator ?? new SoftAuthenticator(new URL(env.base).hostname, env.base);
  const { code } = issueCode(env.svc.db, purpose);
  const ctx = await browser.json<{ context: string }>('/api/setup/verify', { json: { code } });
  const options = await browser.json(`/api/auth/passkey/generate-register-options?context=${encodeURIComponent(ctx.context)}`);
  const response = auth.register(options);
  await browser.json('/api/auth/passkey/verify-registration', { json: { response, createSession: true } });
  return { browser, authenticator: auth };
}

/** Signs in with an existing passkey. */
export async function signIn(env: TestEnv, authenticator: SoftAuthenticator, browser = new Browser(env.base)) {
  const options = await browser.json('/api/auth/passkey/generate-authenticate-options');
  const response = authenticator.authenticate(options);
  await browser.json('/api/auth/passkey/verify-authentication', { json: { response } });
  return browser;
}

/** OAuth provider for the SDK client; the "redirect" is captured for the test to drive. */
export class TestOAuthProvider implements OAuthClientProvider {
  redirect = 'http://127.0.0.1:9/callback';
  pendingAuthorization: URL | null = null;
  private info: any;
  private tok: any;
  private verifier = '';
  clientMetadataUrl?: string;
  name: string;
  constructor(name = 'Test agent', clientMetadataUrl?: string) {
    this.name = name;
    this.clientMetadataUrl = clientMetadataUrl;
  }
  get redirectUrl() {
    return this.redirect;
  }
  get clientMetadata() {
    return { client_name: this.name, redirect_uris: [this.redirect], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' };
  }
  clientInformation() {
    return this.info;
  }
  saveClientInformation(i: any) {
    this.info = i;
  }
  tokens() {
    return this.tok;
  }
  saveTokens(t: any) {
    this.tok = t;
  }
  redirectToAuthorization(u: URL) {
    this.pendingAuthorization = u;
  }
  saveCodeVerifier(v: string) {
    this.verifier = v;
  }
  codeVerifier() {
    return this.verifier;
  }
  private discovery: any;
  saveDiscoveryState(d: any) {
    this.discovery = d;
  }
  discoveryState() {
    return this.discovery;
  }
  /** Client registration and tokens, for a later process (the deployment smoke test). */
  export(): unknown {
    return { info: this.info, tok: this.tok };
  }
  static import(name: string, data: unknown): TestOAuthProvider {
    const p = new TestOAuthProvider(name);
    const d = data as { info: unknown; tok: unknown };
    p.info = d.info;
    p.tok = d.tok;
    return p;
  }
  invalidateCredentials(scope: string) {
    if (scope === 'all' || scope === 'discovery') this.discovery = undefined;
    if (scope === 'all' || scope === 'tokens') this.tok = undefined;
    if (scope === 'all' || scope === 'client') this.info = undefined;
  }
}

/** Follows the authorization URL as the signed-in owner, approves on the consent page, returns the callback. */
export async function approveInBrowser(browser: Browser, authorizationUrl: URL, connectionName: string): Promise<URL> {
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
  let r = await browser.fetch(authorizationUrl.toString(), nav);
  let loc = await next(r);
  for (let i = 0; i < 5 && loc && !new URL(loc, browser.base).pathname.startsWith('/consent') && !loc.startsWith('http://127.0.0.1:9/'); i++) {
    r = await browser.fetch(new URL(loc, browser.base).toString(), nav);
    loc = await next(r);
  }
  if (!loc) throw new Error(`authorize did not redirect: ${r.status} ${await r.text()}`);
  const target = new URL(loc, browser.base);
  if (target.pathname.startsWith('/consent')) {
    const oauthQuery = target.search.slice(1);
    const out = await browser.json<{ url: string }>('/api/owner/consent', { json: { accept: true, name: connectionName, oauth_query: oauthQuery } });
    return new URL(out.url);
  }
  return target;
}

/** Connects an MCP client through the full discovery + OAuth flow. */
export async function connectAgent(env: TestEnv, owner: Browser, name: string, provider = new TestOAuthProvider(name)) {
  const url = new URL(env.config.mcpUrl);
  let transport = new StreamableHTTPClientTransport(url, { authProvider: provider });
  let client = new Client({ name: 'test-agent', version: '1.0.0' });
  try {
    await client.connect(transport);
    return { client, provider };
  } catch (e) {
    if (!(e instanceof UnauthorizedError) || !provider.pendingAuthorization) throw e;
  }
  const callback = await approveInBrowser(owner, provider.pendingAuthorization!, name);
  provider.pendingAuthorization = null;
  await transport.finishAuth(callback.searchParams);
  transport = new StreamableHTTPClientTransport(url, { authProvider: provider });
  client = new Client({ name: 'test-agent', version: '1.0.0' });
  await client.connect(transport);
  return { client, provider };
}

/** Calls a tool and parses its JSON text result. Throws with the error text when isError is set. */
export async function call<T = any>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const r = (await client.callTool({ name, arguments: args })) as { content: { type: string; text: string }[]; isError?: boolean };
  const text = r.content.map((c) => c.text).join('');
  if (r.isError) throw new ToolError(text);
  return JSON.parse(text) as T;
}

export class ToolError extends Error {}

export function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}
