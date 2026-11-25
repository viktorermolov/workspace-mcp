import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getConnInfo } from '@hono/node-server/conninfo';
import { serveStatic } from '@hono/node-server/serve-static';
import { CLIENT_IP_HEADER, type Auth } from '../auth/auth.ts';
import { classifyAuthPath, recordDiag, safeParams } from '../auth/diagnostics.ts';
import { hasOwner, verifyCode } from '../auth/setup.ts';
import type { Config } from '../config.ts';
import type { DB } from '../db/db.ts';
import { createMcpEndpoint } from '../mcp/endpoint.ts';
import { log } from '../util/log.ts';
import { RateLimiter } from '../util/ratelimit.ts';
import { createOwnerApi, type OwnerApiDeps } from './owner-api.ts';

export interface AppDeps extends Omit<OwnerApiDeps, 'clientIp'> {
  config: Config;
  db: DB;
  auth: Auth;
  version: string;
}

export function clientIpOf(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    const cf = c.req.header('cf-connecting-ip');
    if (cf) return cf.trim();
    // The entry added by the one trusted proxy in front of the service is the last one; earlier
    // entries come from the client and can be forged.
    const xff = c.req.header('x-forwarded-for');
    if (xff) return xff.split(',').at(-1)!.trim();
  }
  try {
    return getConnInfo(c).remote.address ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export function createApp(deps: AppDeps) {
  const { config, db, auth, version } = deps;
  const app = new Hono();
  const mcp = createMcpEndpoint({ config, db, auth, version });
  const mcpLimiter = new RateLimiter(600, 60_000);
  const setupLimiter = new RateLimiter(10, 60_000);
  const authOrigin = new URL(config.publicUrl).origin;

  app.use('*', async (c, next) => {
    await next();
    const h = c.res.headers;
    h.set('x-content-type-options', 'nosniff');
    h.set('referrer-policy', 'no-referrer');
    h.set('x-frame-options', 'DENY');
    h.set('cross-origin-opener-policy', 'same-origin');
    h.set('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    if (!h.has('content-security-policy')) h.set('content-security-policy', CSP);
    if (config.publicUrl.startsWith('https://')) h.set('strict-transport-security', 'max-age=31536000');
  });

  app.onError((err, c) => {
    log.error('unhandled request error', { path: c.req.path, error: err.message });
    return c.json({ error: 'internal', message: 'Internal error' }, 500);
  });

  app.get('/healthz', (c) => c.json({ status: 'ok', version }));

  // ---------- OAuth discovery (served at the root as clients expect) ----------
  const forwardAuth = (target: string) => async (c: Context) => {
    const headers = new Headers(c.req.raw.headers);
    headers.set(CLIENT_IP_HEADER, clientIpOf(c, config.trustProxy));
    const res = await auth.handler(new Request(`${config.publicUrl}${target}`, { headers }));
    recordDiag(db, { step: 'discovery', method: 'GET', path: c.req.path, status: res.status, outcome: res.ok ? 'ok' : 'error' });
    return withCors(res);
  };
  for (const p of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
    app.get(p, forwardAuth('/.well-known/oauth-protected-resource/mcp'));
  }
  for (const p of ['/.well-known/oauth-authorization-server', '/.well-known/oauth-authorization-server/api/auth']) {
    app.get(p, forwardAuth('/api/auth/.well-known/oauth-authorization-server'));
  }
  for (const p of ['/.well-known/openid-configuration', '/.well-known/openid-configuration/api/auth', '/api/auth/.well-known/openid-configuration']) {
    app.get(p, forwardAuth('/api/auth/.well-known/openid-configuration'));
  }
  app.on('OPTIONS', '/.well-known/*', () => withCors(new Response(null, { status: 204 })));

  // ---------- OAuth server and passkey endpoints ----------
  // OAuth and WebAuthn requests are small. The limit applies before anything reads the body.
  app.use('/api/auth/*', bodyLimit({ maxSize: AUTH_BODY_MAX, onError: (c) => c.json({ error: 'invalid_request', error_description: 'Request too large' }, 413, { connection: 'close' }) }));
  app.on(['GET', 'POST', 'OPTIONS'], '/api/auth/*', async (c) => {
    const headers = new Headers(c.req.raw.headers);
    headers.set(CLIENT_IP_HEADER, clientIpOf(c, config.trustProxy));
    let req = new Request(c.req.raw, { headers });
    const url = new URL(req.url);
    const step = classifyAuthPath(url.pathname);
    let form: URLSearchParams | Record<string, unknown> | null = null;
    if (step && req.method === 'POST') {
      try {
        const ct = req.headers.get('content-type') ?? '';
        const clone = req.clone();
        form = ct.includes('json') ? ((await clone.json()) as Record<string, unknown>) : new URLSearchParams(await clone.text());
      } catch {
        form = null;
      }
    }
    if (step === 'registration' && form && !(form instanceof URLSearchParams) && withNativeApplicationType(form)) {
      headers.delete('content-length');
      req = new Request(req.url, { method: 'POST', headers, body: JSON.stringify(form) });
    }
    const res = await auth.handler(req);
    if (step) await diagAuth(db, step, req, url, form, res);
    return res;
  });

  // ---------- first-time setup and recovery (local codes) ----------
  app.get('/api/setup/state', (c) => c.json({ has_owner: hasOwner(db) }));
  app.post('/api/setup/verify', bodyLimit({ maxSize: 4096 }), async (c) => {
    if (!sameOrigin(c, authOrigin)) return c.json({ error: 'forbidden', message: 'Cross-origin request' }, 403);
    const wait = setupLimiter.take(clientIpOf(c, config.trustProxy));
    if (wait) return c.json({ error: 'rate_limited', message: `Too many attempts. Try again in ${wait} s.` }, 429);
    const body = (await c.req.json().catch(() => ({}))) as { code?: unknown };
    if (typeof body.code !== 'string' || body.code.length > 64) return c.json({ error: 'invalid', message: 'Enter the code' }, 400);
    const r = verifyCode(db, config, body.code);
    if (!r) return c.json({ error: 'invalid', message: 'The code is wrong, expired or already used.' }, 400);
    log.info('setup code accepted', { purpose: r.purpose });
    return c.json(r);
  });

  // ---------- owner API (session-only, same-origin) ----------
  app.route('/api/owner', createOwnerApi({ ...deps, clientIp: (c) => clientIpOf(c, config.trustProxy) }));

  // ---------- MCP ----------
  const mcpBody = bodyLimit({ maxSize: 1024 * 1024, onError: (c) => c.json({ jsonrpc: '2.0', error: { code: -32600, message: 'Request too large' }, id: null }, 413, { connection: 'close' }) });
  app.all(
    '/mcp',
    async (c, next) => {
      const wait = mcpLimiter.take(clientIpOf(c, config.trustProxy));
      if (wait) return c.json({ jsonrpc: '2.0', error: { code: -32000, message: 'Rate limit exceeded' }, id: null }, 429, { 'retry-after': String(wait) });
      await next();
    },
    mcpBody,
    (c) => mcp.fetch(c.req.raw),
  );

  // ---------- web interface (static, SPA fallback) ----------
  const uiRoot = path.resolve(config.uiDir);
  if (existsSync(uiRoot)) {
    app.use('/assets/*', serveStatic({ root: uiRoot }));
    for (const f of ['/favicon.svg', '/manifest.webmanifest']) app.get(f, serveStatic({ root: uiRoot }));
  }
  app.get('*', async (c) => {
    if (c.req.path.startsWith('/api/') || c.req.path.startsWith('/.well-known/')) return c.json({ error: 'not_found' }, 404);
    try {
      const html = await readFile(path.join(uiRoot, 'index.html'), 'utf8');
      return c.html(html, 200, { 'cache-control': 'no-store' });
    } catch {
      return c.text('The web interface is not built. Run `npm run build:ui` (the Docker image does this).', 503);
    }
  });

  return { app, close: () => mcp.close() };
}

/** Largest accepted body for the OAuth and passkey endpoints. */
export const AUTH_BODY_MAX = 64 * 1024;

/**
 * Dynamic registration defaults `application_type` to "web", which forbids loopback redirects. Clients
 * that run on the user's machine (Claude Code, IDEs) redirect to a loopback port and some do not send
 * `application_type`. Like the MCP SDK (SEP-837), treat a registration whose redirect URIs are all
 * loopback http (the exact hosts the authorization server accepts for native clients: localhost,
 * 127.0.0.1, [::1]) or custom schemes as a native application (RFC 8252). Done here rather than with the
 * library's "infer" default, whose rules are not documented as a stable contract. Mutates `body`;
 * returns true if changed.
 */
export function withNativeApplicationType(body: Record<string, unknown>): boolean {
  if (body.application_type !== undefined) return false;
  const uris = body.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0) return false;
  const native = uris.every((raw) => {
    if (typeof raw !== 'string') return false;
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      return false;
    }
    if (u.protocol === 'https:') return false;
    if (u.protocol !== 'http:') return true;
    const host = u.hostname.replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '::1' || host === '127.0.0.1';
  });
  if (!native) return false;
  body.application_type = 'native';
  return true;
}

function withCors(res: Response): Response {
  const r = new Response(res.body, res);
  r.headers.set('access-control-allow-origin', '*');
  r.headers.set('access-control-allow-methods', 'GET, OPTIONS');
  r.headers.set('access-control-allow-headers', 'mcp-protocol-version, authorization, content-type');
  return r;
}

export function sameOrigin(c: Context, origin: string): boolean {
  const o = c.req.header('origin');
  if (o) return o === origin;
  const site = c.req.header('sec-fetch-site');
  return site === 'same-origin';
}

async function diagAuth(db: DB, step: ReturnType<typeof classifyAuthPath> & string, req: Request, url: URL, form: URLSearchParams | Record<string, unknown> | null, res: Response) {
  const detail: Record<string, unknown> = safeParams(url, form);
  let clientId = (detail.client_id as string | undefined) ?? null;
  if (step === 'registration' && form && !(form instanceof URLSearchParams)) {
    detail.client_name = typeof form.client_name === 'string' ? form.client_name.slice(0, 200) : undefined;
    detail.redirect_uris = Array.isArray(form.redirect_uris) ? form.redirect_uris.slice(0, 10).map(String) : undefined;
  }
  if (step === 'token') detail.grant_type = (form instanceof URLSearchParams ? form.get('grant_type') : undefined) ?? undefined;
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get('location');
    if (loc) {
      try {
        const l = new URL(loc, url);
        const err = l.searchParams.get('error');
        if (err) (detail.error = err), (detail.error_description = l.searchParams.get('error_description') ?? undefined);
        detail.redirect_to = l.pathname.startsWith('/') && l.origin === url.origin ? l.pathname : l.origin + l.pathname;
      } catch {
        /* ignore */
      }
    }
  }
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('json')) {
    try {
      const j = (await res.clone().json()) as Record<string, unknown>;
      if (typeof j.error === 'string') detail.error = j.error;
      if (typeof j.error_description === 'string') detail.error_description = j.error_description.slice(0, 300);
      if (typeof j.message === 'string' && res.status >= 400) detail.message = j.message.slice(0, 300);
      if (step === 'registration' && typeof j.client_id === 'string') clientId = j.client_id;
      if (step === 'consent' && typeof j.url === 'string') {
        const u = new URL(j.url, url);
        if (u.searchParams.get('error')) detail.error = u.searchParams.get('error');
      }
    } catch {
      /* ignore */
    }
  }
  const failed = res.status >= 400 || !!detail.error;
  recordDiag(db, { client_id: clientId, step, method: req.method, path: url.pathname, status: res.status, outcome: failed ? 'error' : 'ok', detail });
}
