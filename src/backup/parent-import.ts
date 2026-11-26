import { get, run, type DB } from '../db/db.ts';
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
  /** If set, a parent chain longer than this many levels is `invalid`. */
  maxDepth?: number;
}

/**
 * Tables whose parent column cannot be inserted in `created_at` order because a
 * child may have been created before its parent. Import inserts these rows with
 * the parent cleared, then applies the links after every row of the table is in
 * place. `#55` can add `role` here with `maxDepth: 16`.
 */
export const IMPORT_PARENT_SPECS: ParentLinkSpec[] = [{ table: 'task', label: 'task' }];

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

/**
 * Checks a parent map for missing ids, self-parents, cycles, and an optional depth cap.
 * `knownIds` are the ids in the import (or already accepted in the same workspace).
 */
export function validateParentGraph(
  links: { id: string; parentId: string }[],
  knownIds: Set<string>,
  spec: Pick<ParentLinkSpec, 'label' | 'maxDepth' | 'table'>,
): void {
  const label = spec.label ?? spec.table;
  const parentOf = new Map(links.map((l) => [l.id, l.parentId]));
  for (const { id, parentId } of links) {
    if (id === parentId) throw invalid(`a ${label} cannot be its own parent`);
    if (!knownIds.has(parentId)) throw invalid(`import refers to a ${label} parent that is not in the import: ${parentId}`);
  }
  for (const { id } of links) {
    const seen = new Set<string>();
    let cur: string | undefined = id;
    let depth = 0;
    while (cur && parentOf.has(cur)) {
      if (seen.has(cur)) throw invalid(`import would create a cycle in the ${label} hierarchy`);
      seen.add(cur);
      cur = parentOf.get(cur);
      depth++;
      if (spec.maxDepth !== undefined && depth > spec.maxDepth) {
        throw invalid(`a ${label} parent chain cannot be deeper than ${spec.maxDepth} levels`);
      }
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

  validateParentGraph(links, knownIds, spec);

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
