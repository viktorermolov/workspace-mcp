import { createHash } from 'node:crypto';
import { diffLines } from 'diff';
import { addWarning, auditRoleCheck, documentOwnerRoleId, getEnforcement, withOwnerRole, type RoleWarning } from './access.ts';
import { all, get, now, run, tx, type DB } from '../db/db.ts';
import {
  checkLen,
  DomainError,
  idempotent,
  indexEntity,
  unindexEntity,
  invalid,
  LIMITS,
  newId,
  notFound,
  onVersionAdded,
  preview,
  recordEvent,
  type Actor,
  type VersionRow,
} from './core.ts';

export const TARGET_TYPES = ['rules', 'role', 'project', 'document'] as const;
export type ReviewTargetType = (typeof TARGET_TYPES)[number];
export const REVIEW_FIELDS = ['text', 'instruction', 'setup_notes', 'description', 'body'] as const;
export type ReviewField = (typeof REVIEW_FIELDS)[number];
export const REVIEW_STATUSES = ['open', 'answered', 'resolved'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];
export const ANCHOR_STATES = ['none', 'exact', 'moved', 'outdated'] as const;
export type AnchorState = (typeof ANCHOR_STATES)[number];

const FIELDS: Record<ReviewTargetType, readonly ReviewField[]> = {
  rules: ['text'],
  role: ['instruction', 'setup_notes'],
  project: ['description'],
  document: ['body'],
};

const VERSION_FIELD: Record<ReviewTargetType, ReviewField> = {
  rules: 'text',
  role: 'instruction',
  project: 'description',
  document: 'body',
};

const TARGET_TABLE: Record<ReviewTargetType, string> = {
  rules: 'rules',
  role: 'role',
  project: 'project',
  document: 'document',
};

/** One budget for remapping every open or answered comment on a new version. */
export const REANCHOR_BUDGET_MS = 500;
export const DIFF_BUDGET_MS = 200;
export const DIFF_MAX_EDIT_LENGTH = 10_000;
export const FUZZY_LINE_WINDOW = 20;
export const FUZZY_CHAR_CAP = 8_000;
export const FUZZY_LENGTH_SLACK = 500;
export const FUZZY_SIMILARITY = 0.8;
export const CONTEXT_CHARS = 64;
export const QUOTE_MAX = 500;
/** Max exact-quote hits ranked inside the window (the unique-occurrence fallback is uncapped). */
export const EXACT_HIT_CAP = 32;

export interface ReviewCommentRow {
  id: string;
  member_id: string;
  target_type: ReviewTargetType;
  target_id: string;
  field: ReviewField;
  body: string;
  version_id: number | null;
  line_start: number | null;
  line_end: number | null;
  quote: string;
  quote_hash: string;
  ctx_before: string;
  ctx_after: string;
  text_hash: string | null;
  setup_notes_id: number | null;
  anchor_version_id: number | null;
  anchor_line_start: number | null;
  anchor_line_end: number | null;
  anchor_state: AnchorState;
  status: ReviewStatus;
  rev: number;
  actor_kind: Actor['kind'];
  connection_id: string | null;
  connection_name: string | null;
  claimed_role: string | null;
  created_at: string;
  updated_at: string;
}

export interface ReviewReplyRow {
  id: string;
  member_id: string;
  comment_id: string;
  body: string;
  actor_kind: Actor['kind'];
  connection_id: string | null;
  connection_name: string | null;
  claimed_role: string | null;
  created_at: string;
}

export function normalizeQuote(q: string): string {
  return q.replace(/\s+/g, ' ').trim().toLowerCase();
}

export function quoteHash(q: string): string {
  return createHash('sha256').update(normalizeQuote(q)).digest('hex');
}

export function textHash(q: string): string {
  return createHash('sha256').update(q).digest('hex');
}

function splitLines(text: string): string[] {
  return text.split('\n');
}

function extractRange(text: string, start: number, end: number): string {
  return extractRangeIndexed(text, lineStarts(text), start, end);
}

function stripTrailingCR(s: string): string {
  return s.endsWith('\r') ? s.slice(0, -1) : s;
}

/** The last line in a stored before-slice, ignoring a separating newline and a trailing CR. */
function lastAdjacentLine(stored: string): string {
  let s = stored;
  if (s.endsWith('\n')) s = s.slice(0, -1);
  if (s.endsWith('\r')) s = s.slice(0, -1);
  const i = s.lastIndexOf('\n');
  let line = i < 0 ? s : s.slice(i + 1);
  if (line.endsWith('\r')) line = line.slice(0, -1);
  return line.length > CONTEXT_CHARS ? line.slice(-CONTEXT_CHARS) : line;
}

/** The first line in a stored after-slice, ignoring a separating newline and a trailing CR. */
function firstAdjacentLine(stored: string): string {
  let s = stored;
  if (s.startsWith('\r\n')) s = s.slice(2);
  else if (s.startsWith('\n') || s.startsWith('\r')) s = s.slice(1);
  const i = s.indexOf('\n');
  let line = i < 0 ? s : s.slice(0, i);
  if (line.endsWith('\r')) line = line.slice(0, -1);
  return line.slice(0, CONTEXT_CHARS);
}

function adjacentLineBeforeAt(text: string, index: number): string {
  let end = index;
  if (end > 0 && text[end - 1] === '\n') end--;
  if (end > 0 && text[end - 1] === '\r') end--;
  const start = end === 0 ? 0 : text.lastIndexOf('\n', end - 1) + 1;
  return lastAdjacentLine(text.slice(start, end));
}

function adjacentLineAfterAt(text: string, afterIndex: number): string {
  let start = afterIndex;
  if (text.startsWith('\r\n', start)) start += 2;
  else if (text[start] === '\n' || text[start] === '\r') start += 1;
  const nl = text.indexOf('\n', start);
  const end = nl < 0 ? text.length : nl;
  return firstAdjacentLine(text.slice(start, end));
}

function adjacentBeforeMatch(stored: string, hitLine: string): boolean {
  const a = lastAdjacentLine(stored);
  if (!a && !hitLine) return true;
  if (!a || !hitLine) return false;
  return a === hitLine || hitLine.endsWith(a) || a.endsWith(hitLine);
}

function adjacentAfterMatch(stored: string, hitLine: string): boolean {
  const a = firstAdjacentLine(stored);
  if (!a && !hitLine) return true;
  if (!a || !hitLine) return false;
  return a === hitLine || hitLine.startsWith(a) || a.startsWith(hitLine);
}

/** Unique out-of-window hits: compare only the adjacent line on each side and accept if either matches. */
function uniqueHitContextOk(text: string, index: number, quote: string, ctxBefore: string, ctxAfter: string): boolean {
  const beforeOk = adjacentBeforeMatch(ctxBefore, adjacentLineBeforeAt(text, index));
  const afterOk = adjacentAfterMatch(ctxAfter, adjacentLineAfterAt(text, index + quote.length));
  return beforeOk || afterOk;
}

function contextAround(text: string, start: number, end: number, quote: string): { ctx_before: string; ctx_after: string } {
  const starts = lineStarts(text);
  if (start < 1 || end < start || end > starts.length) {
    throw invalid(`line range ${start}-${end} is outside the text (${starts.length} lines)`);
  }
  // ctx_after is taken right after the stored (possibly truncated) quote, not after the
  // full line range, so a paragraph longer than QUOTE_MAX still has a matching after-slice.
  const from = offsetOfLine(starts, text.length, start);
  const after = from + quote.length;
  return { ctx_before: text.slice(Math.max(0, from - CONTEXT_CHARS), from), ctx_after: text.slice(after, after + CONTEXT_CHARS) };
}

/** True if stored context matches a slice next to a hit, with or without the separating newline.
 *  Older rows saved context without that newline; new rows include it. */
function ctxBeforeOk(stored: string, slice: string): boolean {
  if (!stored) return true;
  if (slice === stored || slice.endsWith(stored)) return true;
  if (slice.endsWith('\n') && (slice.slice(0, -1) === stored || slice.slice(0, -1).endsWith(stored))) return true;
  if (stored.endsWith('\n') && (slice === stored.slice(0, -1) || slice.endsWith(stored.slice(0, -1)))) return true;
  return false;
}

function ctxAfterOk(stored: string, slice: string): boolean {
  if (!stored) return true;
  if (slice === stored || slice.startsWith(stored)) return true;
  if (slice.startsWith('\n') && (slice.slice(1) === stored || slice.slice(1).startsWith(stored))) return true;
  if (stored.startsWith('\n') && (slice === stored.slice(1) || slice.startsWith(stored.slice(1)))) return true;
  return false;
}

function hitContextOk(text: string, index: number, quote: string, ctxBefore: string, ctxAfter: string): boolean {
  const before = text.slice(Math.max(0, index - CONTEXT_CHARS), index);
  const after = text.slice(index + quote.length, index + quote.length + CONTEXT_CHARS);
  return ctxBeforeOk(ctxBefore, before) && ctxAfterOk(ctxAfter, after);
}

/** Offsets of the first character of each line (0-based). Built once per remapping. */
export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return starts;
}

/** 1-based line number of a character offset, via binary search on `lineStarts`. */
export function lineAtIndex(starts: number[], offset: number): number {
  if (offset <= 0) return 1;
  let lo = 0;
  let hi = starts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid]! <= offset) lo = mid + 1;
    else hi = mid - 1;
  }
  return Math.max(1, hi + 1);
}

function offsetOfLine(starts: number[], textLen: number, line: number): number {
  if (line <= 1) return 0;
  if (line > starts.length) return textLen;
  return starts[line - 1]!;
}

function endOfLine(starts: number[], textLen: number, line: number): number {
  if (line < starts.length) return starts[line]! - 1;
  return textLen;
}

function extractRangeIndexed(text: string, starts: number[], start: number, end: number): string {
  if (start < 1 || end < start || end > starts.length) {
    throw invalid(`line range ${start}-${end} is outside the text (${starts.length} lines)`);
  }
  return stripTrailingCR(text.slice(offsetOfLine(starts, text.length, start), endOfLine(starts, text.length, end)));
}

/** Character window around a hint line: ±FUZZY_LINE_WINDOW lines, capped at FUZZY_CHAR_CAP. */
function hintWindow(text: string, starts: number[], hintLine: number | null): { from: number; to: number } {
  const hint = Math.min(Math.max(hintLine ?? 1, 1), Math.max(starts.length, 1));
  const fromLine = Math.max(1, hint - FUZZY_LINE_WINDOW);
  const toLine = Math.min(starts.length, hint + FUZZY_LINE_WINDOW);
  let from = offsetOfLine(starts, text.length, fromLine);
  let to = endOfLine(starts, text.length, toLine);
  const hintOff = offsetOfLine(starts, text.length, hint);
  const charFrom = Math.max(0, hintOff - Math.floor(FUZZY_CHAR_CAP / 2));
  const charTo = Math.min(text.length, charFrom + FUZZY_CHAR_CAP);
  from = Math.max(from, charFrom);
  to = Math.min(to, charTo);
  return { from, to };
}

function asTarget(v: string): ReviewTargetType {
  if (!(TARGET_TYPES as readonly string[]).includes(v)) throw invalid(`target_type must be one of ${TARGET_TYPES.join(', ')}`);
  return v as ReviewTargetType;
}

function asField(target: ReviewTargetType, v: string): ReviewField {
  if (!(FIELDS[target] as readonly string[]).includes(v)) throw invalid(`field "${v}" is not valid for ${target}`);
  return v as ReviewField;
}

function requireTarget(db: DB, memberId: string, type: ReviewTargetType, id: string): { id: string } {
  const row = get<{ id: string }>(db, `SELECT id FROM ${TARGET_TABLE[type]} WHERE member_id = ? AND id = ?`, memberId, id);
  if (!row) throw notFound(type, id);
  return row;
}

export function actorHasEditAny(db: DB, actor: Actor): boolean {
  if (actor.kind === 'owner') return true;
  if (actor.kind !== 'agent' || !actor.role) return false;
  const r = get<{ edit_any: number; archived_at: string | null }>(
    db,
    'SELECT edit_any, archived_at FROM role WHERE member_id = ? AND (id = ? OR slug = ?) AND archived_at IS NULL',
    actor.memberId,
    actor.role,
    actor.role,
  );
  return !!r && r.edit_any === 1;
}

function actingRoleId(db: DB, actor: Actor): string | null {
  if (!actor.role) return null;
  return get<{ id: string }>(db, 'SELECT id FROM role WHERE member_id = ? AND (id = ? OR slug = ?)', actor.memberId, actor.role, actor.role)?.id ?? null;
}

function activeEditAnyRoles(db: DB, memberId: string): { id: string; slug: string }[] {
  return all<{ id: string; slug: string }>(db, 'SELECT id, slug FROM role WHERE member_id = ? AND archived_at IS NULL AND edit_any = 1 ORDER BY name', memberId);
}

/** Responsible role for a comment (single), plus whether a project owner may see/reply on project rules. */
export function responsibleRoleId(db: DB, c: Pick<ReviewCommentRow, 'member_id' | 'target_type' | 'target_id' | 'field'>): string | null {
  if (c.target_type === 'role') return c.target_id;
  if (c.target_type === 'project') {
    return get<{ owner_role_id: string | null }>(db, 'SELECT owner_role_id FROM project WHERE id = ?', c.target_id)?.owner_role_id ?? null;
  }
  if (c.target_type === 'document') {
    const d = get<{ scope_type: string; scope_id: string | null }>(db, 'SELECT scope_type, scope_id FROM document WHERE id = ?', c.target_id);
    return d ? documentOwnerRoleId(db, d) : null;
  }
  return null;
}

function projectIdOfRules(db: DB, rulesId: string): string | null {
  return get<{ project_id: string | null }>(db, 'SELECT project_id FROM rules WHERE id = ?', rulesId)?.project_id ?? null;
}

/** Roles that see this comment in start (responsible, edit_any on rules, or project owner on that project's rules). */
export function startViewerRoleIds(db: DB, c: Pick<ReviewCommentRow, 'member_id' | 'target_type' | 'target_id' | 'field'>): string[] {
  const ids = new Set<string>();
  if (c.target_type === 'rules') {
    for (const r of activeEditAnyRoles(db, c.member_id)) ids.add(r.id);
    const projectId = projectIdOfRules(db, c.target_id);
    const owner = projectId ? (get<{ owner_role_id: string | null }>(db, 'SELECT owner_role_id FROM project WHERE id = ?', projectId)?.owner_role_id ?? null) : null;
    if (owner) ids.add(owner);
    return [...ids];
  }
  const r = responsibleRoleId(db, c);
  if (r) ids.add(r);
  return [...ids];
}

function canMarkAnswered(db: DB, actor: Actor, c: ReviewCommentRow): boolean {
  if (actor.kind === 'owner') return true;
  if (actorHasEditAny(db, actor)) return true;
  if (c.target_type === 'rules') return false;
  const acting = actingRoleId(db, actor);
  return !!acting && acting === responsibleRoleId(db, c);
}

function canReply(_db: DB, actor: Actor, _c: ReviewCommentRow): boolean {
  // The owner, or any agent that already passed claimed_role / connection checks, may reply.
  return actor.kind === 'owner' || actor.kind === 'agent';
}

function roleSlug(db: DB, roleId: string | null): string | null {
  if (!roleId) return null;
  return get<{ slug: string }>(db, 'SELECT slug FROM role WHERE id = ?', roleId)?.slug ?? roleId;
}

function reviewStatusAudit(db: DB, actor: Actor, c: ReviewCommentRow, outcome: 'warning' | 'rejected'): void {
  auditRoleCheck(db, actor, outcome, {
    reason: 'review_status',
    claimed_role: actor.role ?? null,
    responsible_role: roleSlug(db, responsibleRoleId(db, c)),
  });
}

function statusForbidden(message: string, actor: Actor, db: DB, c: ReviewCommentRow): boolean {
  const mode = actor.kind === 'agent' ? getEnforcement(db, actor.memberId) : 'enforce';
  if (mode === 'enforce' || actor.kind === 'owner') {
    reviewStatusAudit(db, actor, c, 'rejected');
    throw new DomainError('forbidden', message);
  }
  reviewStatusAudit(db, actor, c, 'warning');
  addWarning({ code: 'review_status_forbidden', message } satisfies RoleWarning);
  return true;
}

function rejectAgentResolve(db: DB, actor: Actor, c: ReviewCommentRow): never {
  reviewStatusAudit(db, actor, c, 'rejected');
  throw new DomainError('forbidden', 'only the owner can resolve or reopen a review comment');
}

function requireComment(db: DB, memberId: string, id: string): ReviewCommentRow {
  const row = get<ReviewCommentRow>(db, 'SELECT * FROM review_comment WHERE member_id = ? AND id = ?', memberId, id);
  if (!row) throw notFound('review_comment', id);
  return row;
}

function listReplies(db: DB, commentId: string): ReviewReplyRow[] {
  return all<ReviewReplyRow>(db, 'SELECT * FROM review_reply WHERE comment_id = ? ORDER BY created_at, id', commentId);
}

function versionNumber(db: DB, versionId: number | null): number | null {
  if (!versionId) return null;
  return get<{ number: number }>(db, 'SELECT number FROM version WHERE id = ?', versionId)?.number ?? null;
}

export function reviewCommentView(db: DB, c: ReviewCommentRow, opts: { replies?: boolean; bodyPreview?: number } = {}) {
  const responsible = responsibleRoleId(db, c);
  const role = responsible ? (get<{ slug: string }>(db, 'SELECT slug FROM role WHERE id = ?', responsible)?.slug ?? null) : null;
  const origNum = versionNumber(db, c.version_id);
  const anchorNum = versionNumber(db, c.anchor_version_id);
  const body = opts.bodyPreview != null ? preview(c.body, opts.bodyPreview) : c.body;
  return {
    id: c.id,
    type: 'review_comment' as const,
    target_type: c.target_type,
    target_id: c.target_id,
    field: c.field,
    body,
    quote: c.quote,
    status: c.status,
    anchor_state: c.anchor_state,
    line_start: c.line_start,
    line_end: c.line_end,
    version: origNum,
    version_id: c.version_id,
    anchor_version: anchorNum,
    anchor_version_id: c.anchor_version_id,
    anchor_line_start: c.anchor_line_start,
    anchor_line_end: c.anchor_line_end,
    setup_notes_id: c.setup_notes_id,
    responsible_role: role,
    responsible_role_id: responsible,
    rev: c.rev,
    author: { kind: c.actor_kind, connection: c.connection_name, role: c.claimed_role, owner: c.actor_kind === 'owner' },
    created_at: c.created_at,
    updated_at: c.updated_at,
    ...(opts.replies
      ? {
          replies: listReplies(db, c.id).map((r) => ({
            id: r.id,
            body: opts.bodyPreview != null ? preview(r.body, opts.bodyPreview) : r.body,
            author: { kind: r.actor_kind, connection: r.connection_name, role: r.claimed_role, owner: r.actor_kind === 'owner' },
            created_at: r.created_at,
          })),
        }
      : {}),
  };
}

function indexComment(db: DB, c: ReviewCommentRow): void {
  const replies = listReplies(db, c.id)
    .map((r) => r.body)
    .join('\n');
  indexEntity(db, c.member_id, 'review_comment', c.id, preview(c.quote || c.body, 80) ?? (c.quote || c.body).slice(0, 80), `${c.body}\n${c.quote}\n${replies}`);
}

export function createReviewComment(
  db: DB,
  actor: Actor,
  input: {
    target_type: string;
    target_id: string;
    field: string;
    body: string;
    version?: number;
    line_start?: number | null;
    line_end?: number | null;
    idempotency_key?: string;
  },
) {
  if (actor.kind !== 'owner') throw new DomainError('forbidden', 'only the owner can create review comments');
  checkLen('body', input.body, LIMITS.comment);
  if (!input.body?.trim()) throw invalid('comment body must not be empty');
  const targetType = asTarget(input.target_type);
  const field = asField(targetType, input.field);
  return tx(db, () =>
    idempotent(db, actor.memberId, input.idempotency_key, 'create_review_comment', () => {
      const target = requireTarget(db, actor.memberId, targetType, input.target_id);
      const at = now();
      let versionId: number | null = null;
      let setupNotesId: number | null = null;
      let hash: string | null = null;
      let quote = '';
      let hashQ = quoteHash('');
      let ctx_before = '';
      let ctx_after = '';
      let lineStart = input.line_start ?? null;
      let lineEnd = input.line_end ?? null;
      let state: AnchorState = 'none';

      if (field === 'setup_notes') {
        const role = get<{ setup_notes: string }>(db, 'SELECT setup_notes FROM role WHERE id = ?', target.id);
        if (!role) throw notFound('role', target.id);
        const text = role.setup_notes ?? '';
        hash = textHash(text);
        setupNotesId = ensureSetupNotesHistory(db, actor, target.id, text);
        if (lineStart != null && lineEnd != null) {
          const raw = extractRange(text, lineStart, lineEnd);
          quote = raw.slice(0, QUOTE_MAX);
          hashQ = quoteHash(quote);
          const ctx = contextAround(text, lineStart, lineEnd, quote);
          ctx_before = ctx.ctx_before;
          ctx_after = ctx.ctx_after;
          state = 'exact';
        }
      } else {
        const current = get<{ current_version: number | null }>(db, `SELECT current_version FROM ${TARGET_TABLE[targetType]} WHERE id = ?`, target.id);
        const wanted = input.version
          ? get<{ id: number; number: number; body: string; entity_type: string; entity_id: string }>(
              db,
              'SELECT id, number, body, entity_type, entity_id FROM version WHERE entity_type = ? AND entity_id = ? AND number = ?',
              targetType,
              target.id,
              input.version,
            )
          : current?.current_version
            ? get<{ id: number; number: number; body: string; entity_type: string; entity_id: string }>(db, 'SELECT id, number, body, entity_type, entity_id FROM version WHERE id = ?', current.current_version)
            : undefined;
        if (!wanted) throw invalid(input.version ? `version ${input.version} was not found for this ${targetType}` : `this ${targetType} has no version to attach a comment to`);
        if (wanted.entity_type !== targetType || wanted.entity_id !== target.id) throw invalid('version does not belong to this target');
        versionId = wanted.id;
        if (lineStart != null && lineEnd != null) {
          const raw = extractRange(wanted.body, lineStart, lineEnd);
          quote = raw.slice(0, QUOTE_MAX);
          hashQ = quoteHash(quote);
          const ctx = contextAround(wanted.body, lineStart, lineEnd, quote);
          ctx_before = ctx.ctx_before;
          ctx_after = ctx.ctx_after;
          state = 'exact';
        }
      }

      const id = newId('rc');
      run(
        db,
        `INSERT INTO review_comment (
           id, member_id, target_type, target_id, field, body, version_id, line_start, line_end,
           quote, quote_hash, ctx_before, ctx_after, text_hash, setup_notes_id,
           anchor_version_id, anchor_line_start, anchor_line_end, anchor_state, status, rev,
           actor_kind, connection_id, connection_name, claimed_role, created_at, updated_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'open',1,?,?,?,?,?,?)`,
        id,
        actor.memberId,
        targetType,
        target.id,
        field,
        input.body,
        versionId,
        lineStart,
        lineEnd,
        quote,
        hashQ,
        ctx_before,
        ctx_after,
        hash,
        setupNotesId,
        versionId,
        lineStart,
        lineEnd,
        state,
        actor.kind,
        actor.connectionId ?? null,
        actor.connectionName ?? null,
        actor.role ?? null,
        at,
        at,
      );
      const row = requireComment(db, actor.memberId, id);
      indexComment(db, row);
      const responsible = responsibleRoleId(db, row);
      recordEvent(
        db,
        actor,
        'review_comment',
        id,
        'review.commented',
        `Review comment on ${targetType} ${field}`,
        withOwnerRole(db, responsible, {
          comment_id: id,
          target_type: targetType,
          target_id: target.id,
          field,
          status: 'open',
          body: preview(input.body, LIMITS.preview),
          quote: preview(quote, LIMITS.preview),
          responsible_role_id: responsible,
        }),
      );
      return reviewCommentView(db, row, { replies: true });
    }),
  );
}

export function replyReviewComment(
  db: DB,
  actor: Actor,
  input: { id: string; body: string; status?: ReviewStatus; rev?: number; expected_status?: ReviewStatus; idempotency_key?: string },
) {
  checkLen('body', input.body, LIMITS.comment);
  if (!input.body?.trim()) throw invalid('reply body must not be empty');
  if (input.status && !(REVIEW_STATUSES as readonly string[]).includes(input.status)) throw invalid(`status must be one of ${REVIEW_STATUSES.join(', ')}`);
  return tx(db, () =>
    idempotent(db, actor.memberId, input.idempotency_key, 'reply_review_comment', () => {
      const c = requireComment(db, actor.memberId, input.id);
      if (!canReply(db, actor, c)) throw new DomainError('forbidden', 'you cannot reply to this review comment');
      if (input.rev != null && input.rev !== c.rev) {
        throw new DomainError('conflict', `review comment ${c.id} has changed (rev ${c.rev})`, { current_rev: c.rev });
      }
      if (input.expected_status && input.expected_status !== c.status) {
        throw new DomainError('conflict', `review comment ${c.id} status is ${c.status}, not ${input.expected_status}`, { current_status: c.status, current_rev: c.rev });
      }

      let status = c.status;
      let statusChanged = false;
      const wanted = input.status;
      if (wanted && wanted !== c.status) {
        if (wanted === 'resolved' || wanted === 'open') {
          if (actor.kind !== 'owner') {
            // Agents may never resolve or reopen, in either enforcement mode.
            rejectAgentResolve(db, actor, c);
          }
          status = wanted;
          statusChanged = true;
        } else if (wanted === 'answered') {
          if (!canMarkAnswered(db, actor, c)) {
            statusForbidden('only the owner, the responsible role, or a role allowed to edit any item can mark a review comment answered', actor, db, c);
            // In warning mode the change still applies (statusForbidden only throws in enforce).
          }
          status = 'answered';
          statusChanged = true;
        }
      }

      // An owner's reply on an answered comment reopens it (unless they are resolving in the same call).
      if (actor.kind === 'owner' && c.status === 'answered' && status === 'answered' && wanted !== 'resolved') {
        status = 'open';
        statusChanged = true;
      }

      const replyId = newId('rr');
      const at = now();
      run(
        db,
        'INSERT INTO review_reply (id, member_id, comment_id, body, actor_kind, connection_id, connection_name, claimed_role, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
        replyId,
        actor.memberId,
        c.id,
        input.body,
        actor.kind,
        actor.connectionId ?? null,
        actor.connectionName ?? null,
        actor.role ?? null,
        at,
      );
      if (statusChanged) {
        run(db, 'UPDATE review_comment SET status = ?, rev = rev + 1, updated_at = ? WHERE id = ?', status, at, c.id);
      } else {
        run(db, 'UPDATE review_comment SET updated_at = ? WHERE id = ?', at, c.id);
      }
      const updated = requireComment(db, actor.memberId, c.id);
      indexComment(db, updated);
      const responsible = responsibleRoleId(db, updated);
      const action = statusChanged ? (status === 'answered' ? 'review.answered' : status === 'resolved' ? 'review.resolved' : 'review.reopened') : 'review.replied';
      recordEvent(
        db,
        actor,
        'review_comment',
        c.id,
        action,
        statusChanged ? `Review comment ${status}` : `Reply on review comment`,
        withOwnerRole(db, responsible, {
          comment_id: c.id,
          reply_id: replyId,
          target_type: c.target_type,
          target_id: c.target_id,
          field: c.field,
          status,
          body: preview(input.body, LIMITS.preview),
          responsible_role_id: responsible,
        }),
      );
      return { ...reviewCommentView(db, updated, { replies: true }), reply_id: replyId };
    }),
  );
}

export function setReviewCommentStatus(
  db: DB,
  actor: Actor,
  input: { id: string; status: ReviewStatus; rev?: number; expected_status?: ReviewStatus },
) {
  if (!(REVIEW_STATUSES as readonly string[]).includes(input.status)) throw invalid(`status must be one of ${REVIEW_STATUSES.join(', ')}`);
  return tx(db, () => {
    const c = requireComment(db, actor.memberId, input.id);
    if (input.rev != null && input.rev !== c.rev) {
      throw new DomainError('conflict', `review comment ${c.id} has changed (rev ${c.rev})`, { current_rev: c.rev });
    }
    if (input.expected_status && input.expected_status !== c.status) {
      throw new DomainError('conflict', `review comment ${c.id} status is ${c.status}, not ${input.expected_status}`, { current_status: c.status, current_rev: c.rev });
    }
    if (c.status === input.status) return { ...reviewCommentView(db, c, { replies: true }), unchanged: true };
    if (input.status === 'resolved' || input.status === 'open') {
      if (actor.kind !== 'owner') rejectAgentResolve(db, actor, c);
    } else if (input.status === 'answered') {
      if (!canMarkAnswered(db, actor, c)) {
        statusForbidden('only the owner, the responsible role, or a role allowed to edit any item can mark a review comment answered', actor, db, c);
      }
    }
    const at = now();
    run(db, 'UPDATE review_comment SET status = ?, rev = rev + 1, updated_at = ? WHERE id = ?', input.status, at, c.id);
    const updated = requireComment(db, actor.memberId, c.id);
    const responsible = responsibleRoleId(db, updated);
    const action = input.status === 'answered' ? 'review.answered' : input.status === 'resolved' ? 'review.resolved' : 'review.reopened';
    recordEvent(
      db,
      actor,
      'review_comment',
      c.id,
      action,
      `Review comment ${input.status}`,
      withOwnerRole(db, responsible, {
        comment_id: c.id,
        target_type: c.target_type,
        target_id: c.target_id,
        field: c.field,
        status: input.status,
        responsible_role_id: responsible,
      }),
    );
    return reviewCommentView(db, updated, { replies: true });
  });
}

export function getReviewComment(db: DB, memberId: string, id: string) {
  return reviewCommentView(db, requireComment(db, memberId, id), { replies: true });
}

export interface ListReviewsInput {
  status?: ReviewStatus[] | 'all';
  target_type?: string;
  target_id?: string;
  field?: string;
  version_id?: number;
  version?: number;
  include_resolved?: boolean;
  limit?: number;
  offset?: number;
}

export function listReviewComments(db: DB, memberId: string, input: ListReviewsInput = {}) {
  const limit = Math.min(Math.max(input.limit ?? LIMITS.listDefault, 1), LIMITS.listMax);
  const offset = input.offset ?? 0;
  const conds = ['member_id = ?'];
  const vals: unknown[] = [memberId];
  if (input.target_type) {
    const t = asTarget(input.target_type);
    conds.push('target_type = ?');
    vals.push(t);
  }
  if (input.target_id) {
    conds.push('target_id = ?');
    vals.push(input.target_id);
  }
  if (input.field) {
    conds.push('field = ?');
    vals.push(input.field);
  }
  let statuses: ReviewStatus[] | undefined;
  if (input.status === 'all') statuses = undefined;
  else if (Array.isArray(input.status) && input.status.length) statuses = input.status;
  else if (!input.include_resolved) statuses = ['open', 'answered'];
  if (statuses) {
    conds.push(`status IN (${statuses.map(() => '?').join(',')})`);
    vals.push(...statuses);
  }
  if (input.version_id) {
    conds.push('(version_id = ? OR anchor_version_id = ?)');
    vals.push(input.version_id, input.version_id);
  } else if (input.version && input.target_type && input.target_id) {
    const v = get<{ id: number }>(db, 'SELECT id FROM version WHERE entity_type = ? AND entity_id = ? AND number = ?', input.target_type, input.target_id, input.version);
    if (v) {
      conds.push('(version_id = ? OR anchor_version_id = ?)');
      vals.push(v.id, v.id);
    }
  }
  const where = conds.join(' AND ');
  const total = get<{ n: number }>(db, `SELECT count(*) AS n FROM review_comment WHERE ${where}`, ...vals)!.n;
  // Answered first (waiting for the owner), then open by age, then resolved.
  const rows = all<ReviewCommentRow>(
    db,
    `SELECT * FROM review_comment WHERE ${where}
     ORDER BY CASE status WHEN 'answered' THEN 0 WHEN 'open' THEN 1 ELSE 2 END, created_at ASC, id
     LIMIT ? OFFSET ?`,
    ...vals,
    limit,
    offset,
  );
  return { comments: rows.map((c) => reviewCommentView(db, c, { replies: true })), total, has_more: offset + rows.length < total };
}

export function reviewCounts(db: DB, memberId: string) {
  const rows = all<{ status: ReviewStatus; n: number }>(db, 'SELECT status, count(*) AS n FROM review_comment WHERE member_id = ? GROUP BY status', memberId);
  const by: Record<string, number> = { open: 0, answered: 0, resolved: 0 };
  for (const r of rows) by[r.status] = r.n;
  return { open: by.open, answered: by.answered, resolved: by.resolved };
}

export function openReviewComments(db: DB, memberId: string, targetType: ReviewTargetType, targetId: string, opts: { field?: string; versionId?: number; limit?: number } = {}) {
  const limit = opts.limit ?? 10;
  const input: ListReviewsInput = { target_type: targetType, target_id: targetId, field: opts.field, version_id: opts.versionId, status: ['open', 'answered'], limit };
  const listed = listReviewComments(db, memberId, input);
  const more = Math.max(0, listed.total - listed.comments.length);
  return { open_review_comments: listed.comments, more_open_review_comments: more, open_review_comments_total: listed.total };
}

/** Oldest open comments this role is responsible for (or may see on project rules). */
export function startReviewComments(db: DB, memberId: string, roleId: string | undefined, previewLen: number, mode: 'full' | 'ids') {
  if (!roleId) return {};
  const open = all<ReviewCommentRow>(
    db,
    "SELECT * FROM review_comment WHERE member_id = ? AND status = 'open' ORDER BY created_at ASC, id",
    memberId,
  );
  const mine = open.filter((c) => startViewerRoleIds(db, c).includes(roleId));
  const total = mine.length;
  const page = mine.slice(0, 10);
  if (mode === 'ids') {
    return {
      review_comments: page.map((c) => ({ id: c.id, status: c.status, target_type: c.target_type, target_id: c.target_id, field: c.field })),
      more_review_comments: Math.max(0, total - page.length),
      review_comments_open_total: total,
    };
  }
  return {
    review_comments: page.map((c) => reviewCommentView(db, c, { replies: false, bodyPreview: previewLen })),
    more_review_comments: Math.max(0, total - page.length),
    review_comments_open_total: total,
  };
}

export function searchReviewHits(
  db: DB,
  memberId: string,
  id: string,
  input: { status?: string[]; role?: string },
  roleId?: string,
): { type: string; id: string; title: string; status: string; role: string | null; updated_at: string; snippet?: string } | null {
  const c = get<ReviewCommentRow>(db, 'SELECT * FROM review_comment WHERE member_id = ? AND id = ?', memberId, id);
  if (!c) return null;
  if (input.status?.length && !input.status.includes(c.status)) return null;
  const responsible = responsibleRoleId(db, c);
  if (roleId && responsible !== roleId && !startViewerRoleIds(db, c).includes(roleId)) return null;
  const role = responsible ? (get<{ slug: string }>(db, 'SELECT slug FROM role WHERE id = ?', responsible)?.slug ?? null) : null;
  return { type: 'review_comment', id: c.id, title: preview(c.quote || c.body, 80) ?? (c.quote || c.body).slice(0, 80), status: c.status, role, updated_at: c.updated_at };
}

export function listReviewSearch(db: DB, memberId: string, input: { status?: string[] }, roleId?: string) {
  const rows = all<ReviewCommentRow>(db, 'SELECT * FROM review_comment WHERE member_id = ? ORDER BY updated_at DESC, id LIMIT 2000', memberId);
  const out = [];
  for (const c of rows) {
    const h = searchReviewHits(db, memberId, c.id, input, roleId);
    if (h) out.push(h);
  }
  return out;
}

// ---------- setup_notes history ----------

export function ensureSetupNotesHistory(db: DB, actor: Actor, roleId: string, body: string): number {
  const last = get<{ id: number; body: string }>(db, 'SELECT id, body FROM setup_notes_history WHERE role_id = ? ORDER BY id DESC LIMIT 1', roleId);
  if (last && last.body === body) return last.id;
  const res = run(
    db,
    'INSERT INTO setup_notes_history (member_id, role_id, body, actor_kind, connection_id, connection_name, claimed_role, created_at) VALUES (?,?,?,?,?,?,?,?)',
    actor.memberId,
    roleId,
    body,
    actor.kind,
    actor.connectionId ?? null,
    actor.connectionName ?? null,
    actor.role ?? null,
    now(),
  );
  return Number(res.lastInsertRowid);
}

/** Called from saveRole in the same transaction when setup_notes change (or are first set). */
export function recordSetupNotesChange(db: DB, actor: Actor, roleId: string, previous: string, next: string): number {
  const id = ensureSetupNotesHistory(db, actor, roleId, next);
  reanchorField(db, actor.memberId, 'role', roleId, 'setup_notes', { newSetupNotesId: id, oldText: previous, newText: next });
  return id;
}

export function listSetupNotesHistory(db: DB, memberId: string, roleId: string, limit = 50) {
  requireTarget(db, memberId, 'role', roleId);
  return all<{ id: number; body: string; actor_kind: string; connection_name: string | null; claimed_role: string | null; created_at: string }>(
    db,
    'SELECT id, body, actor_kind, connection_name, claimed_role, created_at FROM setup_notes_history WHERE role_id = ? ORDER BY id DESC LIMIT ?',
    roleId,
    limit,
  );
}

// ---------- re-anchoring ----------

export interface ReanchorOpts {
  newVersionId?: number | null;
  newSetupNotesId?: number | null;
  oldText: string;
  newText: string;
  budgetMs?: number;
  now?: () => number;
}

interface LineMap {
  map: Map<number, number>;
  limited: boolean;
}

export function computeLineMap(oldText: string, newText: string, opts: { timeoutMs: number; maxEditLength: number }): LineMap {
  const parts = diffLines(oldText, newText, { timeout: opts.timeoutMs, maxEditLength: opts.maxEditLength }) as ReturnType<typeof diffLines> | undefined;
  if (!parts) return { map: new Map(), limited: true };
  const map = new Map<number, number>();
  let oldLine = 1;
  let newLine = 1;
  for (const p of parts) {
    const count = p.count ?? splitLines(p.value.endsWith('\n') ? p.value.slice(0, -1) : p.value).length;
    if (p.added) {
      newLine += count;
    } else if (p.removed) {
      oldLine += count;
    } else {
      for (let i = 0; i < count; i++) {
        map.set(oldLine + i, newLine + i);
      }
      oldLine += count;
      newLine += count;
    }
  }
  return { map, limited: false };
}

type ExactHit = { start: number; end: number };
type ExactResult = ExactHit | 'timeout' | null;

function collectExactHits(
  text: string,
  quote: string,
  starts: number[],
  from: number,
  to: number,
  cap: number,
  deadline: number,
  clock: () => number,
): { hits: { start: number; end: number; index: number }[]; timeout: boolean } {
  const hits: { start: number; end: number; index: number }[] = [];
  let pos = from;
  while (pos <= to) {
    if (clock() >= deadline) return { hits, timeout: true };
    const i = text.indexOf(quote, pos);
    if (i < 0 || i >= to) break;
    hits.push({ start: lineAtIndex(starts, i), end: lineAtIndex(starts, i + Math.max(quote.length - 1, 0)), index: i });
    if (hits.length >= cap) break;
    pos = i + 1;
  }
  return { hits, timeout: false };
}

function findExact(
  text: string,
  quote: string,
  hintLine: number | null,
  ctxBefore: string,
  ctxAfter: string,
  starts: number[],
  deadline: number,
  clock: () => number,
): ExactResult {
  if (!quote) return null;
  if (clock() >= deadline) return 'timeout';
  const win = hintWindow(text, starts, hintLine);
  const { hits, timeout } = collectExactHits(text, quote, starts, win.from, win.to, EXACT_HIT_CAP, deadline, clock);
  if (timeout) return 'timeout';
  if (!hits.length) {
    // A unique occurrence outside the window still counts as exact when the stored
    // context matches (e.g. a moved unique quote when the diff was limited). Two or
    // more hits are not ranked across the whole document.
    if (clock() >= deadline) return 'timeout';
    const i = text.indexOf(quote);
    if (i < 0) return null;
    if (clock() >= deadline) return 'timeout';
    if (text.indexOf(quote, i + 1) >= 0) return null;
    if ((ctxBefore || ctxAfter) && !uniqueHitContextOk(text, i, quote, ctxBefore, ctxAfter)) return null;
    return { start: lineAtIndex(starts, i), end: lineAtIndex(starts, i + Math.max(quote.length - 1, 0)) };
  }
  if (hits.length === 1) return { start: hits[0]!.start, end: hits[0]!.end };
  const ranked = hits
    .map((h) => {
      const ctxOk = hitContextOk(text, h.index, quote, ctxBefore, ctxAfter);
      const dist = hintLine != null ? Math.abs(h.start - hintLine) : 0;
      return { h, ctxOk, dist };
    })
    .sort((a, b) => Number(b.ctxOk) - Number(a.ctxOk) || a.dist - b.dist);
  const best = ranked[0]!;
  // Prefer a context match, then the hit nearest the hint. If no context matches,
  // still accept a hit that sits on the hint line: the quote is still there, even
  // when the rest of the line (and thus ctx_after) changed.
  if (best.ctxOk || (hintLine != null && best.h.start === hintLine)) {
    return { start: best.h.start, end: best.h.end };
  }
  if ((ctxBefore || ctxAfter) && !best.ctxOk) return null;
  return { start: best.h.start, end: best.h.end };
}

function dice(a: string, b: string): number {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  if (a === b) return 1;
  const grams = (s: string) => {
    const m = new Map<string, number>();
    const t = ` ${s} `;
    for (let i = 0; i < t.length - 1; i++) {
      const g = t.slice(i, i + 2);
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  };
  const A = grams(a);
  const B = grams(b);
  let inter = 0;
  for (const [g, n] of A) inter += Math.min(n, B.get(g) ?? 0);
  const sizeA = [...A.values()].reduce((s, n) => s + n, 0);
  const sizeB = [...B.values()].reduce((s, n) => s + n, 0);
  return (2 * inter) / Math.max(1, sizeA + sizeB);
}

function fuzzyFind(
  text: string,
  quote: string,
  hintLine: number | null,
  starts: number[],
  deadline: number,
  clock: () => number,
): { start: number; end: number } | null {
  if (!quote || clock() >= deadline) return null;
  const win = hintWindow(text, starts, hintLine);
  const window = text.slice(win.from, win.to);
  return fuzzyInWindow(window, quote, win.from, starts, hintLine, deadline, clock);
}

function fuzzyInWindow(
  window: string,
  quote: string,
  windowOffset: number,
  starts: number[],
  hintLine: number | null,
  deadline: number,
  clock: () => number,
): { start: number; end: number } | null {
  const want = normalizeQuote(quote);
  const minLen = Math.max(1, quote.length - FUZZY_LENGTH_SLACK);
  const maxLen = quote.length + FUZZY_LENGTH_SLACK;
  let best: { score: number; start: number; end: number; dist: number } | null = null;
  // Walk line-aligned segments of length close to the quote.
  const wLines = splitLines(window);
  let lineOff = 0;
  for (let i = 0; i < wLines.length; i++) {
    if (clock() >= deadline) return best && best.score >= FUZZY_SIMILARITY ? best : null;
    let acc = '';
    for (let j = i; j < wLines.length; j++) {
      if (clock() >= deadline) return best && best.score >= FUZZY_SIMILARITY ? best : null;
      acc = j === i ? wLines[j]! : `${acc}\n${wLines[j]}`;
      if (acc.length < minLen && j < wLines.length - 1) continue;
      if (acc.length > maxLen) break;
      const score = dice(want, normalizeQuote(acc));
      const abs = windowOffset + lineOff;
      const start = lineAtIndex(starts, abs);
      const end = lineAtIndex(starts, abs + Math.max(acc.length - 1, 0));
      const dist = hintLine != null ? Math.abs(start - hintLine) : 0;
      if (!best || score > best.score || (score === best.score && dist < best.dist)) {
        best = { score, start, end, dist };
      }
    }
    lineOff += wLines[i]!.length + 1;
  }
  return best && best.score >= FUZZY_SIMILARITY ? { start: best.start, end: best.end } : null;
}

function mark(db: DB, c: ReviewCommentRow, state: AnchorState, versionId: number | null | undefined, setupId: number | null | undefined, start: number | null, end: number | null): void {
  run(
    db,
    `UPDATE review_comment SET anchor_state = ?, anchor_version_id = ?, setup_notes_id = COALESCE(?, setup_notes_id),
       anchor_line_start = ?, anchor_line_end = ?, updated_at = ? WHERE id = ?`,
    state,
    versionId === undefined ? c.anchor_version_id : versionId,
    setupId ?? null,
    start,
    end,
    now(),
    c.id,
  );
}

export function reanchorField(db: DB, memberId: string, targetType: ReviewTargetType, targetId: string, field: ReviewField, opts: ReanchorOpts): void {
  const clock = opts.now ?? (() => performance.now());
  const t0 = clock();
  const budget = opts.budgetMs ?? REANCHOR_BUDGET_MS;
  const comments = all<ReviewCommentRow>(
    db,
    "SELECT * FROM review_comment WHERE member_id = ? AND target_type = ? AND target_id = ? AND field = ? AND status IN ('open','answered')",
    memberId,
    targetType,
    targetId,
    field,
  );
  const remaining = () => budget - (clock() - t0);
  const deadline = () => t0 + budget;
  const starts = lineStarts(opts.newText);
  const needLines = comments.filter((c) => c.line_start != null && c.line_end != null && c.quote);
  let lineMapping: LineMap | null = null;
  if (needLines.length) {
    const timeout = Math.max(0, Math.min(DIFF_BUDGET_MS, remaining()));
    if (timeout <= 0) {
      lineMapping = { map: new Map(), limited: true };
    } else {
      lineMapping = computeLineMap(opts.oldText, opts.newText, { timeoutMs: timeout, maxEditLength: DIFF_MAX_EDIT_LENGTH });
    }
  }

  let exhausted = remaining() <= 0;
  for (const c of comments) {
    if (exhausted || clock() >= deadline()) {
      exhausted = true;
      mark(db, c, 'outdated', opts.newVersionId ?? c.anchor_version_id, opts.newSetupNotesId, c.anchor_line_start, c.anchor_line_end);
      continue;
    }
    if (c.line_start == null || c.line_end == null || !c.quote) {
      // Whole-item comments stay at none; still point at the new version / history row.
      mark(db, c, 'none', opts.newVersionId ?? null, opts.newSetupNotesId, null, null);
      continue;
    }

    const rawHint = c.anchor_line_start ?? c.line_start;
    const mapped = !lineMapping?.limited ? lineMapping?.map.get(rawHint) : undefined;
    const hint = mapped ?? rawHint;
    const exact = findExact(opts.newText, c.quote, hint, c.ctx_before, c.ctx_after, starts, deadline(), clock);
    if (exact && exact !== 'timeout') {
      mark(db, c, 'exact', opts.newVersionId ?? c.anchor_version_id, opts.newSetupNotesId, exact.start, exact.end);
      continue;
    }
    if (exact === 'timeout' || clock() >= deadline()) {
      exhausted = true;
      mark(db, c, 'outdated', opts.newVersionId ?? c.anchor_version_id, opts.newSetupNotesId, c.anchor_line_start, c.anchor_line_end);
      continue;
    }
    if (lineMapping?.limited) {
      mark(db, c, 'outdated', opts.newVersionId ?? c.anchor_version_id, opts.newSetupNotesId, c.anchor_line_start, c.anchor_line_end);
      continue;
    }
    if (lineMapping) {
      const start = lineMapping.map.get(c.anchor_line_start ?? c.line_start);
      const end = lineMapping.map.get(c.anchor_line_end ?? c.line_end);
      if (start != null && end != null && end >= start) {
        try {
          const at = extractRangeIndexed(opts.newText, starts, start, end);
          if (at === c.quote || at.includes(c.quote) || normalizeQuote(at).includes(normalizeQuote(c.quote))) {
            mark(db, c, 'moved', opts.newVersionId ?? c.anchor_version_id, opts.newSetupNotesId, start, end);
            continue;
          }
        } catch {
          /* range no longer valid */
        }
      }
    }
    if (clock() >= deadline()) {
      exhausted = true;
      mark(db, c, 'outdated', opts.newVersionId ?? c.anchor_version_id, opts.newSetupNotesId, c.anchor_line_start, c.anchor_line_end);
      continue;
    }
    const found = fuzzyFind(opts.newText, c.quote, hint, starts, deadline(), clock);
    if (clock() >= deadline() && !found) {
      exhausted = true;
      mark(db, c, 'outdated', opts.newVersionId ?? c.anchor_version_id, opts.newSetupNotesId, c.anchor_line_start, c.anchor_line_end);
      continue;
    }
    if (found) {
      mark(db, c, 'moved', opts.newVersionId ?? c.anchor_version_id, opts.newSetupNotesId, found.start, found.end);
    } else {
      mark(db, c, 'outdated', opts.newVersionId ?? c.anchor_version_id, opts.newSetupNotesId, c.anchor_line_start, c.anchor_line_end);
    }
  }
}

function onNewVersionFixed(db: DB, actor: Actor, row: VersionRow, previousBody: string): void {
  const memberId = actor.memberId;
  const field = VERSION_FIELD[row.entity_type];
  reanchorField(db, memberId, row.entity_type, row.entity_id, field, {
    newVersionId: row.id,
    oldText: previousBody,
    newText: row.body,
  });
}

export function attachReviewHooks(): void {
  onVersionAdded(onNewVersionFixed);
}

/** Deletes comments and setup-notes history for a purged entity. Call while purge_guard is set, before versions. */
export function purgeReviewData(db: DB, type: string, id: string): void {
  if (type === 'role' || type === 'project' || type === 'document' || type === 'rules') {
    const comments = all<{ id: string }>(db, 'SELECT id FROM review_comment WHERE target_type = ? AND target_id = ?', type, id);
    for (const c of comments) {
      run(db, 'DELETE FROM review_reply WHERE comment_id = ?', c.id);
      unindexEntity(db, 'review_comment', c.id);
    }
    run(db, 'DELETE FROM review_comment WHERE target_type = ? AND target_id = ?', type, id);
  }
  if (type === 'role') {
    run(db, 'DELETE FROM setup_notes_history WHERE role_id = ?', id);
  }
}

