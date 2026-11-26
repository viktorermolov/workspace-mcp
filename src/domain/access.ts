import { AsyncLocalStorage } from 'node:async_hooks';
import { recordDiag } from '../auth/diagnostics.ts';
import { all, get, now, run, tx, type DB } from '../db/db.ts';
import { DomainError, invalid, recordEvent, type Actor } from './core.ts';

export type Enforcement = 'warn' | 'enforce';

export interface RoleWarning {
  code: string;
  message: string;
}

export interface AllowedRole {
  id: string;
  slug: string;
  name: string;
  source: 'owner' | 'suggested';
}

const warningStore = new AsyncLocalStorage<{ items: RoleWarning[] }>();

/** Collects additive warnings attached to an MCP write (or start) response. */
export function runWithWarnings<T>(fn: () => T): { value: T; warnings: RoleWarning[] } {
  const store = { items: [] as RoleWarning[] };
  const value = warningStore.run(store, fn);
  return { value, warnings: store.items };
}

export function addWarning(w: RoleWarning): void {
  warningStore.getStore()?.items.push(w);
}

export function attachWarnings<T>(value: T, warnings: RoleWarning[]): T | (T & { warnings: RoleWarning[] }) | { result: T; warnings: RoleWarning[] } {
  if (warnings.length === 0) return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return { ...(value as Record<string, unknown>), warnings } as T & { warnings: RoleWarning[] };
  }
  return { result: value, warnings };
}

export function getEnforcement(db: DB, memberId: string): Enforcement {
  const v = get<{ role_enforcement: string }>(db, 'SELECT role_enforcement FROM member WHERE id = ?', memberId)?.role_enforcement;
  return v === 'enforce' ? 'enforce' : 'warn';
}

export function ownerSlug(db: DB, roleId: string | null | undefined): string | null {
  if (!roleId) return null;
  return get<{ slug: string }>(db, 'SELECT slug FROM role WHERE id = ?', roleId)?.slug ?? null;
}

/** Adds owner_role to event data when the item belongs to a role. */
export function withOwnerRole(db: DB, ownerRoleId: string | null | undefined, data: Record<string, unknown> = {}): Record<string, unknown> {
  const slug = ownerSlug(db, ownerRoleId);
  return slug ? { ...data, owner_role: slug } : data;
}

export function roleByRef(db: DB, memberId: string, ref: string, includeArchived = true) {
  return get<{ id: string; slug: string; name: string; archived_at: string | null; edit_any: number }>(
    db,
    `SELECT id, slug, name, archived_at, edit_any FROM role WHERE member_id = ? AND (id = ? OR slug = ?) ${includeArchived ? '' : 'AND archived_at IS NULL'}`,
    memberId,
    ref,
    ref,
  );
}

function connectionHasConfirmedList(db: DB, clientId: string): boolean {
  const c = get<{ roles_confirmed_at: string | null }>(db, 'SELECT roles_confirmed_at FROM connection WHERE client_id = ?', clientId);
  return !!c?.roles_confirmed_at;
}

/**
 * A role is allowed on a connection only after the owner has confirmed the list.
 * A prefilled (suggested) list is a draft and has no effect in enforce, and does
 * not count as allowed in warn either — it is only a suggestion for the owner.
 */
export function isRoleAllowedForConnection(db: DB, clientId: string, roleId: string): boolean {
  if (!connectionHasConfirmedList(db, clientId)) return false;
  return !!get(db, 'SELECT 1 FROM connection_role WHERE client_id = ? AND role_id = ?', clientId, roleId);
}

export function listConnectionRoles(db: DB, clientId: string): AllowedRole[] {
  return all<AllowedRole>(
    db,
    `SELECT r.id, r.slug, r.name, cr.source
     FROM connection_role cr JOIN role r ON r.id = cr.role_id
     WHERE cr.client_id = ? ORDER BY r.name`,
    clientId,
  );
}

function actorHasEditAny(db: DB, actor: Actor): boolean {
  if (actor.kind !== 'agent' || !actor.role) return false;
  const r = roleByRef(db, actor.memberId, actor.role);
  return !!r && !r.archived_at && r.edit_any === 1;
}

function auditRoleCheck(
  db: DB,
  actor: Actor,
  outcome: 'warning' | 'rejected' | 'override',
  detail: Record<string, unknown>,
  status = outcome === 'rejected' ? 403 : 200,
): void {
  recordDiag(db, {
    step: 'role_check',
    client_id: actor.connectionId ?? null,
    method: actor.kind === 'owner' ? 'OWNER' : 'MCP',
    path: actor.kind === 'owner' ? '/api/owner' : '/mcp',
    status,
    outcome,
    detail,
  });
}

const SYNONYM_WARNING =
  'Passing the role argument as the author (because claimed_role was omitted) is deprecated and will be removed in a later release. Pass claimed_role for the acting role. The role argument names the item (the task or checkpoint), not the author.';

/**
 * Resolves the acting role for an agent write. Owner and system actors are unchanged.
 * In warn mode, problems are returned as additive warnings and the write may proceed.
 * In enforce mode, missing claimed_role is invalid; any other failure is forbidden.
 */
export function resolveAgentActor(db: DB, actor: Actor, claimedRole: string | undefined, opts?: { synonym?: string }): Actor {
  if (actor.kind !== 'agent') return actor;

  let claimed = claimedRole?.trim() || undefined;
  let usedSynonym = false;
  if (!claimed && opts?.synonym?.trim()) {
    claimed = opts.synonym.trim();
    usedSynonym = true;
  }

  const mode = getEnforcement(db, actor.memberId);

  if (usedSynonym) {
    addWarning({ code: 'role_synonym_deprecated', message: SYNONYM_WARNING });
  }

  if (!claimed) {
    const message = 'claimed_role is required on writes: pass your role slug or id.';
    if (mode === 'enforce') throw invalid(message);
    addWarning({ code: 'claimed_role_missing', message });
    auditRoleCheck(db, actor, 'warning', { reason: 'claimed_role_missing' });
    return { ...actor, role: undefined };
  }

  const role = roleByRef(db, actor.memberId, claimed, true);
  if (!role) {
    const message = `role not found: ${claimed}`;
    if (mode === 'enforce') {
      auditRoleCheck(db, actor, 'rejected', { reason: 'role_not_found', claimed_role: claimed });
      throw new DomainError('forbidden', message);
    }
    addWarning({ code: 'role_not_found', message });
    auditRoleCheck(db, actor, 'warning', { reason: 'role_not_found', claimed_role: claimed });
    return { ...actor, role: claimed };
  }
  if (role.archived_at) {
    const message = `role "${role.slug}" is archived and cannot be used on a write`;
    if (mode === 'enforce') {
      auditRoleCheck(db, actor, 'rejected', { reason: 'role_archived', claimed_role: role.slug });
      throw new DomainError('forbidden', message);
    }
    addWarning({ code: 'role_archived', message });
    auditRoleCheck(db, actor, 'warning', { reason: 'role_archived', claimed_role: role.slug });
    return { ...actor, role: role.slug };
  }

  if (!actor.connectionId) {
    const message = 'this agent has no connection and cannot write under a role';
    if (mode === 'enforce') throw new DomainError('forbidden', message);
    addWarning({ code: 'no_connection', message });
    return { ...actor, role: role.slug };
  }

  if (!isRoleAllowedForConnection(db, actor.connectionId, role.id)) {
    const confirmed = connectionHasConfirmedList(db, actor.connectionId);
    const message = confirmed
      ? `role "${role.slug}" is not on this connection's confirmed allow-list`
      : `role "${role.slug}" is not on a confirmed allow-list for this connection (a suggested list, if any, has no effect until the owner confirms it)`;
    if (mode === 'enforce') {
      auditRoleCheck(db, actor, 'rejected', { reason: 'role_not_allowed', claimed_role: role.slug, list_confirmed: confirmed });
      throw new DomainError('forbidden', message);
    }
    addWarning({ code: 'role_not_allowed', message });
    auditRoleCheck(db, actor, 'warning', { reason: 'role_not_allowed', claimed_role: role.slug, list_confirmed: confirmed });
  }

  return { ...actor, role: role.slug };
}

/** For start: in enforce, the requested role must be on the confirmed list. */
export function assertStartRole(db: DB, actor: Actor, roleRef: string): void {
  if (actor.kind !== 'agent' || !actor.connectionId) return;
  const role = roleByRef(db, actor.memberId, roleRef, true);
  if (!role) return; // startView already handles unknown roles
  const mode = getEnforcement(db, actor.memberId);
  if (isRoleAllowedForConnection(db, actor.connectionId, role.id)) return;
  const confirmed = connectionHasConfirmedList(db, actor.connectionId);
  const message = confirmed
    ? `role "${role.slug}" is not on this connection's confirmed allow-list`
    : `role "${role.slug}" is not on a confirmed allow-list for this connection (a suggested list, if any, has no effect until the owner confirms it)`;
  if (mode === 'enforce') {
    auditRoleCheck(db, actor, 'rejected', { reason: 'start_role_not_allowed', claimed_role: role.slug, list_confirmed: confirmed });
    throw new DomainError('forbidden', message);
  }
  addWarning({ code: 'role_not_allowed', message });
  auditRoleCheck(db, actor, 'warning', { reason: 'start_role_not_allowed', claimed_role: role.slug, list_confirmed: confirmed });
}

export function assertCanEdit(
  db: DB,
  actor: Actor,
  ownerRoleId: string | null | undefined,
  opts?: { rules?: boolean; what?: string },
): void {
  if (actor.kind !== 'agent') return;
  const mode = getEnforcement(db, actor.memberId);

  if (opts?.rules) {
    if (actorHasEditAny(db, actor)) return;
    const message = 'working rules can only be changed by a role the owner has marked as allowed to edit any item, or by the owner';
    if (mode === 'enforce') {
      auditRoleCheck(db, actor, 'rejected', { reason: 'edit_rules', claimed_role: actor.role ?? null });
      throw new DomainError('forbidden', message);
    }
    addWarning({ code: 'edit_others', message });
    auditRoleCheck(db, actor, 'warning', { reason: 'edit_rules', claimed_role: actor.role ?? null });
    return;
  }

  if (!ownerRoleId) return;

  const acting = actor.role ? roleByRef(db, actor.memberId, actor.role) : undefined;
  if (acting && acting.id === ownerRoleId) return;
  if (actorHasEditAny(db, actor)) return;

  const owner = ownerSlug(db, ownerRoleId) ?? ownerRoleId;
  const what = opts?.what ?? 'item';
  const message = `this ${what} belongs to role "${owner}"; only that role, or a role the owner has marked as allowed to edit any item, may change it`;
  if (mode === 'enforce') {
    auditRoleCheck(db, actor, 'rejected', { reason: 'edit_others', claimed_role: actor.role ?? null, owner_role: owner });
    throw new DomainError('forbidden', message);
  }
  addWarning({ code: 'edit_others', message });
  auditRoleCheck(db, actor, 'warning', { reason: 'edit_others', claimed_role: actor.role ?? null, owner_role: owner });
}

/** Owner role of a project (null = shared). */
export function projectOwnerRoleId(db: DB, projectId: string | null | undefined): string | null {
  if (!projectId) return null;
  return get<{ owner_role_id: string | null }>(db, 'SELECT owner_role_id FROM project WHERE id = ?', projectId)?.owner_role_id ?? null;
}

export function documentOwnerRoleId(db: DB, doc: { scope_type: string; scope_id: string | null }): string | null {
  if (doc.scope_type === 'role') return doc.scope_id;
  if (doc.scope_type === 'project') return projectOwnerRoleId(db, doc.scope_id);
  return null;
}

export function entityOwnerRoleId(db: DB, memberId: string, type: string, id: string): string | null | 'rules' {
  if (type === 'rules') return 'rules';
  if (type === 'role') return id;
  if (type === 'project') return projectOwnerRoleId(db, id);
  if (type === 'task') return get<{ role_id: string | null }>(db, 'SELECT role_id FROM task WHERE id = ?', id)?.role_id ?? null;
  if (type === 'routine') return get<{ role_id: string | null }>(db, 'SELECT role_id FROM routine WHERE id = ?', id)?.role_id ?? null;
  if (type === 'checkpoint') return get<{ role_id: string | null }>(db, 'SELECT role_id FROM checkpoint WHERE id = ?', id)?.role_id ?? null;
  if (type === 'document') {
    const d = get<{ scope_type: string; scope_id: string | null }>(db, 'SELECT scope_type, scope_id FROM document WHERE id = ?', id);
    return d ? documentOwnerRoleId(db, d) : null;
  }
  return null;
}

export function assertCanEditEntity(db: DB, actor: Actor, type: string, id: string): void {
  const owner = entityOwnerRoleId(db, actor.memberId, type, id);
  if (owner === 'rules') {
    assertCanEdit(db, actor, null, { rules: true });
    return;
  }
  assertCanEdit(db, actor, owner, { what: type });
}

export function unconfirmedActiveConnections(db: DB, memberId: string): { client_id: string; name: string }[] {
  return all<{ client_id: string; name: string }>(
    db,
    `SELECT client_id, name FROM connection
     WHERE member_id = ? AND revoked_at IS NULL AND roles_confirmed_at IS NULL
     ORDER BY name`,
    memberId,
  );
}

function claimedRoleHistory(db: DB, clientId: string): string[] {
  return all<{ claimed_role: string }>(
    db,
    `SELECT DISTINCT claimed_role FROM (
       SELECT claimed_role FROM event WHERE connection_id = ? AND claimed_role IS NOT NULL
       UNION
       SELECT claimed_role FROM version WHERE connection_id = ? AND claimed_role IS NOT NULL
       UNION
       SELECT claimed_role FROM task_comment WHERE connection_id = ? AND claimed_role IS NOT NULL
       UNION
       SELECT claimed_role FROM checkpoint WHERE connection_id = ? AND claimed_role IS NOT NULL
     )`,
    clientId,
    clientId,
    clientId,
    clientId,
  ).map((r) => r.claimed_role);
}

/** Computed suggestions for a GET. Does not write. */
function suggestedRolesFromHistory(db: DB, memberId: string, clientId: string): AllowedRole[] {
  const out: AllowedRole[] = [];
  const seen = new Set<string>();
  for (const claimed of claimedRoleHistory(db, clientId)) {
    const role = roleByRef(db, memberId, claimed, false);
    if (!role || seen.has(role.id)) continue;
    seen.add(role.id);
    out.push({ id: role.id, slug: role.slug, name: role.name, source: 'suggested' });
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

/**
 * Fills a draft allow-list from this connection's own history, once.
 * Only existing, non-archived roles are included. The draft is not confirmed
 * and has no effect in enforce until the owner confirms it.
 * Called from explicit actions (turning on enforcement), not from GET.
 */
export function prefillConnectionRoles(db: DB, clientId: string): void {
  const c = get<{ member_id: string; roles_confirmed_at: string | null; roles_suggested_at: string | null }>(
    db,
    'SELECT member_id, roles_confirmed_at, roles_suggested_at FROM connection WHERE client_id = ?',
    clientId,
  );
  if (!c || c.roles_confirmed_at || c.roles_suggested_at) return;

  let inserted = 0;
  for (const claimed of claimedRoleHistory(db, clientId)) {
    const role = roleByRef(db, c.member_id, claimed, false);
    if (!role) continue;
    const res = run(
      db,
      `INSERT OR IGNORE INTO connection_role (client_id, role_id, source) VALUES (?,?, 'suggested')`,
      clientId,
      role.id,
    );
    if (Number(res.changes) > 0) inserted++;
  }
  // An empty scan must not lock the draft: later history should still be offered.
  // Once any suggestion is written, do not resurrect roles the owner removed from the draft.
  if (inserted > 0 || get(db, 'SELECT 1 FROM connection_role WHERE client_id = ?', clientId)) {
    run(db, 'UPDATE connection SET roles_suggested_at = ? WHERE client_id = ?', now(), clientId);
  }
}

export function prefillAllConnectionRoles(db: DB, memberId: string): void {
  const rows = all<{ client_id: string }>(db, 'SELECT client_id FROM connection WHERE member_id = ?', memberId);
  for (const r of rows) prefillConnectionRoles(db, r.client_id);
}

export function setConnectionRoles(db: DB, actor: Actor, clientId: string, roleRefs: string[], confirm: boolean): void {
  if (actor.kind !== 'owner') throw new DomainError('forbidden', 'only the owner can set a connection\'s allow-list');
  const c = get<{ member_id: string; roles_confirmed_at: string | null; roles_suggested_at: string | null }>(
    db,
    'SELECT member_id, roles_confirmed_at, roles_suggested_at FROM connection WHERE client_id = ?',
    clientId,
  );
  if (!c) throw new DomainError('not_found', `connection not found: ${clientId}`);
  tx(db, () => {
    const beforeIds = listConnectionRoles(db, clientId).map((r) => r.id).sort();
    const beforeConfirmed = !!c.roles_confirmed_at;
    const ids: string[] = [];
    for (const ref of roleRefs) {
      const role = roleByRef(db, c.member_id, String(ref), false);
      if (!role) throw invalid(`role not found or archived: ${ref}`);
      ids.push(role.id);
    }
    const listChanged = JSON.stringify(beforeIds) !== JSON.stringify([...ids].sort());
    run(db, 'DELETE FROM connection_role WHERE client_id = ?', clientId);
    for (const id of ids) {
      run(db, `INSERT INTO connection_role (client_id, role_id, source) VALUES (?,?, 'owner')`, clientId, id);
    }
    if (confirm) {
      run(db, 'UPDATE connection SET roles_confirmed_at = ? WHERE client_id = ?', now(), clientId);
      recordEvent(db, actor, 'connection', clientId, 'connection.roles_confirmed', `Allow-list confirmed for a connection`, { role_ids: ids });
    } else {
      run(db, 'UPDATE connection SET roles_confirmed_at = NULL WHERE client_id = ?', clientId);
      // Lock the draft so a later prefill cannot add back roles the owner removed.
      if (!c.roles_suggested_at) {
        run(db, 'UPDATE connection SET roles_suggested_at = ? WHERE client_id = ?', now(), clientId);
      }
      // Log when the list changed, when it was un-confirmed, or when this save first locks an empty draft.
      if (listChanged || beforeConfirmed || !c.roles_suggested_at) {
        recordEvent(db, actor, 'connection', clientId, 'connection.roles_updated', `Allow-list updated for a connection`, {
          role_ids: ids,
          confirmed: false,
        });
      }
    }
  });
}

export function setRoleEditAny(db: DB, actor: Actor, roleRef: string, editAny: boolean): void {
  if (actor.kind !== 'owner') throw new DomainError('forbidden', 'only the owner can mark a role as allowed to edit any item');
  const role = roleByRef(db, actor.memberId, roleRef, true);
  if (!role) throw new DomainError('not_found', `role not found: ${roleRef}`);
  run(db, 'UPDATE role SET edit_any = ?, updated_at = ? WHERE id = ?', editAny ? 1 : 0, now(), role.id);
  recordEvent(db, actor, 'role', role.id, 'role.privilege_updated', `Role "${role.name}" ${editAny ? 'may' : 'may no longer'} edit any item`, {
    edit_any: editAny,
    owner_role: role.slug,
  });
}

export function setEnforcement(
  db: DB,
  actor: Actor,
  mode: Enforcement,
  opts?: { override?: boolean },
): { role_enforcement: Enforcement; override: boolean } {
  if (actor.kind !== 'owner') throw new DomainError('forbidden', 'only the owner can change role enforcement');
  if (mode !== 'warn' && mode !== 'enforce') throw invalid('role_enforcement must be warn or enforce');

  let override = false;
  if (mode === 'enforce') {
    prefillAllConnectionRoles(db, actor.memberId);
    const pending = unconfirmedActiveConnections(db, actor.memberId);
    if (pending.length && !opts?.override) {
      throw new DomainError(
        'invalid',
        'Every active connection must have a confirmed allow-list before enforcement can be turned on, or pass override to turn it on anyway.',
        { unconfirmed: pending },
      );
    }
    override = pending.length > 0 && !!opts?.override;
  }

  run(db, 'UPDATE member SET role_enforcement = ? WHERE id = ?', mode, actor.memberId);
  recordEvent(db, actor, 'settings', actor.memberId, 'settings.role_enforcement', `Role enforcement set to ${mode}${override ? ' (override)' : ''}`, {
    mode,
    override,
    unconfirmed: override ? unconfirmedActiveConnections(db, actor.memberId).map((c) => c.client_id) : [],
  });
  if (override) {
    auditRoleCheck(db, actor, 'override', {
      reason: 'enforce_override',
      unconfirmed: unconfirmedActiveConnections(db, actor.memberId).map((c) => ({ client_id: c.client_id, name: c.name })),
    });
  }
  return { role_enforcement: mode, override };
}

export function connectionAccessView(db: DB, memberId: string, clientId: string) {
  const c = get<{ roles_confirmed_at: string | null; roles_suggested_at: string | null }>(
    db,
    'SELECT roles_confirmed_at, roles_suggested_at FROM connection WHERE client_id = ?',
    clientId,
  );
  const stored = listConnectionRoles(db, clientId);
  // A locked empty draft (roles_suggested_at set, no rows) must not be replaced with a fresh scan.
  const roles = stored.length > 0 || c?.roles_suggested_at ? stored : suggestedRolesFromHistory(db, memberId, clientId);
  return {
    roles,
    roles_confirmed_at: c?.roles_confirmed_at ?? null,
    roles_suggested_at: c?.roles_suggested_at ?? null,
    roles_confirmed: !!c?.roles_confirmed_at,
  };
}

export function workspaceAccessSettings(db: DB, memberId: string) {
  const roles = all<{ id: string; slug: string; name: string; edit_any: number }>(
    db,
    'SELECT id, slug, name, edit_any FROM role WHERE member_id = ? AND archived_at IS NULL ORDER BY name',
    memberId,
  );
  return {
    role_enforcement: getEnforcement(db, memberId),
    unconfirmed_active: unconfirmedActiveConnections(db, memberId),
    roles: roles.map((r) => ({ id: r.id, slug: r.slug, name: r.name, edit_any: r.edit_any === 1 })),
  };
}

/** Label for the log: who edited whose item, when the owner role differs from the author. */
export function editedWhoseLabel(ownerRole: string | null | undefined, claimedRole: string | null | undefined): string | null {
  if (!ownerRole) return null;
  if (claimedRole && ownerRole === claimedRole) return null;
  return `item of @${ownerRole}`;
}
