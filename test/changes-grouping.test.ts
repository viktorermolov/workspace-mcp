import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { groupChanges } from '../ui/src/changes.ts';

describe('change feed grouping', () => {
  const ev = (id: number, entity_type: string, entity_id: string | null) => ({ id, entity_type, entity_id });

  it('puts changes to one item in one group, oldest first, and keeps groups in the order of their first appearance', () => {
    // The feed arrives newest first.
    const groups = groupChanges([ev(9, 'task', 't2'), ev(8, 'task', 't1'), ev(7, 'document', 'd1'), ev(6, 'task', 't1'), ev(5, 'task', 't2'), ev(4, 'task', 't1')]);
    assert.deepEqual(
      groups.map((g) => g.map((c) => c.id)),
      [[5, 9], [4, 6, 8], [7]],
    );
  });

  it('keeps items of different types apart even with the same id, and never merges changes that have no item', () => {
    const groups = groupChanges([ev(4, 'role', 'x'), ev(3, 'project', 'x'), ev(2, 'github', null), ev(1, 'github', null)]);
    assert.deepEqual(groups.map((g) => g.map((c) => c.id)), [[4], [3], [2], [1]]);
  });

  it('returns nothing for an empty feed', () => {
    assert.deepEqual(groupChanges([]), []);
  });
});
