import { all, get, now, run, tx, type DB } from '../db/db.ts';
import { checkLen, checkRev, DomainError, invalid, LIMITS, newId, notFound, recordEvent, slugify, type Actor } from './core.ts';
import { roleByRef } from './access.ts';

/**
 * An agent is a named bot on one platform (an approved connection) with the roles it may take
 * (decision 0006). Only the owner creates, changes or removes agents; MCP can read them.
 * The server can verify only the platform, so this is a record the owner keeps, not an identity check.
 */
export interface AgentRow {
  id: string;
  member_id: string;
  client_id: string;
  slug: string;
  name: string;
  rev: number;
  created_at: string;
  updated_at: string;
}

export const MAX_AGENT_ROLES = 50;

export function findAgent(db: DB, memberId: string, ref: string): AgentRow | undefined {
  return get<AgentRow>(db, 'SELECT * FROM agent WHERE member_id = ? AND (id = ? OR slug = ?)', memberId, ref, ref);
}

export function requireAgent(db: DB, memberId: string, ref: string): AgentRow {
  const a = findAgent(db, memberId, ref);
  if (!a) throw notFound('agent', ref);
  return a;
}

function agentRoles(db: DB, agentId: string) {
  return all<{ id: string; slug: string; name: string; archived_at: string | null }>(
    db,
    'SELECT r.id, r.slug, r.name, r.archived_at FROM agent_role ar JOIN role r ON r.id = ar.role_id WHERE ar.agent_id = ? ORDER BY r.name, r.slug',
    agentId,
  );
}

export function agentView(db: DB, a: AgentRow) {
  const c = get<{ name: string; revoked_at: string | null }>(db, 'SELECT name, revoked_at FROM connection WHERE client_id = ?', a.client_id);
  return {
    id: a.id,
    slug: a.slug,
    name: a.name,
    platform: { id: a.client_id, name: c?.name ?? a.client_id, active: !!c && !c.revoked_at },
    roles: agentRoles(db, a.id).map((r) => ({ id: r.id, slug: r.slug, name: r.name, archived: !!r.archived_at })),
    rev: a.rev,
    created_at: a.created_at,
    updated_at: a.updated_at,
  };
}

export function listAgents(db: DB, memberId: string) {
  return all<AgentRow>(db, 'SELECT * FROM agent WHERE member_id = ? ORDER BY name, slug', memberId).map((a) => agentView(db, a));
}

/** The compact list `start` returns: who runs where and which roles they may take. Revoked platforms are left out. */
export function agentSummaries(db: DB, memberId: string, max: number) {
  const rows = all<AgentRow & { platform: string }>(
    db,
    `SELECT a.*, c.name AS platform FROM agent a JOIN connection c ON c.client_id = a.client_id
     WHERE a.member_id = ? AND c.revoked_at IS NULL ORDER BY c.name, a.name, a.slug`,
    memberId,
  );
  return {
    agents: rows.slice(0, max).map((a) => ({
      slug: a.slug,
      name: a.name,
      platform: a.platform,
      roles: agentRoles(db, a.id)
        .filter((r) => !r.archived_at)
        .map((r) => r.slug),
    })),
    more: Math.max(0, rows.length - max),
  };
}

export interface SaveAgentInput {
  id?: string;
  rev?: number;
  name?: string;
  slug?: string;
  /** The connection (platform) the agent runs on: its client id. */
  platform?: string;
  /** Role slugs or ids. Replaces the list. */
  roles?: string[];
}

function ownerOnly(actor: Actor): void {
  if (actor.kind !== 'owner') throw new DomainError('forbidden', 'only the owner can create, change or remove agents');
}

function requirePlatform(db: DB, memberId: string, clientId: string): { client_id: string; name: string } {
  const c = get<{ client_id: string; name: string; revoked_at: string | null }>(db, 'SELECT client_id, name, revoked_at FROM connection WHERE member_id = ? AND client_id = ?', memberId, clientId);
  if (!c) throw invalid(`platform not found: ${clientId}`);
  if (c.revoked_at) throw invalid(`platform "${c.name}" is revoked; approve it again before adding an agent to it`);
  return c;
}

function resolveRoles(db: DB, memberId: string, refs: string[]): { id: string; slug: string }[] {
  if (refs.length > MAX_AGENT_ROLES) throw invalid(`at most ${MAX_AGENT_ROLES} roles per agent`);
  const out = new Map<string, { id: string; slug: string }>();
  for (const ref of refs) {
    const r = roleByRef(db, memberId, String(ref), false);
    if (!r) throw invalid(`role not found or archived: ${ref}`);
    out.set(r.id, { id: r.id, slug: r.slug });
  }
  return [...out.values()];
}

function setRoles(db: DB, agentId: string, roles: { id: string }[]): void {
  run(db, 'DELETE FROM agent_role WHERE agent_id = ?', agentId);
  for (const r of roles) run(db, 'INSERT INTO agent_role (agent_id, role_id) VALUES (?,?)', agentId, r.id);
}

/**
 * A slug made from the name. A name with no Latin letters or digits (for example in Cyrillic) has
 * nothing to build on, so it becomes "agent"; a slug that is taken gets the next free number.
 */
function freeSlug(db: DB, memberId: string, name: string): string {
  const made = slugify(name);
  const base = (made === 'item' ? 'agent' : made).slice(0, 55);
  if (!findAgent(db, memberId, base)) return base;
  for (let n = 2; n < 1000; n++) if (!findAgent(db, memberId, `${base}-${n}`)) return `${base}-${n}`;
  throw new DomainError('conflict', `could not find a free slug for "${name}"; pass slug`);
}

export function saveAgent(db: DB, actor: Actor, input: SaveAgentInput) {
  ownerOnly(actor);
  checkLen('name', input.name, LIMITS.title);
  if (input.slug !== undefined && !/^[a-z0-9][a-z0-9-]{0,59}$/.test(input.slug)) throw invalid('slug must be lowercase letters, digits and dashes (max 60)');
  if (input.roles !== undefined && !Array.isArray(input.roles)) throw invalid('roles must be a list of role slugs or ids');
  return tx(db, () => {
    if (!input.id) {
      if (!input.name?.trim()) throw invalid('name is required to create an agent');
      if (!input.platform) throw invalid('platform is required to create an agent');
      const platform = requirePlatform(db, actor.memberId, input.platform);
      const slug = input.slug ?? freeSlug(db, actor.memberId, input.name);
      if (findAgent(db, actor.memberId, slug)) throw new DomainError('conflict', `an agent with slug "${slug}" already exists`);
      const roles = resolveRoles(db, actor.memberId, input.roles ?? []);
      const id = newId('agt');
      const at = now();
      run(db, 'INSERT INTO agent (id, member_id, client_id, slug, name, rev, created_at, updated_at) VALUES (?,?,?,?,?,1,?,?)', id, actor.memberId, platform.client_id, slug, input.name.trim(), at, at);
      setRoles(db, id, roles);
      recordEvent(db, actor, 'agent', id, 'agent.created', `Agent "${input.name.trim()}" added on ${platform.name}`, { slug, platform: platform.name, roles: roles.map((r) => r.slug) });
      return agentView(db, requireAgent(db, actor.memberId, id));
    }
    const a = requireAgent(db, actor.memberId, input.id);
    checkRev('agent', a.slug, a.rev, input.rev);
    const changed: string[] = [];
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (input.name !== undefined && input.name.trim() !== a.name) {
      if (!input.name.trim()) throw invalid('name must not be empty');
      sets.push('name = ?');
      vals.push(input.name.trim());
      changed.push('name');
    }
    if (input.slug !== undefined && input.slug !== a.slug) {
      const other = findAgent(db, actor.memberId, input.slug);
      if (other && other.id !== a.id) throw new DomainError('conflict', `an agent with slug "${input.slug}" already exists`);
      sets.push('slug = ?');
      vals.push(input.slug);
      changed.push('slug');
    }
    if (input.platform !== undefined && input.platform !== a.client_id) {
      sets.push('client_id = ?');
      vals.push(requirePlatform(db, actor.memberId, input.platform).client_id);
      changed.push('platform');
    }
    if (input.roles !== undefined) {
      const next = resolveRoles(db, actor.memberId, input.roles);
      const before = agentRoles(db, a.id)
        .map((r) => r.id)
        .sort();
      if (JSON.stringify(before) !== JSON.stringify(next.map((r) => r.id).sort())) {
        setRoles(db, a.id, next);
        changed.push('roles');
      }
    }
    if (changed.length === 0) return { ...agentView(db, a), unchanged: true };
    sets.push('rev = rev + 1', 'updated_at = ?');
    vals.push(now(), a.id);
    run(db, `UPDATE agent SET ${sets.join(', ')} WHERE id = ?`, ...vals);
    const view = agentView(db, requireAgent(db, actor.memberId, a.id));
    recordEvent(db, actor, 'agent', a.id, 'agent.updated', `Agent "${view.name}" updated: ${changed.join(', ')}`, { changed, slug: view.slug, platform: view.platform.name, roles: view.roles.map((r) => r.slug) });
    return view;
  });
}

/** Removes the record. The log keeps what the agent did; nothing else refers to an agent yet. */
export function deleteAgent(db: DB, actor: Actor, ref: string) {
  ownerOnly(actor);
  return tx(db, () => {
    const a = requireAgent(db, actor.memberId, ref);
    run(db, 'DELETE FROM agent WHERE id = ?', a.id);
    recordEvent(db, actor, 'agent', a.id, 'agent.deleted', `Agent "${a.name}" removed`, { slug: a.slug });
    return { id: a.id, deleted: true };
  });
}

/** What `start` tells an agent about itself: its name, platform and the roles it may take. */
export function agentSelf(db: DB, memberId: string, ref: string) {
  const a = findAgent(db, memberId, ref);
  if (!a) return undefined;
  const v = agentView(db, a);
  return { slug: v.slug, name: v.name, platform: v.platform.name, roles: v.roles.filter((r) => !r.archived).map((r) => r.slug) };
}

/**
 * Everything the owner wants to see about one agent on its page: the record, the open tasks addressed
 * to it or claimed by it, its last checkpoint and what it changed most recently. Read-only.
 */
export function agentOverview(db: DB, memberId: string, ref: string) {
  const a = requireAgent(db, memberId, ref);
  const task = (t: { id: string; title: string; status: string; role: string | null; project: string | null }) => t;
  const cols = `t.id, t.title, t.status, r.slug AS role, p.slug AS project FROM task t LEFT JOIN role r ON r.id = t.role_id LEFT JOIN project p ON p.id = t.project_id`;
  const open = "t.archived_at IS NULL AND t.status NOT IN ('done','cancelled')";
  const addressed = all<Parameters<typeof task>[0]>(db, `SELECT ${cols} WHERE t.member_id = ? AND t.agent_id = ? AND ${open} ORDER BY t.updated_at DESC LIMIT 50`, memberId, a.id).map(task);
  const claimed = all<Parameters<typeof task>[0]>(
    db,
    `SELECT ${cols} WHERE t.member_id = ? AND t.claimed_agent = ? AND t.claimed_by = ? AND (t.agent_id IS NULL OR t.agent_id <> ?) AND ${open} ORDER BY t.updated_at DESC LIMIT 50`,
    memberId,
    a.slug,
    a.client_id,
    a.id,
  ).map(task);
  const checkpoint = get<{ id: string; done: string; stopped_at: string; next: string; created_at: string; role: string; project: string | null }>(
    db,
    `SELECT c.id, c.done, c.stopped_at, c.next, c.created_at, r.slug AS role, p.slug AS project FROM checkpoint c
     JOIN role r ON r.id = c.role_id LEFT JOIN project p ON p.id = c.project_id
     WHERE c.member_id = ? AND c.agent = ? AND c.connection_id = ? ORDER BY c.created_at DESC, c.rowid DESC LIMIT 1`,
    memberId,
    a.slug,
    a.client_id,
  );
  const recent = all<{ id: number; at: string; claimed_role: string | null; entity_type: string; entity_id: string | null; action: string; summary: string }>(
    db,
    'SELECT id, at, claimed_role, entity_type, entity_id, action, summary FROM event WHERE member_id = ? AND agent = ? AND connection_id = ? ORDER BY id DESC LIMIT 20',
    memberId,
    a.slug,
    a.client_id,
  );
  return { ...agentView(db, a), tasks_for_agent: addressed, tasks_claimed: claimed, last_checkpoint: checkpoint ?? null, recent };
}
