import { all, get, run, type DB } from '../db/db.ts';
import { invalid } from '../domain/core.ts';

/** A self-referential parent column applied on import in a second pass. */
export interface ParentLinkSpec {
  table: string;
  /** Defaults to `id`. */
  idColumn?: string;
  /** Defaults to `parent_id`. */
  parentColumn?: string;
  /** Defaults to `member_id`. */
  memberColumn?: string;
  /** Word used in error messages. Defaults to `table`. */
  label?: string;
  /**
   * If set, an imported parent link is `invalid` when the ancestor depth of the
   * new parent (inclusive) plus the height of the child's subtree would exceed
   * this many levels. Existing same-workspace parents are included in the walk.
   */
  maxDepth?: number;
}

/**
 * Tables whose parent column cannot be inserted in `created_at` order because a
 * child may have been created before its parent. Import inserts these rows with
 * the parent cleared, then applies the links after every row of the table is in
 * place.
 */
export const IMPORT_PARENT_SPECS: ParentLinkSpec[] = [
  { table: 'task', label: 'task' },
  { table: 'role', label: 'role', maxDepth: 16 },
];

export function parentSpecFor(table: string): ParentLinkSpec | undefined {
  return IMPORT_PARENT_SPECS.find((s) => s.table === table);
}

function ident(name: string): string {
  if (!/^[a-z][a-z0-9_]*$/i.test(name)) throw new Error(`invalid SQL identifier: ${name}`);
  return name;
}

function cols(spec: ParentLinkSpec): { table: string; id: string; parent: string; member: string; label: string } {
  return {
    table: ident(spec.table),
    id: ident(spec.idColumn ?? 'id'),
    parent: ident(spec.parentColumn ?? 'parent_id'),
    member: ident(spec.memberColumn ?? 'member_id'),
    label: spec.label ?? spec.table,
  };
}

/** Drops the parent column so the first-pass insert does not trip the foreign key. */
export function omitParentColumn(vals: Record<string, unknown>, spec: ParentLinkSpec): Record<string, unknown> {
  const parent = spec.parentColumn ?? 'parent_id';
  const { [parent]: _ignored, ...rest } = vals;
  return rest;
}

export function intendedParent(row: Record<string, unknown>, spec: ParentLinkSpec): string | null {
  const parent = spec.parentColumn ?? 'parent_id';
  const raw = row[parent];
  if (raw == null || raw === '') return null;
  if (typeof raw !== 'string') throw invalid(`import ${spec.table}.${parent} must be a string id`);
  return raw;
}

function resultingParentMap(
  links: { id: string; parentId: string }[],
  existing?: { id: string; parentId: string | null }[],
): Map<string, string> {
  const parentOf = new Map<string, string>();
  for (const e of existing ?? []) {
    if (e.parentId) parentOf.set(e.id, e.parentId);
  }
  for (const l of links) parentOf.set(l.id, l.parentId);
  return parentOf;
}

function ancestorIds(parentOf: Map<string, string>, startId: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  let cur: string | undefined = startId;
  while (cur) {
    if (seen.has(cur)) return ids;
    seen.add(cur);
    ids.push(cur);
    cur = parentOf.get(cur);
  }
  return ids;
}

/** Longest downward path in edges from `rootId` (0 for a leaf). */
function subtreeHeight(parentOf: Map<string, string>, rootId: string): number {
  const byParent = new Map<string, string[]>();
  for (const [id, parentId] of parentOf) {
    const list = byParent.get(parentId) ?? [];
    list.push(id);
    byParent.set(parentId, list);
  }
  let max = 0;
  const walk = (id: string, depth: number, seen: Set<string>) => {
    if (seen.has(id)) return;
    seen.add(id);
    if (depth > max) max = depth;
    for (const child of byParent.get(id) ?? []) walk(child, depth + 1, seen);
  };
  walk(rootId, 0, new Set());
  return max;
}

/**
 * Checks a parent map for missing ids, self-parents, cycles, and an optional depth cap.
 * `knownIds` are the ids in the import (or already accepted in the same workspace).
 * `existing` are parent edges already in the workspace; imported `links` override them.
 * When `maxDepth` is set, a link is rejected if the ancestor depth of the new parent
 * (inclusive) plus the height of the child's subtree would exceed it.
 */
export function validateParentGraph(
  links: { id: string; parentId: string }[],
  knownIds: Set<string>,
  spec: Pick<ParentLinkSpec, 'label' | 'maxDepth' | 'table'>,
  existing?: { id: string; parentId: string | null }[],
): void {
  const label = spec.label ?? spec.table;
  for (const { id, parentId } of links) {
    if (id === parentId) throw invalid(`a ${label} cannot be its own parent`);
    if (!knownIds.has(parentId)) throw invalid(`import refers to a ${label} parent that is not in the import: ${parentId}`);
  }
  const parentOf = resultingParentMap(links, existing);
  for (const id of parentOf.keys()) {
    const seen = new Set<string>();
    let cur: string | undefined = id;
    while (cur && parentOf.has(cur)) {
      if (seen.has(cur)) throw invalid(`import would create a cycle in the ${label} hierarchy`);
      seen.add(cur);
      cur = parentOf.get(cur);
    }
  }
  if (spec.maxDepth === undefined) return;
  for (const { id, parentId } of links) {
    const depth = ancestorIds(parentOf, parentId).length;
    const height = subtreeHeight(parentOf, id);
    if (depth + height > spec.maxDepth) {
      throw invalid(`a ${label} parent chain cannot be deeper than ${spec.maxDepth} levels`);
    }
  }
}

/**
 * After first-pass inserts (parent column null), set parents from the original rows.
 * Every parent must exist in the import or already belong to this workspace, and
 * the resulting graph must have no cycle (and stay within `maxDepth` when set).
 * Call inside the same import transaction so a failure rolls everything back.
 */
export function applyImportedParentLinks(
  db: DB,
  memberId: string,
  rows: Record<string, unknown>[],
  spec: ParentLinkSpec,
): void {
  const { table, id: idCol, parent: parentCol, member: memberCol, label } = cols(spec);
  const importedIds = new Set<string>();
  for (const row of rows) {
    const id = row[idCol];
    if (typeof id === 'string') importedIds.add(id);
  }

  const links: { id: string; parentId: string }[] = [];
  for (const row of rows) {
    const id = row[idCol];
    if (typeof id !== 'string') continue;
    const parentId = intendedParent(row, spec);
    if (!parentId) continue;
    links.push({ id, parentId });
  }

  // Parents already in this workspace (not in the zip) are allowed; others are not.
  const knownIds = new Set(importedIds);
  for (const { parentId } of links) {
    if (knownIds.has(parentId)) continue;
    const existing = get<{ [k: string]: string }>(
      db,
      `SELECT ${idCol} AS id, ${memberCol} AS member_id FROM ${table} WHERE ${idCol} = ?`,
      parentId,
    );
    if (!existing) continue;
    if (existing.member_id !== memberId) {
      throw invalid(`import refers to a ${label} parent from another workspace: ${parentId}`);
    }
    knownIds.add(parentId);
  }

  const existingParents = all<{ id: string; parent_id: string | null }>(
    db,
    `SELECT ${idCol} AS id, ${parentCol} AS parent_id FROM ${table} WHERE ${memberCol} = ?`,
    memberId,
  ).map((r) => ({ id: r.id, parentId: r.parent_id }));

  validateParentGraph(links, knownIds, spec, existingParents);

  for (const { id, parentId } of links) {
    const parent = get<{ member_id: string }>(
      db,
      `SELECT ${memberCol} AS member_id FROM ${table} WHERE ${idCol} = ?`,
      parentId,
    );
    if (!parent) throw invalid(`import refers to a ${label} parent that is not in the import: ${parentId}`);
    if (parent.member_id !== memberId) throw invalid(`import refers to a ${label} parent from another workspace: ${parentId}`);
    run(db, `UPDATE ${table} SET ${parentCol} = ? WHERE ${idCol} = ?`, parentId, id);
  }
}
