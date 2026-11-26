import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { applyImportedParentLinks, IMPORT_PARENT_SPECS, parentSpecFor, validateParentGraph } from '../src/backup/parent-import.ts';
import { get, openDatabase, run, runAppMigrations } from '../src/db/db.ts';
import { DomainError } from '../src/domain/core.ts';
import { ensureOwnerMember } from '../src/domain/entities.ts';

const spec = { table: 'task', label: 'task' };

function throwsInvalid(fn: () => void, pattern: RegExp): void {
  assert.throws(fn, (e: unknown) => {
    assert.ok(e instanceof DomainError);
    assert.equal(e.code, 'invalid');
    assert.match(e.message, pattern);
    return true;
  });
}

describe('import parent links', () => {
  it('rejects a cycle, a missing parent, a self-parent and a chain past maxDepth', () => {
    const ids = new Set(['a', 'b', 'c']);
    throwsInvalid(() => validateParentGraph([{ id: 'a', parentId: 'b' }, { id: 'b', parentId: 'a' }], ids, spec), /cycle/i);
    throwsInvalid(() => validateParentGraph([{ id: 'a', parentId: 'missing' }], ids, spec), /not in the import: missing/);
    throwsInvalid(() => validateParentGraph([{ id: 'a', parentId: 'a' }], ids, spec), /cannot be its own parent/);
    throwsInvalid(
      () =>
        validateParentGraph(
          [
            { id: 'c', parentId: 'b' },
            { id: 'b', parentId: 'a' },
          ],
          ids,
          { ...spec, maxDepth: 1 },
        ),
      /deeper than 1/,
    );
    validateParentGraph(
      [
        { id: 'c', parentId: 'b' },
        { id: 'b', parentId: 'a' },
      ],
      ids,
      { ...spec, maxDepth: 2 },
    );
  });

  it('applies parents on a generic table after a first-pass insert, including an existing same-workspace parent', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsmcp-parent-import-'));
    const db = openDatabase(path.join(dir, 'workspace.sqlite'));
    runAppMigrations(db);
    const memberId = ensureOwnerMember(db).id;
    const at = '2026-01-01T00:00:00.000Z';
    run(
      db,
      `INSERT INTO task (id, member_id, title, status, priority, created_by_kind, created_at, updated_at)
       VALUES ('tsk_parent', ?, 'Parent', 'open', 'normal', 'owner', ?, ?)`,
      memberId,
      at,
      at,
    );
    run(
      db,
      `INSERT INTO task (id, member_id, title, status, priority, created_by_kind, created_at, updated_at)
       VALUES ('tsk_child', ?, 'Child', 'open', 'normal', 'owner', ?, ?)`,
      memberId,
      at,
      at,
    );
    applyImportedParentLinks(
      db,
      memberId,
      [
        { id: 'tsk_child', parent_id: 'tsk_parent' },
        { id: 'tsk_parent', parent_id: null },
      ],
      spec,
    );
    assert.equal(get<{ parent_id: string | null }>(db, "SELECT parent_id FROM task WHERE id = 'tsk_child'")!.parent_id, 'tsk_parent');
    assert.equal(get<{ parent_id: string | null }>(db, "SELECT parent_id FROM task WHERE id = 'tsk_parent'")!.parent_id, null);

    run(db, "INSERT INTO member (id, user_id, name, is_owner, created_at) VALUES ('mem_other', NULL, 'Other', 0, ?)", at);
    run(
      db,
      `INSERT INTO task (id, member_id, title, status, priority, created_by_kind, created_at, updated_at)
       VALUES ('tsk_other', 'mem_other', 'Foreign', 'open', 'normal', 'owner', ?, ?)`,
      at,
      at,
    );
    throwsInvalid(
      () => applyImportedParentLinks(db, memberId, [{ id: 'tsk_child', parent_id: 'tsk_other' }], spec),
      /another workspace/,
    );
    db.close();
  });
});


const roleSpec = { table: 'role', label: 'role', maxDepth: 16 };

function insertRole(db: ReturnType<typeof openDatabase>, memberId: string, id: string, slug: string, at: string): void {
  run(
    db,
    `INSERT INTO role (id, member_id, slug, name, area, setup_notes, rev, edit_any, created_at, updated_at)
     VALUES (?, ?, ?, ?, '', '', 1, 0, ?, ?)`,
    id,
    memberId,
    slug,
    slug,
    at,
    at,
  );
}

function chainIds(prefix: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(2, '0')}`);
}

function chainLinks(ids: string[]): { id: string; parentId: string }[] {
  const links: { id: string; parentId: string }[] = [];
  for (let i = 1; i < ids.length; i++) links.push({ id: ids[i]!, parentId: ids[i - 1]! });
  return links;
}

describe('import role parent links', () => {
  it('registers role on IMPORT_PARENT_SPECS with maxDepth 16', () => {
    assert.deepEqual(parentSpecFor('role'), { table: 'role', label: 'role', maxDepth: 16 });
    assert.ok(IMPORT_PARENT_SPECS.some((s) => s.table === 'role' && s.maxDepth === 16));
  });

  it('rejects hanging one 10-node chain under another at maxDepth 16, and allows a 17-role chain', () => {
    const a = chainIds('a', 10);
    const b = chainIds('b', 10);
    const known = new Set([...a, ...b]);
    const hanging = [...chainLinks(a), ...chainLinks(b), { id: a[0]!, parentId: b[9]! }];
    throwsInvalid(() => validateParentGraph(hanging, known, roleSpec), /deeper than 16/);

    const deep = chainIds('d', 17); // d00..d16: parent of the leaf has ancestor length 16
    validateParentGraph(chainLinks(deep), new Set(deep), roleSpec);
    const tooDeep = chainIds('e', 18);
    throwsInvalid(() => validateParentGraph(chainLinks(tooDeep), new Set(tooDeep), roleSpec), /deeper than 16/);
  });

  it('applies role parents after a first-pass insert, including an existing same-workspace parent, and rejects a foreign parent', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsmcp-role-parent-import-'));
    const db = openDatabase(path.join(dir, 'workspace.sqlite'));
    runAppMigrations(db);
    const memberId = ensureOwnerMember(db).id;
    const at = '2026-01-01T00:00:00.000Z';
    insertRole(db, memberId, 'rol_parent', 'manager', at);
    insertRole(db, memberId, 'rol_child', 'writer', at);
    applyImportedParentLinks(
      db,
      memberId,
      [
        { id: 'rol_child', parent_id: 'rol_parent' },
        { id: 'rol_parent', parent_id: null },
      ],
      roleSpec,
    );
    assert.equal(get<{ parent_id: string | null }>(db, "SELECT parent_id FROM role WHERE id = 'rol_child'")!.parent_id, 'rol_parent');
    assert.equal(get<{ parent_id: string | null }>(db, "SELECT parent_id FROM role WHERE id = 'rol_parent'")!.parent_id, null);

    run(db, "INSERT INTO member (id, user_id, name, is_owner, created_at) VALUES ('mem_other', NULL, 'Other', 0, ?)", at);
    insertRole(db, 'mem_other', 'rol_other', 'foreign', at);
    throwsInvalid(
      () => applyImportedParentLinks(db, memberId, [{ id: 'rol_child', parent_id: 'rol_other' }], roleSpec),
      /another workspace/,
    );
    db.close();
  });

  it('rejects hanging an imported subtree under an existing workspace chain that would exceed 16', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsmcp-role-parent-depth-'));
    const db = openDatabase(path.join(dir, 'workspace.sqlite'));
    runAppMigrations(db);
    const memberId = ensureOwnerMember(db).id;
    const at = '2026-01-01T00:00:00.000Z';
    const existing = chainIds('x', 10);
    for (const id of existing) insertRole(db, memberId, id, id, at);
    for (let i = 1; i < existing.length; i++) {
      run(db, 'UPDATE role SET parent_id = ? WHERE id = ?', existing[i - 1], existing[i]);
    }
    const incoming = chainIds('y', 10);
    for (const id of incoming) insertRole(db, memberId, id, id, at);
    const rows = [
      ...incoming.slice(1).map((id, i) => ({ id, parent_id: incoming[i]! })),
      { id: incoming[0]!, parent_id: existing[9]! },
    ];
    throwsInvalid(() => applyImportedParentLinks(db, memberId, rows, roleSpec), /deeper than 16/);
    assert.equal(get<{ parent_id: string | null }>(db, 'SELECT parent_id FROM role WHERE id = ?', incoming[0]!)!.parent_id, null);
    db.close();
  });
});
