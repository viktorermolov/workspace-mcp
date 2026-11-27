import { all, get, now, run, tx, type DB } from '../db/db.ts';
import { checkLen, checkRev, DomainError, idempotent, indexEntity, invalid, LIMITS, newId, notFound, recordEvent, type Actor } from './core.ts';
import { actorRoutesTasks, agentMayTake, assertCanEdit, auditRoleCheck, withOwnerRole } from './access.ts';
import { findRole, requireProject, requireRole } from './entities.ts';

export const TASK_STATUSES = ['open', 'in_progress', 'blocked', 'in_review', 'done', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type Priority = (typeof PRIORITIES)[number];
const FINISHED: TaskStatus[] = ['done', 'cancelled'];

export interface TaskRow {
  id: string;
  member_id: string;
  title: string;
  description: string;
  status: TaskStatus;
  role_id: string | null;
  project_id: string | null;
  parent_id: string | null;
  priority: Priority;
  due_date: string | null;
  result: string;
  blocking_reason: string;
  claimed_by: string | null;
  claimed_role: string | null;
  /** The one agent this task is addressed to, besides its role (null: any agent with the role). */
  agent_id: string | null;
  claimed_agent: string | null;
  created_by_kind: string;
  created_by_connection: string | null;
  created_by_role: string | null;
  rev: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export function requireTask(db: DB, memberId: string, id: string): TaskRow {
  const t = get<TaskRow>(db, 'SELECT * FROM task WHERE member_id = ? AND id = ?', memberId, id);
  if (!t) throw notFound('task', id);
  return t;
}

function slugOf(db: DB, table: 'role' | 'project' | 'agent', id: string | null): string | null {
  if (!id) return null;
  return get<{ slug: string }>(db, `SELECT slug FROM ${table} WHERE id = ?`, id)?.slug ?? null;
}

export function taskSummary(db: DB, t: TaskRow) {
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    priority: t.priority,
    role: slugOf(db, 'role', t.role_id),
    project: slugOf(db, 'project', t.project_id),
    for_agent: slugOf(db, 'agent', t.agent_id),
    parent_id: t.parent_id,
    due_date: t.due_date,
    rev: t.rev,
    updated_at: t.updated_at,
  };
}

export function taskView(db: DB, t: TaskRow, opts: { comments?: boolean; commentsBefore?: string } = {}) {
  const deps = all<{ depends_on_id: string; title: string; status: string }>(
    db,
    'SELECT d.depends_on_id, t.title, t.status FROM task_dependency d JOIN task t ON t.id = d.depends_on_id WHERE d.task_id = ?',
    t.id,
  );
  const children = all<{ id: string; title: string; status: string }>(db, 'SELECT id, title, status FROM task WHERE parent_id = ? ORDER BY created_at LIMIT 100', t.id);
  const childCount = children.length < 100 ? children.length : get<{ n: number }>(db, 'SELECT count(*) AS n FROM task WHERE parent_id = ?', t.id)!.n;
  const conn = t.claimed_by ? get<{ name: string }>(db, 'SELECT name FROM connection WHERE client_id = ?', t.claimed_by)?.name : null;
  const out: Record<string, unknown> = {
    ...taskSummary(db, t),
    description: t.description,
    result: t.result,
    blocking_reason: t.blocking_reason,
    claimed_by: t.claimed_by ? { connection: conn ?? t.claimed_by, role: t.claimed_role, ...(t.claimed_agent ? { agent: t.claimed_agent } : {}) } : null,
    created_by: t.created_by_kind === 'owner' ? 'owner' : { role: t.created_by_role },
    depends_on: deps.slice(0, 100).map((d) => ({ id: d.depends_on_id, title: d.title, status: d.status })),
    ...(deps.length > 100 ? { more_dependencies: deps.length - 100 } : {}),
    subtasks: children,
    ...(childCount > 100 ? { more_subtasks: childCount - 100 } : {}),
    archived: !!t.archived_at,
    created_at: t.created_at,
  };
  if (opts.comments) {
    // The newest page of comments, oldest first within the page; `comments_cursor` pages back.
    const before = opts.commentsBefore ? decodeCommentCursor(opts.commentsBefore) : null;
    const page = all<{ id: string; rowid: number; body: string; actor_kind: string; connection_name: string | null; claimed_role: string | null; agent: string | null; created_at: string }>(
      db,
      `SELECT rowid, id, body, actor_kind, connection_name, claimed_role, agent, created_at FROM task_comment WHERE task_id = ? ${before ? 'AND rowid < ?' : ''} ORDER BY rowid DESC LIMIT ?`,
      ...(before ? [t.id, before, LIMITS.commentPage + 1] : [t.id, LIMITS.commentPage + 1]),
    );
    const more = page.length > LIMITS.commentPage;
    const shown = page.slice(0, LIMITS.commentPage).reverse();
    out.comments = shown.map(({ rowid: _r, ...c }) => c);
    out.comments_total = get<{ n: number }>(db, 'SELECT count(*) AS n FROM task_comment WHERE task_id = ?', t.id)!.n;
    out.comments_cursor = more ? `c${shown[0]!.rowid}` : null;
  }
  return out;
}

function decodeCommentCursor(c: string): number {
  const n = /^c(\d+)$/.exec(c);
  if (!n) throw invalid('cursor is not a comments cursor from get(task)');
  return Number(n[1]);
}

function assertNoParentCycle(db: DB, taskId: string, parentId: string): void {
  if (taskId === parentId) throw invalid('a task cannot be its own parent');
  const hit = get(
    db,
    `WITH RECURSIVE up(id) AS (SELECT ? UNION SELECT t.parent_id FROM task t JOIN up ON t.id = up.id WHERE t.parent_id IS NOT NULL)
     SELECT 1 FROM up WHERE id = ?`,
    parentId,
    taskId,
  );
  if (hit) throw invalid('this parent would create a cycle in the task hierarchy');
}

function assertNoDependencyCycle(db: DB, taskId: string, dependsOn: string): void {
  if (taskId === dependsOn) throw invalid('a task cannot depend on itself');
  const hit = get(
    db,
    `WITH RECURSIVE reach(id) AS (SELECT ? UNION SELECT d.depends_on_id FROM task_dependency d JOIN reach ON d.task_id = reach.id)
     SELECT 1 FROM reach WHERE id = ?`,
    dependsOn,
    taskId,
  );
  if (hit) throw invalid(`depending on ${dependsOn} would create a dependency cycle`);
}

export function indexTask(db: DB, t: TaskRow): void {
  indexEntity(db, t.member_id, 'task', t.id, t.title, `${t.description}\n${t.result}\n${t.blocking_reason}`);
}

function validDate(d: string | null | undefined): void {
  if (d == null) return;
  if (!/^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2})?)?$/.test(d) || Number.isNaN(Date.parse(d))) throw invalid('due_date must be an ISO date, e.g. 2026-12-31');
}

export interface SaveTaskInput {
  id?: string;
  rev?: number;
  title?: string;
  description?: string;
  status?: TaskStatus;
  role?: string | null;
  project?: string | null;
  /** Agent slug or id the task is addressed to, or null for any agent with the role. */
  for_agent?: string | null;
  parent_id?: string | null;
  depends_on?: string[];
  priority?: Priority;
  due_date?: string | null;
  result?: string;
  blocking_reason?: string;
  idempotency_key?: string;
}

function emitDependentsUnblocked(db: DB, actor: Actor, finishedId: string): void {
  const dependents = all<{ task_id: string }>(db, 'SELECT task_id FROM task_dependency WHERE depends_on_id = ?', finishedId);
  for (const d of dependents) {
    const open = get<{ n: number }>(
      db,
      `SELECT count(*) AS n FROM task_dependency dd JOIN task t ON t.id = dd.depends_on_id WHERE dd.task_id = ? AND t.status NOT IN ('done','cancelled')`,
      d.task_id,
    )!;
    if (open.n === 0) {
      const t = get<TaskRow>(db, 'SELECT * FROM task WHERE id = ?', d.task_id);
      if (t && !FINISHED.includes(t.status)) {
        recordEvent(db, actor, 'task', t.id, 'task.unblocked', `All dependencies of task "${t.title}" are finished`, withOwnerRole(db, t.role_id, { role_id: t.role_id }));
      }
    }
  }
}

export function saveTask(db: DB, actor: Actor, input: SaveTaskInput) {
  checkLen('title', input.title, LIMITS.title);
  checkLen('description', input.description, LIMITS.text);
  checkLen('result', input.result, LIMITS.text);
  checkLen('blocking_reason', input.blocking_reason, LIMITS.shortText);
  validDate(input.due_date);
  if (input.status && !TASK_STATUSES.includes(input.status)) throw invalid(`status must be one of ${TASK_STATUSES.join(', ')}`);
  if (input.priority && !PRIORITIES.includes(input.priority)) throw invalid(`priority must be one of ${PRIORITIES.join(', ')}`);
  if (input.depends_on && input.depends_on.length > 50) throw invalid('at most 50 dependencies');
  return tx(db, () => {
    const roleId = input.role === undefined ? undefined : input.role === null ? null : requireRole(db, actor.memberId, input.role).id;
    const projectId = input.project === undefined ? undefined : input.project === null ? null : requireProject(db, actor.memberId, input.project).id;
    if (input.parent_id) requireTask(db, actor.memberId, input.parent_id);
    for (const dep of input.depends_on ?? []) requireTask(db, actor.memberId, dep);
    const agentId = input.for_agent === undefined ? undefined : input.for_agent === null || input.for_agent === '' ? null : requireTaskAgent(db, actor.memberId, input.for_agent);

    if (!input.id) {
      return idempotent(db, actor.memberId, input.idempotency_key, 'save_task', () => {
        if (!input.title?.trim()) throw invalid('title is required to create a task');
        if (agentId) assertAgentFitsRole(db, agentId, roleId ?? null);
        const status = input.status ?? 'open';
        if (status === 'blocked' && !input.blocking_reason) throw invalid('blocking_reason is required when status is blocked');
        const id = newId('task');
        const at = now();
        run(
          db,
          `INSERT INTO task (id, member_id, title, description, status, role_id, project_id, agent_id, parent_id, priority, due_date, result, blocking_reason,
             created_by_kind, created_by_connection, created_by_role, rev, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`,
          id,
          actor.memberId,
          input.title.trim(),
          input.description ?? '',
          status,
          roleId ?? null,
          projectId ?? null,
          agentId ?? null,
          input.parent_id ?? null,
          input.priority ?? 'normal',
          input.due_date ?? null,
          input.result ?? '',
          input.blocking_reason ?? '',
          actor.kind,
          actor.connectionId ?? null,
          actor.role ?? null,
          at,
          at,
        );
        for (const dep of input.depends_on ?? []) {
          assertNoDependencyCycle(db, id, dep);
          run(db, 'INSERT OR IGNORE INTO task_dependency (task_id, depends_on_id) VALUES (?,?)', id, dep);
        }
        const t = requireTask(db, actor.memberId, id);
        indexTask(db, t);
        recordEvent(db, actor, 'task', id, 'task.created', `Task "${t.title}" created${roleId ? ` for ${slugOf(db, 'role', roleId)}` : ''}`, withOwnerRole(db, t.role_id, {
          role_id: t.role_id,
          project_id: t.project_id,
          status: t.status,
          from_role: actor.role ?? null,
        }));
        if (t.role_id) recordEvent(db, actor, 'task', id, 'task.assigned', `Task "${t.title}" assigned to ${slugOf(db, 'role', t.role_id)}`, withOwnerRole(db, t.role_id, { role_id: t.role_id, from_role: actor.role ?? null }));
        return taskView(db, t);
      });
    }

    const t = requireTask(db, actor.memberId, input.id);
    // A coordinator role may change who a task is addressed to on any task, and only that (#148).
    const others = [input.title, input.description, input.status, input.role, input.project, input.parent_id, input.depends_on, input.priority, input.due_date, input.result, input.blocking_reason];
    const routingOnly = input.for_agent !== undefined && others.every((v) => v === undefined);
    if (!(routingOnly && actorRoutesTasks(db, actor))) assertCanEdit(db, actor, t.role_id, { what: 'task' });
    checkRev('task', t.id, t.rev, input.rev);
    const statusChanging = input.status !== undefined && input.status !== t.status;
    const resultChanging = input.result !== undefined && input.result !== t.result;
    const blockingChanging = input.blocking_reason !== undefined && input.blocking_reason !== t.blocking_reason;
    const reassignToSelf =
      actor.kind === 'agent' &&
      !!actor.agent &&
      agentId !== undefined &&
      agentId !== null &&
      slugOf(db, 'agent', agentId) === actor.agent &&
      actor.agent !== slugOf(db, 'agent', t.agent_id) &&
      actor.agent !== (t.claimed_agent ?? null);
    if (
      (statusChanging || resultChanging || blockingChanging || reassignToSelf) &&
      !(routingOnly && actorRoutesTasks(db, actor))
    ) {
      assertTaskHandler(db, actor, t);
    }
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    const sets: string[] = [];
    const vals: unknown[] = [];
    const setField = (col: keyof TaskRow, value: unknown) => {
      if (value === undefined || value === t[col]) return;
      changes[col] = { from: t[col], to: value };
      sets.push(`${col} = ?`);
      vals.push(value);
    };
    if (input.title !== undefined && !input.title.trim()) throw invalid('title must not be empty');
    setField('title', input.title?.trim());
    setField('description', input.description);
    setField('status', input.status);
    setField('role_id', roleId);
    setField('project_id', projectId);
    setField('agent_id', agentId);
    {
      const nextAgent = agentId === undefined ? t.agent_id : agentId;
      const nextRole = roleId === undefined ? t.role_id : roleId;
      if (nextAgent && (agentId !== undefined || roleId !== undefined)) assertAgentFitsRole(db, nextAgent, nextRole);
    }
    if (input.parent_id !== undefined && input.parent_id !== t.parent_id) {
      if (input.parent_id) assertNoParentCycle(db, t.id, input.parent_id);
      setField('parent_id', input.parent_id);
    }
    setField('priority', input.priority);
    setField('due_date', input.due_date);
    setField('result', input.result);
    setField('blocking_reason', input.blocking_reason);
    const newStatus = input.status ?? t.status;
    if (newStatus === 'blocked' && !(input.blocking_reason ?? t.blocking_reason)) throw invalid('blocking_reason is required when status is blocked');
    if (input.status === 'open' && t.status !== 'open') {
      sets.push('claimed_by = NULL', 'claimed_role = NULL', 'claimed_agent = NULL');
    }
    let depsChanged = false;
    if (input.depends_on) {
      const before = all<{ depends_on_id: string }>(db, 'SELECT depends_on_id FROM task_dependency WHERE task_id = ?', t.id).map((r) => r.depends_on_id).sort();
      const after = [...new Set(input.depends_on)].sort();
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        run(db, 'DELETE FROM task_dependency WHERE task_id = ?', t.id);
        for (const dep of after) {
          assertNoDependencyCycle(db, t.id, dep);
          run(db, 'INSERT INTO task_dependency (task_id, depends_on_id) VALUES (?,?)', t.id, dep);
        }
        changes.depends_on = { from: before, to: after };
        depsChanged = true;
      }
    }
    if (sets.length === 0 && !depsChanged) return { ...taskView(db, t), unchanged: true };
    sets.push('rev = rev + 1', 'updated_at = ?');
    vals.push(now(), t.id);
    run(db, `UPDATE task SET ${sets.join(', ')} WHERE id = ?`, ...vals);
    const u = requireTask(db, actor.memberId, t.id);
    indexTask(db, u);
    recordEvent(db, actor, 'task', t.id, 'task.updated', `Task "${u.title}" updated: ${Object.keys(changes).join(', ')}`, withOwnerRole(db, u.role_id, {
      role_id: u.role_id,
      project_id: u.project_id,
      changes,
    }));
    if (changes.role_id && u.role_id) {
      recordEvent(db, actor, 'task', t.id, 'task.assigned', `Task "${u.title}" assigned to ${slugOf(db, 'role', u.role_id)}`, withOwnerRole(db, u.role_id, { role_id: u.role_id, from_role: actor.role ?? null }));
    }
    if (changes.status && FINISHED.includes(u.status) && !FINISHED.includes(t.status)) emitDependentsUnblocked(db, actor, u.id);
    return taskView(db, u);
  });
}

function requireTaskAgent(db: DB, memberId: string, ref: string): string {
  const a = get<{ id: string }>(db, 'SELECT id FROM agent WHERE member_id = ? AND (id = ? OR slug = ?)', memberId, ref, ref);
  if (!a) throw invalid(`agent not found: ${ref}`);
  return a.id;
}

/** A task addressed to an agent must have a role that agent may take, so the agent sees it under that role. */
function assertAgentFitsRole(db: DB, agentId: string, roleId: string | null): void {
  const slug = slugOf(db, 'agent', agentId);
  if (!roleId) throw invalid(`a task addressed to agent "${slug}" needs a role: pass role as well`);
  if (!agentMayTake(db, agentId, roleId)) throw invalid(`agent "${slug}" may not take the role "${slugOf(db, 'role', roleId)}", so it would never see this task`);
}

function taskHandlerConflict(taskId: string, kind: 'addressed' | 'claimed', slug: string, actor: Actor): DomainError {
  const who = actor.agent ? '' : ' This call named no agent: pass agent if the task is yours.';
  if (kind === 'addressed') {
    return new DomainError(
      'conflict',
      `task ${taskId} is addressed to agent "${slug}"; it can be claimed by that agent, or re-addressed with save_task (for_agent).${who}`,
      { for_agent: slug },
    );
  }
  return new DomainError(
    'conflict',
    `task ${taskId} is claimed by agent "${slug}"; it can be claimed by that agent, or re-addressed with save_task (for_agent).${who}`,
    { claimed_agent: slug },
  );
}

/**
 * On a task addressed to an agent (`for_agent`) or claimed by a named agent, only that
 * agent (or the owner) may change status, result or blocking_reason, reopen it, or
 * address it to themselves. A coordinator may still re-address it (routing only).
 * In both warn and enforce mode this is the same `conflict` as claim_task; the write
 * does not proceed, and the refusal is audited.
 */
function assertTaskHandler(db: DB, actor: Actor, t: TaskRow): void {
  if (actor.kind !== 'agent') return;
  const addressed = slugOf(db, 'agent', t.agent_id);
  const claimed = t.claimed_agent ?? null;
  const handler = addressed || claimed;
  if (!handler) return;
  if (actor.agent === handler) return;
  const kind: 'addressed' | 'claimed' = addressed ? 'addressed' : 'claimed';
  const slug = addressed || claimed!;
  const err = taskHandlerConflict(t.id, kind, slug, actor);
  const reason = kind === 'addressed' ? 'task_addressed' : 'task_claimed';
  const detail = { reason, agent: actor.agent ?? null, ...(kind === 'addressed' ? { for_agent: slug } : { claimed_agent: slug }) };
  auditRoleCheck(db, actor, 'rejected', detail, 409);
  throw err;
}

/** Atomic claim: only one caller can move an open, unclaimed task to in_progress. */
export function claimTask(db: DB, actor: Actor, input: { id: string; role?: string }) {
  return tx(db, () => {
    const t = requireTask(db, actor.memberId, input.id);
    assertCanEdit(db, actor, t.role_id, { what: 'task' });
    const addressed = slugOf(db, 'agent', t.agent_id);
    // A call that names no agent is not the addressee either: a bot that forgot to pass agent must not take another agent's task.
    if (addressed && actor.kind === 'agent' && actor.agent !== addressed) {
      throw taskHandlerConflict(t.id, 'addressed', addressed, actor);
    }
    const assign = input.role
      ? requireRole(db, actor.memberId, input.role)
      : actor.role
        ? findRole(db, actor.memberId, actor.role)
        : undefined;
    const res = run(
      db,
      `UPDATE task SET status = 'in_progress', claimed_by = ?, claimed_role = ?, claimed_agent = ?, role_id = COALESCE(role_id, ?), rev = rev + 1, updated_at = ?
       WHERE id = ? AND status = 'open' AND claimed_by IS NULL AND archived_at IS NULL`,
      actor.connectionId ?? 'owner',
      actor.role ?? input.role ?? null,
      actor.agent ?? null,
      assign?.id ?? null,
      now(),
      t.id,
    );
    if (Number(res.changes) !== 1) {
      const cur = requireTask(db, actor.memberId, t.id);
      throw new DomainError('conflict', `task ${t.id} cannot be claimed: status is ${cur.status}${cur.claimed_by ? ', already claimed' : ''}${cur.archived_at ? ', archived' : ''}`, {
        status: cur.status,
      });
    }
    const u = requireTask(db, actor.memberId, t.id);
    recordEvent(db, actor, 'task', t.id, 'task.claimed', `Task "${u.title}" claimed`, withOwnerRole(db, u.role_id, { role_id: u.role_id }));
    return taskView(db, u);
  });
}

export function commentTask(db: DB, actor: Actor, input: { id: string; body: string; idempotency_key?: string }) {
  checkLen('body', input.body, LIMITS.comment);
  if (!input.body?.trim()) throw invalid('comment body must not be empty');
  return tx(db, () =>
    idempotent(db, actor.memberId, input.idempotency_key, 'comment_task', () => {
      const t = requireTask(db, actor.memberId, input.id);
      const id = newId('cmt');
      run(
        db,
        'INSERT INTO task_comment (id, member_id, task_id, body, actor_kind, connection_id, connection_name, claimed_role, agent, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
        id,
        actor.memberId,
        t.id,
        input.body,
        actor.kind,
        actor.connectionId ?? null,
        actor.connectionName ?? null,
        actor.role ?? null,
        actor.agent ?? null,
        now(),
      );
      recordEvent(db, actor, 'task', t.id, 'task.commented', `Comment on task "${t.title}"`, withOwnerRole(db, t.role_id, { role_id: t.role_id, comment_id: id, from_role: actor.role ?? null }));
      return { comment_id: id, task_id: t.id };
    }),
  );
}

// ---------- checkpoints ----------

export function writeCheckpoint(db: DB, actor: Actor, input: { role: string; project?: string; done: string; stopped_at: string; next: string; idempotency_key?: string }) {
  for (const f of ['done', 'stopped_at', 'next'] as const) {
    checkLen(f, input[f], LIMITS.text);
    if (!input[f]?.trim()) throw invalid(`${f} must not be empty`);
  }
  return tx(db, () =>
    idempotent(db, actor.memberId, input.idempotency_key, 'checkpoint', () => {
      const role = requireRole(db, actor.memberId, input.role);
      assertCanEdit(db, actor, role.id, { what: 'checkpoint' });
      const project = input.project ? requireProject(db, actor.memberId, input.project) : undefined;
      const id = newId('chk');
      const at = now();
      run(
        db,
        `INSERT INTO checkpoint (id, member_id, role_id, project_id, done, stopped_at, next, actor_kind, connection_id, connection_name, claimed_role, agent, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        id,
        actor.memberId,
        role.id,
        project?.id ?? null,
        input.done,
        input.stopped_at,
        input.next,
        actor.kind,
        actor.connectionId ?? null,
        actor.connectionName ?? null,
        actor.role ?? role.slug,
        actor.agent ?? null,
        at,
      );
      recordEvent(db, actor, 'checkpoint', id, 'checkpoint.created', `Checkpoint for ${role.slug}${project ? ` / ${project.slug}` : ''}`, withOwnerRole(db, role.id, {
        role_id: role.id,
        project_id: project?.id ?? null,
      }));
      return { id, role: role.slug, project: project?.slug ?? null, created_at: at };
    }),
  );
}

export function lastCheckpoint(db: DB, memberId: string, roleId: string, projectId?: string, agent?: string) {
  return get<Record<string, unknown>>(
    db,
    `SELECT c.id, c.done, c.stopped_at, c.next, c.created_at, c.connection_name, c.agent, p.slug AS project
     FROM checkpoint c LEFT JOIN project p ON p.id = c.project_id
     WHERE c.member_id = ? AND c.role_id = ? ${projectId ? 'AND c.project_id = ?' : ''} ${agent ? 'AND c.agent = ?' : ''} ORDER BY c.created_at DESC, c.rowid DESC LIMIT 1`,
    ...[memberId, roleId, ...(projectId ? [projectId] : []), ...(agent ? [agent] : [])],
  );
}
