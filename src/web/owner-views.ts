import { all, get, type DB } from '../db/db.ts';
import { editedWhoseLabel } from '../domain/access.ts';
import { actorLabel, parseEvent, type VersionedType } from '../domain/core.ts';
import { listRoles, roleLinks, type RoleRow } from '../domain/entities.ts';
import { taskSummary, type TaskRow } from '../domain/tasks.ts';
import { lineDiff } from '../domain/versions.ts';

/**
 * Read models for the owner's web interface. Everything here is derived from recorded data;
 * ages are record times, never presented as live status.
 */

export const MAP_INTERACTION_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
export const MAP_INTERACTION_EVENT_CAP = 2000;
const MAP_OPEN_TASKS_PER_ROLE = 8;

function roleDepth(rolesById: Map<string, RoleRow>, id: string): number {
  const seen = new Set<string>();
  let depth = 0;
  let cur: string | null = rolesById.get(id)?.parent_id ?? null;
  while (cur) {
    if (seen.has(cur)) break;
    seen.add(cur);
    depth++;
    cur = rolesById.get(cur)?.parent_id ?? null;
  }
  return depth;
}

function mapRolesToShow(allRoles: RoleRow[]): RoleRow[] {
  const byId = new Map(allRoles.map((r) => [r.id, r]));
  const show = new Set<string>();
  for (const r of allRoles) {
    if (r.archived_at) continue;
    show.add(r.id);
    let cur = r.parent_id;
    const seen = new Set<string>();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      show.add(cur);
      cur = byId.get(cur)?.parent_id ?? null;
    }
  }
  return allRoles.filter((r) => show.has(r.id));
}

export function mapView(db: DB, memberId: string) {
  const allRoles = listRoles(db, memberId, true);
  const roles = mapRolesToShow(allRoles);
  const rolesById = new Map(allRoles.map((r) => [r.id, r]));
  const slugById = new Map(allRoles.map((r) => [r.id, r.slug]));
  const existingSlugs = new Set(allRoles.map((r) => r.slug));
  const shownIds = new Set(roles.map((r) => r.id));

  const counts = all<{ role_id: string; status: string; n: number }>(
    db,
    "SELECT role_id, status, count(*) AS n FROM task WHERE member_id = ? AND role_id IS NOT NULL AND archived_at IS NULL AND status NOT IN ('done','cancelled') GROUP BY role_id, status",
    memberId,
  );
  const countByRole = new Map<string, Record<string, number>>();
  for (const c of counts) {
    const cur = countByRole.get(c.role_id) ?? {};
    cur[c.status] = c.n;
    countByRole.set(c.role_id, cur);
  }

  const openRows = all<{ id: string; title: string; status: string; role_id: string }>(
    db,
    `SELECT id, title, status, role_id FROM task
     WHERE member_id = ? AND role_id IS NOT NULL AND archived_at IS NULL AND status NOT IN ('done','cancelled')
     ORDER BY role_id, updated_at DESC`,
    memberId,
  );
  const openByRole = new Map<string, { items: { id: string; title: string; status: string }[]; more: number }>();
  for (const t of openRows) {
    const cur = openByRole.get(t.role_id) ?? { items: [], more: 0 };
    if (cur.items.length < MAP_OPEN_TASKS_PER_ROLE) cur.items.push({ id: t.id, title: t.title, status: t.status });
    else cur.more++;
    openByRole.set(t.role_id, cur);
  }

  const routineRows = all<{ id: string; name: string; schedule: string; status: string; last_run_at: string | null; role_id: string }>(
    db,
    `SELECT id, name, schedule, status, last_run_at, role_id FROM routine
     WHERE member_id = ? AND archived_at IS NULL AND role_id IS NOT NULL
     ORDER BY name, id`,
    memberId,
  );
  const routinesByRole = new Map<string, { id: string; name: string; schedule: string; status: string; last_run: string | null }[]>();
  for (const r of routineRows) {
    const cur = routinesByRole.get(r.role_id) ?? [];
    cur.push({ id: r.id, name: r.name, schedule: r.schedule, status: r.status, last_run: r.last_run_at });
    routinesByRole.set(r.role_id, cur);
  }

  const checkpoints = all<{ role_id: string; at: string; stopped_at: string; next: string; project: string | null }>(
    db,
    `SELECT c.role_id, c.created_at AS at, c.stopped_at, c.next, p.slug AS project
     FROM checkpoint c
     JOIN (SELECT role_id, max(created_at) AS at FROM checkpoint WHERE member_id = ? GROUP BY role_id) latest
       ON latest.role_id = c.role_id AND latest.at = c.created_at
     LEFT JOIN project p ON p.id = c.project_id
     WHERE c.member_id = ?`,
    memberId,
    memberId,
  );
  const checkpointByRole = new Map(checkpoints.map((c) => [c.role_id, { at: c.at, stopped_at: c.stopped_at, next: c.next, project: c.project }]));

  const lastBySlug = new Map(
    all<{ slug: string; at: string }>(
      db,
      'SELECT claimed_role AS slug, max(at) AS at FROM event WHERE member_id = ? AND claimed_role IS NOT NULL GROUP BY claimed_role',
      memberId,
    ).map((r) => [r.slug, r.at]),
  );
  const lastByEntity = new Map(
    all<{ id: string; at: string }>(
      db,
      "SELECT entity_id AS id, max(at) AS at FROM event WHERE member_id = ? AND entity_type = 'role' AND entity_id IS NOT NULL GROUP BY entity_id",
      memberId,
    ).map((r) => [r.id, r.at]),
  );

  // Who runs where: active platforms with their agents, and for each role the agents that may take it.
  const agentRows = all<{ id: string; slug: string; name: string; client_id: string; platform: string }>(
    db,
    `SELECT a.id, a.slug, a.name, a.client_id, c.name AS platform FROM agent a JOIN connection c ON c.client_id = a.client_id
     WHERE a.member_id = ? AND c.revoked_at IS NULL ORDER BY a.name, a.slug`,
    memberId,
  );
  const agentRoleRows = all<{ agent_id: string; role_id: string; slug: string; name: string }>(
    db,
    `SELECT ar.agent_id, ar.role_id, r.slug, r.name FROM agent_role ar JOIN agent a ON a.id = ar.agent_id JOIN role r ON r.id = ar.role_id
     WHERE a.member_id = ? AND r.archived_at IS NULL ORDER BY r.name, r.slug`,
    memberId,
  );
  const agentById = new Map(agentRows.map((a) => [a.id, a]));
  const rolesByAgent = new Map<string, { slug: string; name: string }[]>();
  const agentsByRole = new Map<string, { slug: string; name: string; platform: string }[]>();
  for (const ar of agentRoleRows) {
    const a = agentById.get(ar.agent_id);
    if (!a) continue;
    rolesByAgent.set(a.id, [...(rolesByAgent.get(a.id) ?? []), { slug: ar.slug, name: ar.name }]);
    agentsByRole.set(ar.role_id, [...(agentsByRole.get(ar.role_id) ?? []), { slug: a.slug, name: a.name, platform: a.platform }]);
  }
  const platforms = all<{ client_id: string; name: string; last_activity_at: string | null }>(
    db,
    'SELECT client_id, name, last_activity_at FROM connection WHERE member_id = ? AND revoked_at IS NULL ORDER BY name',
    memberId,
  ).map((c) => ({
    id: c.client_id,
    name: c.name,
    last_activity_at: c.last_activity_at,
    agents: agentRows.filter((a) => a.client_id === c.client_id).map((a) => ({ slug: a.slug, name: a.name, roles: rolesByAgent.get(a.id) ?? [] })),
  }));

  const nodes = roles.map((r) => {
    const open = countByRole.get(r.id) ?? {};
    const listed = openByRole.get(r.id);
    const lastSlug = lastBySlug.get(r.slug);
    const lastEnt = lastByEntity.get(r.id);
    const last = !lastSlug ? lastEnt : !lastEnt ? lastSlug : lastSlug > lastEnt ? lastSlug : lastEnt;
    const parent = r.parent_id ? rolesById.get(r.parent_id) : undefined;
    return {
      id: r.id,
      slug: r.slug,
      name: r.name,
      area: r.area,
      archived: !!r.archived_at,
      parent: parent ? { id: parent.id, slug: parent.slug } : r.parent_id ? { id: r.parent_id, slug: slugById.get(r.parent_id) ?? r.parent_id } : null,
      depth: roleDepth(rolesById, r.id),
      open_tasks: open,
      open_total: Object.values(open).reduce((s, n) => s + n, 0),
      open_task_list: listed?.items ?? [],
      open_more: listed?.more ?? 0,
      routines: routinesByRole.get(r.id) ?? [],
      agents: agentsByRole.get(r.id) ?? [],
      last_checkpoint: checkpointByRole.get(r.id) ?? null,
      last_activity_at: last ?? null,
    };
  });

  const declared = all<{ from_slug: string; to_slug: string; type: string; from_role_id: string; to_role_id: string }>(
    db,
    `SELECT l.type, l.from_role_id, l.to_role_id, f.slug AS from_slug, t.slug AS to_slug
     FROM role_link l JOIN role f ON f.id = l.from_role_id JOIN role t ON t.id = l.to_role_id
     WHERE l.member_id = ? ORDER BY l.created_at`,
    memberId,
  ).filter((l) => shownIds.has(l.from_role_id) && shownIds.has(l.to_role_id));
  const links: { from: string; to: string; type: string }[] = declared.map((l) => ({ from: l.from_slug, to: l.to_slug, type: l.type }));
  const solidPairs = new Set(links.map((l) => `${l.from}>${l.to}`));
  for (const r of roles) {
    if (!r.parent_id) continue;
    const parent = rolesById.get(r.parent_id);
    if (!parent || !shownIds.has(parent.id)) continue;
    const pair = `${r.slug}>${parent.slug}`;
    if (solidPairs.has(pair)) continue;
    links.push({ from: r.slug, to: parent.slug, type: 'parent' });
    solidPairs.add(pair);
  }

  const since = new Date(Date.now() - MAP_INTERACTION_WINDOW_MS).toISOString();
  const eventRows = all<Record<string, unknown>>(
    db,
    `SELECT * FROM event
     WHERE member_id = ? AND action IN ('task.assigned','task.commented','task.created','task.claimed') AND at >= ?
     ORDER BY id DESC LIMIT ?`,
    memberId,
    since,
    MAP_INTERACTION_EVENT_CAP,
  ).map(parseEvent);
  const interactionsTruncated = eventRows.length === MAP_INTERACTION_EVENT_CAP;
  const creationAssigned = new Set<string>();
  const interactions = new Map<string, { from: string; to: string; kind: string; count: number; last_at: string }>();
  const actorSlug = (e: { claimed_role: string | null; actor_kind: string }): string | null => {
    // Only a real owner session (or owner connection, recorded as actor_kind 'owner')
    // is drawn as owner — never an agent whose claimed_role string is "owner".
    if (e.actor_kind === 'owner') return 'owner';
    if (e.claimed_role && existingSlugs.has(e.claimed_role)) return e.claimed_role;
    return null;
  };
  // Newest first: a create writes task.created then task.assigned, so assigned is seen first.
  for (const e of eventRows) {
    const toId = (e.data as { role_id?: string }).role_id;
    const to = toId ? slugById.get(toId) : undefined;
    const from = actorSlug(e);
    if (!to || !from || from === to) {
      if (e.action === 'task.assigned' && e.entity_id) creationAssigned.add(String(e.entity_id));
      continue;
    }
    if (solidPairs.has(`${from}>${to}`)) {
      if (e.action === 'task.assigned' && e.entity_id) creationAssigned.add(String(e.entity_id));
      continue;
    }
    let kind: string | null = null;
    if (e.action === 'task.commented') kind = 'commented';
    else if (e.action === 'task.assigned') {
      kind = 'assigned';
      if (e.entity_id) creationAssigned.add(String(e.entity_id));
    } else if (e.action === 'task.created') {
      if (e.entity_id && creationAssigned.has(String(e.entity_id))) continue;
      kind = 'assigned';
    } else if (e.action === 'task.claimed') {
      kind = 'claimed';
    }
    if (!kind) continue;
    const key = `${from}|${to}|${kind}`;
    const cur = interactions.get(key);
    if (cur) cur.count++;
    else interactions.set(key, { from, to, kind, count: 1, last_at: e.at });
  }

  const unassigned = get<{ n: number }>(db, "SELECT count(*) AS n FROM task WHERE member_id = ? AND role_id IS NULL AND archived_at IS NULL AND status NOT IN ('done','cancelled')", memberId)!.n;
  return {
    roles: nodes,
    platforms,
    links,
    interactions: [...interactions.values()],
    interactions_truncated: interactionsTruncated,
    unassigned_open_tasks: unassigned,
  };
}

export function taskTree(db: DB, memberId: string, f: { project?: string; role?: string; status?: string[]; include_archived?: boolean }) {
  const conds = ['t.member_id = ?'];
  const vals: unknown[] = [memberId];
  if (!f.include_archived) conds.push('t.archived_at IS NULL');
  if (f.project) (conds.push('(p.slug = ? OR p.id = ?)'), vals.push(f.project, f.project));
  if (f.role) (conds.push('(r.slug = ? OR r.id = ?)'), vals.push(f.role, f.role));
  if (f.status?.length) (conds.push(`t.status IN (${f.status.map(() => '?').join(',')})`), vals.push(...f.status));
  const tasks = all<TaskRow>(
    db,
    `SELECT t.* FROM task t LEFT JOIN project p ON p.id = t.project_id LEFT JOIN role r ON r.id = t.role_id
     WHERE ${conds.join(' AND ')} ORDER BY t.created_at LIMIT 2000`,
    ...vals,
  );
  const ids = new Set(tasks.map((t) => t.id));
  // Each dependency carries the title and status of the task it waits for, which may be outside the
  // filter (another role, project or status): the list still shows what a task waits for.
  const deps = all<{ task_id: string; depends_on_id: string; depends_on_title: string; depends_on_status: string }>(
    db,
    `SELECT d.task_id, d.depends_on_id, o.title AS depends_on_title, o.status AS depends_on_status
     FROM task_dependency d JOIN task t ON t.id = d.task_id JOIN task o ON o.id = d.depends_on_id WHERE t.member_id = ?`,
    memberId,
  ).filter((d) => ids.has(d.task_id));
  const issueConds = ['i.member_id = ?'];
  const issueVals: unknown[] = [memberId];
  if (f.project) (issueConds.push('(p.slug = ? OR p.id = ?)'), issueVals.push(f.project, f.project));
  if (f.role) (issueConds.push('(ro.slug = ? OR ro.id = ?)'), issueVals.push(f.role, f.role));
  if (f.status?.length) {
    const open = f.status.some((s) => !['done', 'cancelled'].includes(s));
    const closed = f.status.some((s) => ['done', 'cancelled'].includes(s));
    if (open && !closed) issueConds.push("i.state = 'open'");
    if (closed && !open) issueConds.push("i.state = 'closed'");
  }
  const issues = all<Record<string, unknown>>(
    db,
    `SELECT i.id, i.number, i.title, i.state, i.url, i.labels, i.updated_at, r.full_name AS repo, p.slug AS project, ro.slug AS role
     FROM github_issue i JOIN github_repo r ON r.id = i.repo_id LEFT JOIN project p ON p.id = r.project_id LEFT JOIN role ro ON ro.id = i.role_id
     WHERE ${issueConds.join(' AND ')} ORDER BY i.state, i.updated_at DESC LIMIT 1000`,
    ...issueVals,
  ).map((i) => ({ ...i, labels: JSON.parse(String(i.labels)) }));
  return {
    tasks: tasks.map((t) => ({ ...taskSummary(db, t), blocking_reason: t.blocking_reason || null, archived: !!t.archived_at })),
    dependencies: deps,
    issues,
  };
}

const VERSIONED_ACTIONS: Record<string, VersionedType> = {
  'rules.updated': 'rules',
  'role.created': 'role',
  'role.instruction_updated': 'role',
  'project.created': 'project',
  'project.updated': 'project',
  'document.created': 'document',
  'document.updated': 'document',
};

/**
 * Changes since the owner's last review, with line diffs for versioned text. The feed takes the
 * oldest unreviewed changes first, so marking a page reviewed never skips one the owner has not
 * seen; within a page, edits to working rules and role instructions come first (they change every
 * later session), then newest first.
 */
export function changeFeed(db: DB, memberId: string, limit = 200) {
  const m = get<{ last_review_event_id: number }>(db, 'SELECT last_review_event_id FROM member WHERE id = ?', memberId)!;
  const rows = all<Record<string, unknown>>(
    db,
    "SELECT * FROM event WHERE member_id = ? AND id > ? AND actor_kind <> 'owner' ORDER BY id LIMIT ?",
    memberId,
    m.last_review_event_id,
    limit + 1,
  ).map(parseEvent);
  const more = rows.length > limit;
  const latest = get<{ id: number | null }>(db, 'SELECT max(id) AS id FROM event WHERE member_id = ?', memberId)!.id ?? 0;
  const items = rows.slice(0, limit).map((e) => {
    const type = VERSIONED_ACTIONS[e.action];
    let diff: unknown = null;
    let version: number | null = null;
    if (type) {
      const d = e.data as { version?: number };
      version = d.version ?? (e.action.endsWith('.created') ? 1 : null);
      const entityId = e.entity_id;
      if (version && entityId) {
        const cur = get<{ body: string }>(db, 'SELECT body FROM version WHERE entity_type = ? AND entity_id = ? AND number = ?', type, entityId, version);
        const prev = version > 1 ? get<{ body: string }>(db, 'SELECT body FROM version WHERE entity_type = ? AND entity_id = ? AND number = ?', type, entityId, version - 1) : { body: '' };
        if (cur) {
          const ld = lineDiff(prev?.body ?? '', cur.body, 2);
          diff = { from: version - 1, to: version, added: ld.added, removed: ld.removed, lines: ld.lines.slice(0, 400), truncated: ld.lines.length > 400 };
        }
      }
    }
    const critical = e.action === 'rules.updated' || e.action === 'role.instruction_updated';
    const owner_role = (e.data?.owner_role as string | undefined) ?? null;
    return {
      id: e.id,
      at: e.at,
      by: actorLabel(e),
      claimed_role: e.claimed_role,
      owner_role,
      whose: editedWhoseLabel(owner_role, e.claimed_role),
      action: e.action,
      entity_type: e.entity_type,
      entity_id: e.entity_id,
      summary: e.summary,
      critical,
      versioned: type ? { type, id: e.entity_id, version } : null,
      diff,
    };
  });
  // "Mark reviewed" covers exactly what is shown: up to the newest shown change while older ones
  // remain hidden, otherwise everything (including the owner's own events).
  const reviewUpTo = more ? Math.max(...items.map((i) => i.id)) : latest;
  items.sort((a, b) => Number(b.critical) - Number(a.critical) || b.id - a.id);
  return { last_review_event_id: m.last_review_event_id, latest_event_id: latest, review_up_to: reviewUpTo, has_more: more, items };
}
