import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { applyImportedParentLinks, validateParentGraph } from '../src/backup/parent-import.ts';
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
