import { all, get, type DB } from '../db/db.ts';
import { actorLabel, LIMITS, parseEvent, preview, recordEvent, type Actor, type EventRecord } from './core.ts';
import { withOwnerRole } from './access.ts';
import { findRole } from './entities.ts';
import type { TaskRow } from './tasks.ts';

/**
 * Notices about closed tasks (#183): the creator of a task hears once that it was closed, and comments
 * on a closed task reach its assignee and its creator. Both are journal events, shown in `start` (the
 * session inbox) and sent as wake-ups through the existing webhook event types.
 */

/** Who created or handles a task, as far as the workspace knows. */
export interface TaskParty {
  kind: 'owner' | 'agent';
  /** The platform (OAuth client id), when known. */
  connection: string | null;
  role_id: string | null;
  role: string | null;
  /** Agent slug, when the caller named one. */
  agent: string | null;
}

const FINISHED = ['done', 'cancelled'];

/** The task's creator. The creating agent is not a task column; it is read from the task.created journal entry. */
export function taskCreator(db: DB, t: TaskRow): TaskParty | null {
  if (t.created_by_kind === 'owner') return { kind: 'owner', connection: null, role_id: null, role: null, agent: null };
  if (t.created_by_kind !== 'agent') return null;
  const created = get<{ agent: string | null }>(
    db,
    "SELECT agent FROM event WHERE entity_type = 'task' AND entity_id = ? AND action = 'task.created' ORDER BY id LIMIT 1",
    t.id,
  );
  const role = t.created_by_role ? findRole(db, t.member_id, t.created_by_role) : undefined;
  return { kind: 'agent', connection: t.created_by_connection, role_id: role?.id ?? null, role: role?.slug ?? t.created_by_role, agent: created?.agent ?? null };
}

/** Who handles the task: the claimant if it was claimed, otherwise its role and addressee. */
export function taskAssignee(db: DB, t: TaskRow): TaskParty | null {
  if (t.claimed_by === 'owner') return { kind: 'owner', connection: null, role_id: t.role_id, role: null, agent: null };
  const addressed = t.agent_id ? (get<{ slug: string }>(db, 'SELECT slug FROM agent WHERE id = ?', t.agent_id)?.slug ?? null) : null;
  const agent = t.claimed_agent ?? (t.claimed_by ? null : addressed);
  if (!t.claimed_by && !t.role_id && !agent) return null;
  const role = t.role_id ? get<{ slug: string }>(db, 'SELECT slug FROM role WHERE id = ?', t.role_id)?.slug ?? null : null;
  return { kind: 'agent', connection: t.claimed_by, role_id: t.role_id, role, agent };
}

/** Whether the caller of a write is that party, so it is not told about its own change. */
function isActor(actor: Actor, p: TaskParty): boolean {
  if (p.kind === 'owner') return actor.kind === 'owner';
  if (actor.kind !== 'agent') return false;
  if (p.agent) return actor.agent === p.agent;
  if (actor.agent || actor.connectionId !== p.connection) return false;
  return actor.role ? actor.role === p.role || actor.role === p.role_id : !p.role_id;
}

/**
 * Called when a task moves from an open status to done or cancelled. Journals one `task.closed`
 * notice for the creator, unless the creator closed it or a notice for this task was already written.
 */
export function noticeTaskClosed(db: DB, actor: Actor, t: TaskRow): void {
  const creator = taskCreator(db, t);
  if (!creator || isActor(actor, creator)) return;
  if (get(db, "SELECT 1 FROM event WHERE entity_type = 'task' AND entity_id = ? AND action = 'task.closed' LIMIT 1", t.id)) return;
  recordEvent(db, actor, 'task', t.id, 'task.closed', `Task "${t.title}" ${t.status === 'done' ? 'done' : 'cancelled'}; its creator is notified`, withOwnerRole(db, t.role_id, {
    role_id: t.role_id,
    project_id: t.project_id,
    status: t.status,
    creator,
  }));
}

/** Extra journal data for a comment on a closed task: who should hear about it besides the task's role. */
export function closedCommentData(db: DB, actor: Actor, t: TaskRow): Record<string, unknown> {
  if (!FINISHED.includes(t.status)) return {};
  const creator = taskCreator(db, t);
  const assignee = taskAssignee(db, t);
  return {
    on_closed_task: true,
    status: t.status,
    ...(creator && !isActor(actor, creator) ? { creator } : {}),
    ...(assignee && !isActor(actor, assignee) ? { assignee } : {}),
  };
}

/** Whether the caller of `start` is that party. `roleIds` are the roles this start shows. */
function isCaller(actor: Actor, p: TaskParty | undefined, roleIds: string[]): boolean {
  if (!p) return false;
  if (p.kind === 'owner') return actor.kind === 'owner';
  if (actor.kind !== 'agent') return false;
  if (p.agent && actor.agent) return actor.agent === p.agent;
  const roleFits = !p.role_id || roleIds.length === 0 || roleIds.includes(p.role_id);
  // A caller that names no agent on the platform that recorded one still sees it: missing a notice is worse than a repeat.
  if (p.connection) return actor.connectionId === p.connection && roleFits;
  return !!p.role_id && roleIds.includes(p.role_id);
}

function byCaller(actor: Actor, e: EventRecord): boolean {
  if (e.actor_kind !== actor.kind) return false;
  if (actor.kind === 'owner') return true;
  if ((e.connection_id ?? null) !== (actor.connectionId ?? null) || (e.agent ?? null) !== (actor.agent ?? null)) return false;
  return !!e.agent || !actor.role || e.claimed_role === actor.role;
}

export const INBOX_MAX = 10;
const INBOX_SCAN = 500;

export interface ClosedTaskInbox {
  closed: { task_id: string; title: string; closed_as: string; status: string; closed_at: string; closed_by: string; result: string }[];
  moreClosed: number;
  comments: { task_id: string; title: string; status: string; comment_id: string; comment: string; by: string; at: string; you_are: string[] }[];
  moreComments: number;
}

/**
 * The closed-task part of the session inbox for a `start` call: closes of tasks the caller created and
 * comments on closed tasks it created or handled, from events after `after` up to `upTo` (the same
 * window as `changes_since_previous_start`), newest first.
 */
export function closedTaskInbox(db: DB, actor: Actor, roleIds: string[], after: number, upTo: number): ClosedTaskInbox {
  const out: ClosedTaskInbox = { closed: [], moreClosed: 0, comments: [], moreComments: 0 };
  if (actor.kind !== 'agent' || upTo <= after) return out;
  const events = all(
    db,
    `SELECT * FROM event WHERE member_id = ? AND entity_type = 'task' AND id > ? AND id <= ?
       AND (action = 'task.closed' OR (action = 'task.commented' AND json_extract(data, '$.on_closed_task') = 1))
     ORDER BY id DESC LIMIT ?`,
    actor.memberId,
    after,
    upTo,
    INBOX_SCAN,
  ).map(parseEvent);
  const task = (id: string) => get<TaskRow>(db, 'SELECT * FROM task WHERE id = ?', id);
  for (const e of events) {
    const d = e.data as { status?: string; comment_id?: string; creator?: TaskParty; assignee?: TaskParty };
    if (e.action === 'task.closed') {
      if (!isCaller(actor, d.creator, roleIds)) continue;
      if (out.closed.length >= INBOX_MAX) {
        out.moreClosed++;
        continue;
      }
      const t = task(e.entity_id!);
      if (!t) continue;
      out.closed.push({ task_id: t.id, title: t.title, closed_as: d.status ?? t.status, status: t.status, closed_at: e.at, closed_by: actorLabel(e), result: t.result });
      continue;
    }
    if (byCaller(actor, e)) continue;
    const you = [...(isCaller(actor, d.creator, roleIds) ? ['creator'] : []), ...(isCaller(actor, d.assignee, roleIds) ? ['assignee'] : [])];
    if (!you.length) continue;
    if (out.comments.length >= INBOX_MAX) {
      out.moreComments++;
      continue;
    }
    const t = task(e.entity_id!);
    const c = d.comment_id ? get<{ body: string }>(db, 'SELECT body FROM task_comment WHERE id = ?', d.comment_id) : undefined;
    if (!t || !c) continue;
    out.comments.push({ task_id: t.id, title: t.title, status: t.status, comment_id: d.comment_id!, comment: c.body, by: actorLabel(e), at: e.at, you_are: you });
  }
  return out;
}

/** The inbox as `start` returns it, with long texts as previews. Empty parts are left out. */
export function inboxView(inbox: ClosedTaskInbox, pv: number = LIMITS.preview): Record<string, unknown> {
  return {
    ...(inbox.closed.length
      ? {
          closed_tasks_you_created: inbox.closed.map((c) => ({ ...c, title: preview(c.title, pv), result: preview(c.result, pv) })),
          ...(inbox.moreClosed ? { more_closed_tasks_you_created: inbox.moreClosed } : {}),
        }
      : {}),
    ...(inbox.comments.length
      ? {
          comments_on_closed_tasks: inbox.comments.map((c) => ({ ...c, title: preview(c.title, pv), comment: preview(c.comment, pv) })),
          ...(inbox.moreComments ? { more_comments_on_closed_tasks: inbox.moreComments } : {}),
        }
      : {}),
  };
}
