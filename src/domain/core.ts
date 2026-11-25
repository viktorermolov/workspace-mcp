import { randomBytes } from 'node:crypto';
import { all, get, now, run, type DB } from '../db/db.ts';

/** Who is making a change. Agents are identified by their OAuth connection; the role is self-claimed. */
export interface Actor {
  kind: 'owner' | 'agent' | 'system';
  memberId: string;
  connectionId?: string;
  connectionName?: string;
  role?: string;
}

export type ErrorCode = 'not_found' | 'conflict' | 'invalid' | 'forbidden' | 'limit';

export class DomainError extends Error {
  code: ErrorCode;
  details?: Record<string, unknown>;
  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export const notFound = (what: string, id: string) => new DomainError('not_found', `${what} not found: ${id}`);
export const invalid = (msg: string) => new DomainError('invalid', msg);

const alphabet = '0123456789abcdefghjkmnpqrstvwxyz';
export function newId(prefix: string): string {
  const b = randomBytes(12);
  let s = '';
  for (const byte of b) s += alphabet[byte % 32];
  return `${prefix}_${s}`;
}

export function slugify(name: string): string {
  const s = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return s || 'item';
}

/** Maximum serialized size of one MCP tool response (JSON with indent 1). */
export const MAX_RESPONSE_CHARS = 512 * 1024;

export const LIMITS = {
  title: 300,
  shortText: 2000,
  text: 50_000,
  /** Documents and project descriptions. Kept well under the response limit for ordinary text after JSON escaping. */
  document: 200_000,
  /** Working rules and role instructions: both are returned together by `start`. */
  instruction: 100_000,
  comment: 20_000,
  listMax: 100,
  listDefault: 25,
  /** Length of previews of long fields in `start`; the full text is one `get` away. */
  preview: 500,
  /** Comments per page in `get(task)`. */
  commentPage: 10,
};

/** Shortens a long field for an overview. */
export function preview(text: string | null | undefined, max: number = LIMITS.preview): string | null {
  if (text == null) return null;
  return text.length > max ? `${text.slice(0, max)}… (${text.length - max} more characters, use get for the full text)` : text;
}

/** Control characters other than tab and line breaks: no use in Markdown, and each grows sixfold in JSON. */
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/** Checks a text field: its length, no control characters, and well-formed Unicode (no lone surrogates). */
export function checkLen(field: string, value: string | undefined | null, max: number): void {
  if (value == null) return;
  if (value.length > max) throw new DomainError('limit', `${field} is too long (${value.length} > ${max} characters)`);
  if (CONTROL.test(value) || !value.isWellFormed()) throw new DomainError('invalid', `${field} contains control characters or broken Unicode`);
}

/** Hooks other modules attach to (webhooks enqueue deliveries inside the same transaction). */
export interface EventHook {
  (db: DB, event: EventRecord): void;
}
const hooks: EventHook[] = [];
export function onEvent(h: EventHook): void {
  hooks.push(h);
}
export function clearEventHooks(): void {
  hooks.length = 0;
}

export interface EventRecord {
  id: number;
  member_id: string;
  at: string;
  actor_kind: Actor['kind'];
  connection_id: string | null;
  connection_name: string | null;
  claimed_role: string | null;
  entity_type: string;
  entity_id: string | null;
  action: string;
  summary: string;
  data: Record<string, unknown>;
}

/** Appends to the log. Must be called inside the same transaction as the change it records. */
export function recordEvent(
  db: DB,
  actor: Actor,
  entityType: string,
  entityId: string | null,
  action: string,
  summary: string,
  data: Record<string, unknown> = {},
): EventRecord {
  const at = now();
  const res = run(
    db,
    `INSERT INTO event (member_id, at, actor_kind, connection_id, connection_name, claimed_role, entity_type, entity_id, action, summary, data)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    actor.memberId,
    at,
    actor.kind,
    actor.connectionId ?? null,
    actor.connectionName ?? null,
    actor.role ?? null,
    entityType,
    entityId,
    action,
    summary.slice(0, 500),
    JSON.stringify(data),
  );
  const ev: EventRecord = {
    id: Number(res.lastInsertRowid),
    member_id: actor.memberId,
    at,
    actor_kind: actor.kind,
    connection_id: actor.connectionId ?? null,
    connection_name: actor.connectionName ?? null,
    claimed_role: actor.role ?? null,
    entity_type: entityType,
    entity_id: entityId,
    action,
    summary,
    data,
  };
  for (const h of hooks) h(db, ev);
  return ev;
}

export function parseEvent(r: Record<string, unknown>): EventRecord {
  return { ...(r as unknown as EventRecord), data: JSON.parse((r.data as string) || '{}') };
}

// ---------- versions ----------

export type VersionedType = 'rules' | 'role' | 'project' | 'document';
const versionTable: Record<VersionedType, string> = { rules: 'rules', role: 'role', project: 'project', document: 'document' };

export interface VersionRow {
  id: number;
  entity_type: VersionedType;
  entity_id: string;
  number: number;
  body: string;
  actor_kind: string;
  connection_id: string | null;
  connection_name: string | null;
  claimed_role: string | null;
  note: string | null;
  rollback_of: number | null;
  created_at: string;
}

/** Writes a new immutable version and points the entity at it. Returns the version number. */
export function addVersion(
  db: DB,
  actor: Actor,
  type: VersionedType,
  entityId: string,
  body: string,
  note?: string | null,
  rollbackOf?: number | null,
): VersionRow {
  const last = get<{ n: number }>(db, 'SELECT max(number) AS n FROM version WHERE entity_type = ? AND entity_id = ?', type, entityId);
  const number = (last?.n ?? 0) + 1;
  const at = now();
  const res = run(
    db,
    `INSERT INTO version (member_id, entity_type, entity_id, number, body, actor_kind, connection_id, connection_name, claimed_role, note, rollback_of, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    actor.memberId,
    type,
    entityId,
    number,
    body,
    actor.kind,
    actor.connectionId ?? null,
    actor.connectionName ?? null,
    actor.role ?? null,
    note ?? null,
    rollbackOf ?? null,
    at,
  );
  const id = Number(res.lastInsertRowid);
  const keyCol = type === 'rules' ? 'member_id' : 'id';
  run(db, `UPDATE ${versionTable[type]} SET current_version = ? WHERE ${keyCol} = ?`, id, entityId);
  return {
    id,
    entity_type: type,
    entity_id: entityId,
    number,
    body,
    actor_kind: actor.kind,
    connection_id: actor.connectionId ?? null,
    connection_name: actor.connectionName ?? null,
    claimed_role: actor.role ?? null,
    note: note ?? null,
    rollback_of: rollbackOf ?? null,
    created_at: at,
  };
}

export function currentBody(db: DB, versionId: number | null | undefined): string {
  if (!versionId) return '';
  return get<{ body: string }>(db, 'SELECT body FROM version WHERE id = ?', versionId)?.body ?? '';
}

export function listVersions(db: DB, type: VersionedType, entityId: string, limit = 50, before?: number): VersionRow[] {
  return all<VersionRow>(
    db,
    `SELECT id, entity_type, entity_id, number, '' AS body, actor_kind, connection_id, connection_name, claimed_role, note, rollback_of, created_at
     FROM version WHERE entity_type = ? AND entity_id = ? ${before ? 'AND number < ?' : ''} ORDER BY number DESC LIMIT ?`,
    ...(before ? [type, entityId, before, limit] : [type, entityId, limit]),
  );
}

export function getVersion(db: DB, type: VersionedType, entityId: string, number: number): VersionRow {
  const v = get<VersionRow>(db, 'SELECT * FROM version WHERE entity_type = ? AND entity_id = ? AND number = ?', type, entityId, number);
  if (!v) throw notFound('version', `${type}/${entityId}#${number}`);
  return v;
}

// ---------- search index ----------

export function indexEntity(db: DB, memberId: string, type: string, id: string, title: string, body: string): void {
  run(db, 'DELETE FROM search_fts WHERE entity_type = ? AND entity_id = ?', type, id);
  run(db, 'INSERT INTO search_fts (entity_type, entity_id, member_id, title, body) VALUES (?,?,?,?,?)', type, id, memberId, title, body);
}

export function unindexEntity(db: DB, type: string, id: string): void {
  run(db, 'DELETE FROM search_fts WHERE entity_type = ? AND entity_id = ?', type, id);
}

/** Turns free text into a safe FTS5 query: every token becomes a quoted prefix term (implicit AND). */
export function ftsQuery(text: string): string | null {
  const tokens = text.match(/[\p{L}\p{N}_]+/gu);
  if (!tokens || tokens.length === 0) return null;
  return tokens
    .slice(0, 12)
    .map((t) => `"${t.replace(/"/g, '')}"*`)
    .join(' ');
}

// ---------- idempotency ----------

export function idempotent<T>(db: DB, memberId: string, key: string | undefined, operation: string, fn: () => T): T {
  if (!key) return fn();
  const prev = get<{ operation: string; response: string }>(db, 'SELECT operation, response FROM idempotency WHERE member_id = ? AND key = ?', memberId, key);
  if (prev) {
    if (prev.operation !== operation) throw new DomainError('conflict', `idempotency key "${key}" was already used for a different operation (${prev.operation})`);
    return JSON.parse(prev.response) as T;
  }
  const out = fn();
  run(db, 'INSERT INTO idempotency (member_id, key, operation, response, created_at) VALUES (?,?,?,?,?)', memberId, key, operation, JSON.stringify(out), now());
  return out;
}

export function checkRev(entity: string, id: string, current: number, expected: number | undefined): void {
  if (expected === undefined) {
    throw new DomainError('invalid', `rev is required when updating ${entity} ${id}: read it first and pass its current rev (now ${current})`, { current_rev: current });
  }
  if (expected !== current) {
    throw new DomainError('conflict', `${entity} ${id} was changed by someone else: your rev ${expected}, current rev ${current}. Read it again, merge your change and retry.`, {
      current_rev: current,
    });
  }
}

export function actorLabel(r: { actor_kind?: string | null; connection_name?: string | null; claimed_role?: string | null }): string {
  if (r.actor_kind === 'owner') return 'owner';
  if (r.actor_kind === 'system') return 'system';
  const conn = r.connection_name || 'agent';
  return r.claimed_role ? `${conn} as ${r.claimed_role}` : conn;
}
