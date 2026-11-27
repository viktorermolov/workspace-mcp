import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { worksWith } from '../ui/src/works-with.ts';

describe('who a role works with', () => {
  const line = (w: { before: string; other: string; after: string }) => `${w.before}@${w.other}${w.after}`;

  it('reads declared links and recorded hand-offs in both directions', () => {
    const links = [
      { from: 'lead', to: 'builder', type: 'delegates_to' },
      { from: 'guardian', to: 'builder', type: 'reviews' },
      { from: 'builder', to: 'lead', type: 'parent' },
      { from: 'builder', to: 'designer', type: 'pairs_with' },
    ];
    const interactions = [
      { from: 'lead', to: 'builder', kind: 'assigned', count: 3 },
      { from: 'builder', to: 'guardian', kind: 'commented', count: 1 },
      { from: 'owner', to: 'builder', kind: 'assigned', count: 2 },
    ];
    assert.deepEqual(worksWith('builder', links, interactions).map(line), [
      'is delegated to by @lead',
      'is reviewed by @guardian',
      'pairs with @designer',
      'got tasks from @lead (3)',
      'commented on tasks of @guardian (1)',
    ]);
    // The reporting line appears only on the manager's side; the role itself shows it at the top of its page.
    assert.deepEqual(worksWith('lead', links, interactions).map(line), ['delegates to @builder', '@builder reports to it', 'gave tasks to @builder (3)']);
  });

  it('is empty for a role with no links', () => {
    assert.deepEqual(worksWith('solo', [{ from: 'a', to: 'b', type: 'reviews' }], []), []);
  });
});
