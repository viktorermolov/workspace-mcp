import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { CLIENT_IP_HEADER, type Auth } from '../auth/auth.ts';
import { approveConnection, clientInfo, getConnection, listConnections, listUnapprovedClients, renameConnection, revokeConnection } from '../auth/connections.ts';
import { listDiag, recordDiag } from '../auth/diagnostics.ts';
import { issueCode } from '../auth/setup.ts';
import type { Config } from '../config.ts';
import { all, get, now, run, type DB } from '../db/db.ts';
import { setConnectionRoles, setEnforcement, setRoleEditAny, workspaceAccessSettings } from '../domain/access.ts';
import { DomainError, getVersion, LIMITS, recordEvent, type Actor, type VersionedType } from '../domain/core.ts';
import { memberByUser, purge, saveDocument, saveProject, saveRole, setArchived, updateRules, type ArchivableType } from '../domain/entities.ts';
import { saveRoutine } from '../domain/routines.ts';
import { claimTask, commentTask, saveTask } from '../domain/tasks.ts';
import { compareVersions, rollback, versionedId, versionHistory } from '../domain/versions.ts';
import { changes, ENTITY_TYPES, getEntity, search, type EntityType } from '../domain/views.ts';
import { log } from '../util/log.ts';
import { changeFeed, mapView, taskTree } from './owner-views.ts';
import { createBackup, listBackups, backupPath, pruneBackups } from '../backup/backup.ts';
import { buildExport, importExport, isWorkspaceEmpty } from '../backup/export.ts';
import type { GithubSync } from '../github/sync.ts';
import type { WebhookDispatcher } from '../webhooks/dispatcher.ts';
import fs from 'node:fs';

export interface OwnerApiDeps {
  config: Config;
  db: DB;
  auth: Auth;
  version: string;
  webhooks: WebhookDispatcher;
  github: GithubSync;
  clientIp: (c: Context) => string;
}

const MAX_IMPORT_BYTES = 100 * 1024 * 1024;

type Env = { Variables: { actor: Actor; userId: string } };

const VERSIONED: VersionedType[] = ['rules', 'role', 'project', 'document'];
const ARCHIVABLE: ArchivableType[] = ['role', 'project', 'document', 'task', 'routine'];

export function createOwnerApi(deps: OwnerApiDeps) {
  const { config, db, auth } = deps;
  const api = new Hono<Env>();
  const origin = new URL(config.publicUrl).origin;

  const smallBody = bodyLimit({ maxSize: 2 * 1024 * 1024, onError: (c) => c.json({ error: 'limit', message: 'Request too large' }, 413, { connection: 'close' }) });
  const importBody = bodyLimit({ maxSize: MAX_IMPORT_BYTES, onError: (c) => c.json({ error: 'limit', message: 'Export file is larger than 100 MB' }, 413, { connection: 'close' }) });
  api.use('*', (c, next) => (c.req.path.endsWith('/import') ? importBody(c, next) : smallBody(c, next)));

  // Session + CSRF: every call needs the owner's session cookie; mutations must come from our own origin.
  api.use('*', async (c, next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      const o = c.req.header('origin');
      if (o ? o !== origin : c.req.header('sec-fetch-site') !== 'same-origin') return c.json({ error: 'forbidden', message: 'Cross-origin request' }, 403);
    }
    const session = await auth.api.getSession({ headers: c.req.raw.headers }).catch(() => null);
    const member = session?.user?.id ? memberByUser(db, session.user.id) : undefined;
    if (!session || !member) return c.json({ error: 'unauthorized', message: 'Sign in with your passkey' }, 401);
    c.set('actor', { kind: 'owner', memberId: member.id });
    c.set('userId', session.user.id);
    await next();
    c.header('cache-control', 'no-store');
  });

  api.onError((err, c) => {
    if (err instanceof DomainError) {
      const status = err.code === 'not_found' ? 404 : err.code === 'conflict' ? 409 : err.code === 'forbidden' ? 403 : 400;
      return c.json({ error: err.code, message: err.message, ...(err.details ?? {}) }, status);
    }
    if (err instanceof SyntaxError) return c.json({ error: 'invalid', message: 'Malformed JSON' }, 400);
    log.error('owner api error', { path: c.req.path, error: err.message });
    return c.json({ error: 'internal', message: 'Internal error' }, 500);
  });

  const body = async <T = Record<string, unknown>>(c: Context): Promise<T> => (await c.req.json()) as T;
  const actor = (c: Context<Env>) => c.get('actor');

  // ---------- session ----------
  api.get('/me', (c) => {
    const m = get<{ last_review_event_id: number; last_visit_at: string | null; name: string }>(db, 'SELECT * FROM member WHERE id = ?', actor(c).memberId)!;
    return c.json({ member_id: actor(c).memberId, name: m.name, last_review_event_id: m.last_review_event_id, last_visit_at: m.last_visit_at, version: deps.version, public_url: config.publicUrl, mcp_url: config.mcpUrl, source_url: config.sourceUrl });
  });
  api.post('/visit', (c) => {
    run(db, 'UPDATE member SET last_visit_at = ? WHERE id = ?', now(), actor(c).memberId);
    return c.json({ ok: true });
  });

  // ---------- consent ----------
  api.get('/consent/client', (c) => {
    const id = c.req.query('client_id') ?? '';
    const info = clientInfo(db, id);
    if (!info) return c.json({ error: 'not_found', message: 'Unknown client' }, 404);
    return c.json({ client: info, connection: getConnection(db, id) ?? null });
  });
  api.post('/consent', async (c) => {
    const b = await body<{ oauth_query?: string; accept?: boolean; name?: string }>(c);
    if (typeof b.oauth_query !== 'string' || b.oauth_query.length > 8000) throw new DomainError('invalid', 'oauth_query is required');
    const clientId = new URLSearchParams(b.oauth_query).get('client_id');
    if (!clientId) throw new DomainError('invalid', 'oauth_query has no client_id');
    if (b.accept && !(typeof b.name === 'string' && b.name.trim())) throw new DomainError('invalid', 'Name the connection');
    const res = await auth.handler(
      new Request(`${config.publicUrl}/api/auth/oauth2/consent`, {
        method: 'POST',
        headers: { cookie: c.req.header('cookie') ?? '', 'content-type': 'application/json', origin, [CLIENT_IP_HEADER]: deps.clientIp(c) },
        body: JSON.stringify({ accept: !!b.accept, oauth_query: b.oauth_query }),
      }),
    );
    const out = (await res.json().catch(() => ({}))) as { url?: string; redirect?: boolean; error?: string; error_description?: string; message?: string };
    recordDiag(db, { step: 'consent', client_id: clientId, method: 'POST', path: '/oauth2/consent', status: res.status, outcome: res.ok && out.url ? 'ok' : 'error', detail: res.ok ? { accepted: !!b.accept } : { error: out.error ?? null } });
    if (!res.ok || !out.url) {
      return c.json({ error: out.error ?? 'consent_failed', message: out.error_description ?? out.message ?? 'The authorization request is invalid or expired. Start the connection again from the platform.' }, 400);
    }
    if (b.accept) approveConnection(db, actor(c), clientId, b.name!);
    return c.json({ url: out.url });
  });

  // ---------- connections ----------
  api.get('/connections', (c) =>
    c.json({
      connections: listConnections(db),
      pending_clients: listUnapprovedClients(db),
      ...workspaceAccessSettings(db, actor(c).memberId),
    }),
  );
  api.post('/connections/:id/roles', async (c) => {
    const b = await body<{ roles?: unknown; confirm?: boolean }>(c);
    const roles = Array.isArray(b.roles) ? b.roles.map((r) => String(r)) : null;
    if (!roles) throw new DomainError('invalid', 'roles must be an array of role slugs or ids');
    setConnectionRoles(db, actor(c), c.req.param('id'), roles, b.confirm !== false);
    return c.json({ ok: true, ...workspaceAccessSettings(db, actor(c).memberId), connection: { client_id: c.req.param('id'), ...listConnections(db).find((x) => x.client_id === c.req.param('id')) } });
  });
  api.post('/settings/role-enforcement', async (c) => {
    const b = await body<{ mode?: string; override?: boolean }>(c);
    const mode = b.mode === 'enforce' ? 'enforce' : b.mode === 'warn' ? 'warn' : null;
    if (!mode) throw new DomainError('invalid', 'mode must be warn or enforce');
    const out = setEnforcement(db, actor(c), mode, { override: !!b.override });
    return c.json({ ok: true, ...out, ...workspaceAccessSettings(db, actor(c).memberId) });
  });
  api.post('/roles/:id/edit-any', async (c) => {
    const b = await body<{ edit_any?: boolean }>(c);
    if (typeof b.edit_any !== 'boolean') throw new DomainError('invalid', 'edit_any must be a boolean');
    setRoleEditAny(db, actor(c), c.req.param('id'), b.edit_any);
    return c.json({ ok: true, ...workspaceAccessSettings(db, actor(c).memberId) });
  });
  api.post('/connections/:id/revoke', (c) => c.json({ revoked: revokeConnection(db, actor(c), c.req.param('id')) }));
  api.post('/connections/:id/rename', async (c) => {
    const b = await body<{ name?: string }>(c);
    if (typeof b.name !== 'string' || !b.name.trim()) throw new DomainError('invalid', 'name is required');
    renameConnection(db, c.req.param('id'), b.name);
    return c.json({ ok: true });
  });
  api.get('/diagnostics', (c) => c.json({ entries: listDiag(db, { client_id: c.req.query('client_id') || undefined, limit: Number(c.req.query('limit') ?? 200) }) }));
  /** Manual OAuth client (for platforms that need a predefined client id/secret). The secret is shown once. */
  api.post('/clients', async (c) => {
    const b = await body<{ name?: string; redirect_uris?: string[]; confidential?: boolean }>(c);
    if (typeof b.name !== 'string' || !b.name.trim() || b.name.length > 200) throw new DomainError('invalid', 'name is required');
    const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris.map((u) => String(u).trim()).filter(Boolean) : [];
    if (!uris.length || uris.length > 10) throw new DomainError('invalid', 'Give 1 to 10 redirect URLs');
    for (const u of uris) {
      let p: URL;
      try {
        p = new URL(u);
      } catch {
        throw new DomainError('invalid', `Not a URL: ${u}`);
      }
      const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(p.hostname);
      if (p.protocol !== 'https:' && !(p.protocol === 'http:' && loopback)) throw new DomainError('invalid', `Redirect URLs must use https: ${u}`);
    }
    const created = (await auth.api.createOAuthClient({
      headers: c.req.raw.headers,
      body: {
        client_name: b.name.trim(),
        redirect_uris: uris,
        token_endpoint_auth_method: b.confidential === false ? 'none' : 'client_secret_post',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      },
    })) as { client_id: string; client_secret?: string };
    return c.json({ client_id: created.client_id, client_secret: created.client_secret ?? null, token_endpoint_auth_method: b.confidential === false ? 'none' : 'client_secret_post' });
  });
  api.delete('/clients/:id', async (c) => {
    const id = c.req.param('id');
    const conn = getConnection(db, id);
    if (conn && !conn.revoked_at) throw new DomainError('invalid', 'Revoke the connection first');
    await auth.api.deleteOAuthClient({ headers: c.req.raw.headers, body: { client_id: id } });
    return c.json({ ok: true });
  });

  // ---------- passkeys ----------
  api.get('/passkeys', (c) =>
    c.json({ passkeys: all(db, 'SELECT id, name, deviceType, backedUp, createdAt FROM passkey WHERE userId = ? ORDER BY createdAt', c.get('userId')) }),
  );
  api.delete('/passkeys/:id', (c) => {
    const n = get<{ n: number }>(db, 'SELECT count(*) AS n FROM passkey WHERE userId = ?', c.get('userId'))!.n;
    if (n <= 1) throw new DomainError('invalid', 'You cannot delete your only passkey. Add another one first.');
    run(db, 'DELETE FROM passkey WHERE id = ? AND userId = ?', c.req.param('id'), c.get('userId'));
    return c.json({ ok: true });
  });
  /** A one-time code for adding a passkey on another device (the same flow as recovery). */
  api.post('/passkeys/code', (c) => {
    const { code, expiresAt } = issueCode(db, 'recovery');
    recordEvent(db, actor(c), 'passkey', null, 'passkey.code_issued', 'One-time code for a new passkey issued');
    return c.json({ code, expires_at: expiresAt, setup_url: `${config.publicUrl}/setup` });
  });
  api.post('/passkeys/:id/rename', async (c) => {
    const b = await body<{ name?: string }>(c);
    run(db, 'UPDATE passkey SET name = ? WHERE id = ? AND userId = ?', String(b.name ?? '').slice(0, 100), c.req.param('id'), c.get('userId'));
    return c.json({ ok: true });
  });

  // ---------- workspace: read ----------
  /** Names for pickers in the interface: active roles and projects. */
  api.get('/choices', (c) =>
    c.json({
      roles: all(db, 'SELECT slug, name FROM role WHERE member_id = ? AND archived_at IS NULL ORDER BY name', actor(c).memberId),
      projects: all(db, 'SELECT slug, name FROM project WHERE member_id = ? AND archived_at IS NULL ORDER BY name', actor(c).memberId),
    }),
  );
  api.get('/map', (c) => c.json(mapView(db, actor(c).memberId)));
  api.get('/tasks', (c) =>
    c.json(taskTree(db, actor(c).memberId, { project: c.req.query('project') || undefined, role: c.req.query('role') || undefined, status: c.req.queries('status') ?? undefined, include_archived: c.req.query('archived') === '1' })),
  );
  api.get('/entity/:type/:id?', (c) => {
    const type = c.req.param('type') as EntityType;
    if (!ENTITY_TYPES.includes(type)) throw new DomainError('invalid', 'unknown type');
    return c.json(getEntity(db, actor(c).memberId, type, c.req.param('id'), { cursor: c.req.query('cursor') || undefined }));
  });
  api.get('/search', (c) =>
    c.json(
      search(db, actor(c).memberId, {
        query: c.req.query('q') || undefined,
        types: c.req.queries('type')?.filter(Boolean),
        status: c.req.queries('status') ?? undefined,
        role: c.req.query('role') || undefined,
        project: c.req.query('project') || undefined,
        include_archived: c.req.query('archived') === '1',
        limit: Math.min(Number(c.req.query('limit') ?? 50) || 50, LIMITS.listMax),
        cursor: c.req.query('cursor') || undefined,
      }),
    ),
  );
  api.get('/log', (c) =>
    c.json(changes(db, actor(c).memberId, { cursor: Number(c.req.query('cursor') ?? 0) || 0, limit: Number(c.req.query('limit') ?? 100) || 100, entity_type: c.req.query('entity_type') || undefined, entity_id: c.req.query('entity_id') || undefined })),
  );
  api.get('/log/latest', (c) => {
    const limit = Math.min(Number(c.req.query('limit') ?? 100) || 100, 200);
    const before = Number(c.req.query('before') ?? 0) || Number.MAX_SAFE_INTEGER;
    return c.json({ events: all(db, "SELECT id, at, actor_kind, connection_name, claimed_role, json_extract(data, '$.owner_role') AS owner_role, entity_type, entity_id, action, summary FROM event WHERE member_id = ? AND id < ? ORDER BY id DESC LIMIT ?", actor(c).memberId, before, limit) });
  });
  api.get('/changes', (c) => c.json(changeFeed(db, actor(c).memberId)));
  api.post('/changes/reviewed', async (c) => {
    const b = await body<{ up_to?: number }>(c);
    const upTo = Number(b.up_to);
    if (!Number.isInteger(upTo) || upTo < 0) throw new DomainError('invalid', 'up_to must be an event id');
    run(db, 'UPDATE member SET last_review_event_id = max(last_review_event_id, ?) WHERE id = ?', upTo, actor(c).memberId);
    return c.json({ ok: true });
  });

  // ---------- versions ----------
  const versionedType = (t: string): VersionedType => {
    if (!VERSIONED.includes(t as VersionedType)) throw new DomainError('invalid', 'unknown versioned type');
    return t as VersionedType;
  };
  api.get('/versions/:type/:id?', (c) => c.json({ versions: versionHistory(db, actor(c).memberId, versionedType(c.req.param('type')), c.req.param('id'), 200) }));
  api.get('/compare/:type/:id?', (c) =>
    c.json(compareVersions(db, actor(c).memberId, versionedType(c.req.param('type')), c.req.param('id'), Number(c.req.query('from') ?? 0), Number(c.req.query('to')), Number(c.req.query('context') ?? 3))),
  );
  api.get('/version/:type/:id?', (c) => {
    const type = versionedType(c.req.param('type'));
    const v = getVersion(db, type, versionedId(db, actor(c).memberId, type, c.req.param('id')), Number(c.req.query('number')));
    return c.json({ type, number: v.number, body: v.body, note: v.note, created_at: v.created_at });
  });
  api.post('/rollback', async (c) => {
    const b = await body<{ type: string; id?: string; to_version: number; rev?: number }>(c);
    return c.json(rollback(db, actor(c), versionedType(b.type), b.id, Number(b.to_version), b.rev, undefined));
  });

  // ---------- workspace: write (owner edits) ----------
  api.post('/rules', async (c) => c.json(updateRules(db, actor(c), await body(c))));
  api.post('/roles', async (c) => c.json(saveRole(db, actor(c), await body(c))));
  api.post('/projects', async (c) => c.json(saveProject(db, actor(c), await body(c))));
  api.post('/documents', async (c) => c.json(saveDocument(db, actor(c), await body(c))));
  api.post('/tasks', async (c) => c.json(saveTask(db, actor(c), await body(c))));
  api.post('/routines', async (c) => c.json(saveRoutine(db, actor(c), await body(c))));
  api.post('/tasks/:id/claim', async (c) => c.json(claimTask(db, actor(c), { id: c.req.param('id'), role: (await body<{ role?: string }>(c).catch(() => ({}) as { role?: string })).role })));
  api.post('/tasks/:id/comment', async (c) => c.json(commentTask(db, actor(c), { id: c.req.param('id'), body: String((await body<{ body?: string }>(c)).body ?? '') })));
  api.post('/archive', async (c) => {
    const b = await body<{ type: ArchivableType; id: string; restore?: boolean }>(c);
    if (!ARCHIVABLE.includes(b.type)) throw new DomainError('invalid', 'unknown type');
    return c.json(setArchived(db, actor(c), b.type, String(b.id), !b.restore));
  });
  api.post('/purge', async (c) => {
    const b = await body<{ type: ArchivableType; id: string }>(c);
    if (!ARCHIVABLE.includes(b.type)) throw new DomainError('invalid', 'unknown type');
    return c.json(purge(db, actor(c), b.type, String(b.id)));
  });

  // ---------- GitHub issues mirror ----------
  const { github, webhooks } = deps;
  api.get('/github', (c) => c.json(github.status(actor(c).memberId)));
  api.post('/github/token', async (c) => c.json(await github.connect(actor(c), String((await body<{ token?: string }>(c)).token ?? ''))));
  api.delete('/github', (c) => {
    github.disconnect(actor(c));
    return c.json({ ok: true });
  });
  api.get('/github/available', async (c) => c.json({ repos: await github.availableRepos(actor(c).memberId) }));
  api.post('/github/repos', async (c) => {
    const b = await body<{ full_name?: string; project?: string | null; default_role?: string | null; assigners?: string[] }>(c);
    const opts: { project?: string | null; default_role?: string | null; assigners?: string[] } = { default_role: b.default_role, assigners: b.assigners };
    if (Object.prototype.hasOwnProperty.call(b, 'project')) opts.project = b.project || null;
    const id = github.addRepo(actor(c), String(b.full_name ?? ''), opts);
    return c.json({ id, status: github.status(actor(c).memberId) });
  });
  api.post('/github/repos/:id', async (c) => {
    const b = await body<{ project?: string | null; default_role?: string | null; assigners?: string[] }>(c);
    github.updateRepo(actor(c), Number(c.req.param('id')), b);
    return c.json({ ok: true, status: github.status(actor(c).memberId) });
  });
  api.delete('/github/repos/:id', (c) => {
    github.removeRepo(actor(c), Number(c.req.param('id')));
    return c.json({ ok: true });
  });
  api.post('/github/sync', async (c) => c.json(await github.sync(actor(c).memberId)));
  api.post('/issues/:id/role', async (c) => {
    github.setIssueRole(actor(c), c.req.param('id'), (await body<{ role?: string | null }>(c)).role || null);
    return c.json({ ok: true });
  });

  // ---------- webhooks ----------
  api.get('/webhooks', (c) => c.json({ webhooks: webhooks.list(actor(c).memberId) }));
  api.post('/webhooks', async (c) => c.json(webhooks.save(actor(c), await body(c))));
  api.delete('/webhooks/:id', (c) => {
    webhooks.remove(actor(c), c.req.param('id'));
    return c.json({ ok: true });
  });
  api.get('/webhooks/:id/secret', (c) => c.json({ signing_secret: webhooks.signingSecret(actor(c).memberId, c.req.param('id')) }));
  api.post('/webhooks/:id/test', (c) => c.json({ delivery_id: webhooks.test(actor(c).memberId, c.req.param('id')) }));
  api.get('/webhooks/:id/deliveries', (c) => c.json({ deliveries: webhooks.deliveries(actor(c).memberId, c.req.param('id'), Number(c.req.query('limit') ?? 50)) }));

  // ---------- backups, export, import ----------
  api.get('/backups', (c) => c.json({ backups: listBackups(config), interval_hours: config.backupIntervalHours, keep: config.backupKeep }));
  api.post('/backups', async (c) => {
    const file = await createBackup(db, config, 'manual');
    pruneBackups(config);
    return c.json({ name: file.split('/').pop() });
  });
  api.get('/backups/:name/download', (c) => {
    let p: string;
    try {
      p = backupPath(config, c.req.param('name'));
    } catch (e) {
      throw new DomainError('not_found', (e as Error).message);
    }
    c.header('content-type', 'application/vnd.sqlite3');
    c.header('content-disposition', `attachment; filename="${c.req.param('name')}"`);
    return c.body(fs.readFileSync(p));
  });
  api.get('/export', (c) => {
    const { zip } = buildExport(db, actor(c).memberId);
    const name = `workspace-export-${new Date().toISOString().slice(0, 10)}.zip`;
    c.header('content-type', 'application/zip');
    c.header('content-disposition', `attachment; filename="${name}"`);
    return c.body(zip as Uint8Array<ArrayBuffer>);
  });
  api.get('/import', (c) => c.json({ empty: isWorkspaceEmpty(db, actor(c).memberId) }));
  api.post('/import', async (c) => {
    const buf = new Uint8Array(await c.req.arrayBuffer());
    if (!isWorkspaceEmpty(db, actor(c).memberId)) throw new DomainError('conflict', 'Import only goes into an empty workspace.');
    await createBackup(db, config, 'pre-import');
    return c.json(importExport(db, actor(c).memberId, buf));
  });

  return api;
}
