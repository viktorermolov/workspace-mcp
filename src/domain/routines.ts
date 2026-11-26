import { all, get, now, run, tx, type DB } from '../db/db.ts';
import { checkLen, checkRev, idempotent, indexEntity, invalid, LIMITS, newId, notFound, recordEvent, type Actor } from './core.ts';
import { assertCanEdit, withOwnerRole } from './access.ts';
import { requireRole } from './entities.ts';

export const ROUTINE_STATUSES = ['enabled', 'paused'] as const;
export type RoutineStatus = (typeof ROUTINE_STATUSES)[number];

export interface RoutineRow {
  id: string;
  member_id: string;
  role_id: string;
  name: string;
  schedule: string;
  timezone: string;
  status: RoutineStatus;
  external_id: string | null;
  last_run_at: string | null;
  last_run_result: string;
  rev: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export function requireRoutine(db: DB, memberId: string, id: string): RoutineRow {
  const r = get<RoutineRow>(db, 'SELECT * FROM routine WHERE member_id = ? AND id = ?', memberId, id);
  if (!r) throw notFound('routine', id);
  return r;
}

export function listRoutines(db: DB, memberId: string, opts: { roleId?: string; includeArchived?: boolean } = {}): RoutineRow[] {
  const conds = ['r.member_id = ?'];
  const vals: unknown[] = [memberId];
  if (opts.roleId) (conds.push('r.role_id = ?'), vals.push(opts.roleId));
  if (!opts.includeArchived) conds.push('r.archived_at IS NULL');
  return all<RoutineRow>(db, `SELECT r.* FROM routine r WHERE ${conds.join(' AND ')} ORDER BY r.name, r.id`, ...vals);
}

function roleSlug(db: DB, roleId: string): string {
  return get<{ slug: string }>(db, 'SELECT slug FROM role WHERE id = ?', roleId)?.slug ?? roleId;
}

export function routineView(db: DB, r: RoutineRow) {
  return {
    id: r.id,
    name: r.name,
    role: roleSlug(db, r.role_id),
    role_id: r.role_id,
    schedule: r.schedule,
    timezone: r.timezone,
    status: r.status,
    external_id: r.external_id,
    last_run_at: r.last_run_at,
    last_run_result: r.last_run_result,
    rev: r.rev,
    archived: !!r.archived_at,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export function routineSummary(db: DB, r: RoutineRow, resultMax = LIMITS.preview) {
  const result = r.last_run_result;
  return {
    id: r.id,
    name: r.name,
    role: roleSlug(db, r.role_id),
    schedule: r.schedule,
    timezone: r.timezone,
    status: r.status,
    last_run_at: r.last_run_at,
    last_run_result: result.length > resultMax ? `${result.slice(0, resultMax)}… (${result.length - resultMax} more characters, use get for the full text)` : result,
    archived: !!r.archived_at,
  };
}

export function indexRoutine(db: DB, r: RoutineRow): void {
  indexEntity(
    db,
    r.member_id,
    'routine',
    r.id,
    r.name,
    [r.schedule, r.timezone, r.status, r.external_id ?? '', r.last_run_result].filter(Boolean).join('\n'),
  );
}

export interface SaveRoutineInput {
  id?: string;
  rev?: number;
  name?: string;
  role?: string;
  schedule?: string;
  timezone?: string;
  status?: RoutineStatus;
  external_id?: string | null;
  last_run_at?: string | null;
  last_run_result?: string;
  idempotency_key?: string;
}

function assertTimeZone(tz: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format();
  } catch {
    throw invalid(`unknown timezone "${tz}"; use an IANA name such as America/Los_Angeles`);
  }
}

function assertTime(field: string, value: string): void {
  if (!Number.isFinite(Date.parse(value))) throw invalid(`${field} must be an ISO 8601 timestamp`);
}

function requireActiveRole(db: DB, memberId: string, ref: string) {
  const role = requireRole(db, memberId, ref);
  if (role.archived_at) throw invalid(`role "${ref}" is archived; restore it before attaching a routine`);
  return role;
}

export function saveRoutine(db: DB, actor: Actor, input: SaveRoutineInput) {
  checkLen('name', input.name, LIMITS.title);
  checkLen('schedule', input.schedule, LIMITS.shortText);
  checkLen('timezone', input.timezone, 100);
  checkLen('external_id', input.external_id, 200);
  checkLen('last_run_result', input.last_run_result, LIMITS.shortText);
  if (input.timezone !== undefined) {
    if (!input.timezone.trim()) throw invalid('timezone must not be empty');
    assertTimeZone(input.timezone);
  }
  if (input.status !== undefined && !(ROUTINE_STATUSES as readonly string[]).includes(input.status)) {
    throw invalid(`status must be ${ROUTINE_STATUSES.join(' or ')}`);
  }
  if (input.last_run_at) assertTime('last_run_at', input.last_run_at);
  return tx(db, () => {
    if (!input.id) {
      return idempotent(db, actor.memberId, input.idempotency_key, 'save_routine', () => {
        if (!input.name?.trim()) throw invalid('name is required to create a routine');
        if (!input.role?.trim()) throw invalid('role is required to create a routine');
        if (!input.schedule?.trim()) throw invalid('schedule is required to create a routine');
        const role = requireActiveRole(db, actor.memberId, input.role);
        assertCanEdit(db, actor, role.id, { what: 'routine' });
        const tz = input.timezone?.trim() || 'UTC';
        assertTimeZone(tz);
        const id = newId('rtn');
        const at = now();
        run(
          db,
          `INSERT INTO routine (id, member_id, role_id, name, schedule, timezone, status, external_id, last_run_at, last_run_result, rev, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?)`,
          id,
          actor.memberId,
          role.id,
          input.name.trim(),
          input.schedule.trim(),
          tz,
          input.status ?? 'enabled',
          input.external_id === undefined ? null : input.external_id,
          input.last_run_at ?? null,
          input.last_run_result ?? '',
          at,
          at,
        );
        const row = requireRoutine(db, actor.memberId, id);
        indexRoutine(db, row);
        recordEvent(db, actor, 'routine', id, 'routine.created', `Routine "${row.name}" created`, withOwnerRole(db, role.id, { role: role.slug, status: row.status }));
        return routineView(db, row);
      });
    }
    const row = requireRoutine(db, actor.memberId, input.id);
    assertCanEdit(db, actor, row.role_id, { what: 'routine' });
    checkRev('routine', row.id, row.rev, input.rev);
    const changed: string[] = [];
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (input.name !== undefined && input.name.trim() !== row.name) {
      if (!input.name.trim()) throw invalid('name must not be empty');
      sets.push('name = ?');
      vals.push(input.name.trim());
      changed.push('name');
    }
    if (input.role !== undefined) {
      const role = requireActiveRole(db, actor.memberId, input.role);
      assertCanEdit(db, actor, role.id, { what: 'routine' });
      if (role.id !== row.role_id) {
        sets.push('role_id = ?');
        vals.push(role.id);
        changed.push('role');
      }
    }
    if (input.schedule !== undefined && input.schedule.trim() !== row.schedule) {
      if (!input.schedule.trim()) throw invalid('schedule must not be empty');
      sets.push('schedule = ?');
      vals.push(input.schedule.trim());
      changed.push('schedule');
    }
    if (input.timezone !== undefined && input.timezone !== row.timezone) {
      sets.push('timezone = ?');
      vals.push(input.timezone);
      changed.push('timezone');
    }
    if (input.status !== undefined && input.status !== row.status) {
      sets.push('status = ?');
      vals.push(input.status);
      changed.push('status');
    }
    if (input.external_id !== undefined && input.external_id !== row.external_id) {
      sets.push('external_id = ?');
      vals.push(input.external_id);
      changed.push('external_id');
    }
    if (input.last_run_at !== undefined && input.last_run_at !== row.last_run_at) {
      sets.push('last_run_at = ?');
      vals.push(input.last_run_at);
      changed.push('last_run_at');
    }
    if (input.last_run_result !== undefined && input.last_run_result !== row.last_run_result) {
      sets.push('last_run_result = ?');
      vals.push(input.last_run_result);
      changed.push('last_run_result');
    }
    if (changed.length === 0) return { ...routineView(db, row), unchanged: true };
    sets.push('rev = rev + 1', 'updated_at = ?');
    vals.push(now(), row.id);
    run(db, `UPDATE routine SET ${sets.join(', ')} WHERE id = ?`, ...vals);
    const updated = requireRoutine(db, actor.memberId, row.id);
    indexRoutine(db, updated);
    recordEvent(db, actor, 'routine', updated.id, 'routine.updated', `Routine "${updated.name}" updated: ${changed.join(', ')}`, withOwnerRole(db, updated.role_id, { changed }));
    return routineView(db, updated);
  });
}
