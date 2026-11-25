import { all, get, type DB } from '../db/db.ts';
import { actorLabel, parseEvent, type VersionedType } from '../domain/core.ts';
import { listRoles, roleLinks } from '../domain/entities.ts';
import { lastCheckpoint, taskSummary, type TaskRow } from '../domain/tasks.ts';
import { lineDiff } from '../domain/versions.ts';

/**
 * Read models for the owner's web interface. Everything here is derived from recorded data;
 * ages are record times, never presented as live status.
 */

export function mapView(db: DB, memberId: string) {
  const roles = listRoles(db, memberId);
  const slugById = new Map(roles.map((r) => [r.id, r.slug]));
  const nodes = roles.map((r) => {
    const counts = all<{ status: string; n: number }>(
      db,
      "SELECT status, count(*) AS n FROM task WHERE role_id = ? AND archived_at IS NULL AND status NOT IN ('done','cancelled') GROUP BY status",
      r.id,
    );
    const lastEvent = get<{ at: string }>(db, 'SELECT max(at) AS at FROM event WHERE member_id = ? AND (claimed_role = ? OR (entity_type = ? AND entity_id = ?))', memberId, r.slug, 'role', r.id);
    const cp = lastCheckpoint(db, memberId, r.id);
    return {
      id: r.id,
      slug: r.slug,
      name: r.name,
      area: r.area,
      open_tasks: Object.fromEntries(counts.map((c) => [c.status, c.n])),
      open_total: counts.reduce((s, c) => s + c.n, 0),
      last_checkpoint: cp ? { at: cp.created_at, stopped_at: cp.stopped_at, next: cp.next, project: cp.project } : null,
      last_activity_at: lastEvent?.at ?? null,
    };
  });

  const links = roles.flatMap((r) =>
    roleLinks(db, r.id)
      .filter((l) => l.from_role_id === r.id)
      .map((l) => ({ from: l.from_slug, to: l.to_slug, type: l.type })),
  );

  // Interactions recorded in the log: who assigned work to whom, who commented on whose task.
  const interactions = new Map<string, { from: string; to: string; kind: string; count: number; last_at: string }>();
  const rows = all<Record<string, unknown>>(
    db,
    "SELECT * FROM event WHERE member_id = ? AND action IN ('task.assigned','task.commented') ORDER BY id DESC LIMIT 2000",
    memberId,
  ).map(parseEvent);
  for (const e of rows) {
    const toId = (e.data as { role_id?: string }).role_id;
    const to = toId ? slugById.get(toId) : undefined;
    const from = e.claimed_role ?? (e.actor_kind === 'owner' ? 'owner' : null);
    if (!to || !from || from === to) continue;
    const kind = e.action === 'task.assigned' ? 'assigned' : 'commented';
    const key = `${from}|${to}|${kind}`;
    const cur = interactions.get(key);
    if (cur) cur.count++;
    else interactions.set(key, { from, to, kind, count: 1, last_at: e.at });
  }
  const unassigned = get<{ n: number }>(db, "SELECT count(*) AS n FROM task WHERE member_id = ? AND role_id IS NULL AND archived_at IS NULL AND status NOT IN ('done','cancelled')", memberId)!.n;
  return { roles: nodes, links, interactions: [...interactions.values()], unassigned_open_tasks: unassigned };
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
      const entityId = type === 'rules' ? memberId : e.entity_id;
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
    return {
      id: e.id,
      at: e.at,
      by: actorLabel(e),
      action: e.action,
      entity_type: e.entity_type,
      entity_id: e.entity_id,
      summary: e.summary,
      critical,
      versioned: type ? { type, id: type === 'rules' ? null : e.entity_id, version } : null,
      diff,
    };
  });
  // "Mark reviewed" covers exactly what is shown: up to the newest shown change while older ones
  // remain hidden, otherwise everything (including the owner's own events).
  const reviewUpTo = more ? Math.max(...items.map((i) => i.id)) : latest;
  items.sort((a, b) => Number(b.critical) - Number(a.critical) || b.id - a.id);
  return { last_review_event_id: m.last_review_event_id, latest_event_id: latest, review_up_to: reviewUpTo, has_more: more, items };
}
