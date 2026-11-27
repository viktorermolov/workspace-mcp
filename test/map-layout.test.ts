import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { arcsFor, indentFor, isTestRole, type LayoutRole, layoutTree } from '../ui/src/map-layout.ts';

const role = (slug: string, name: string, parent?: string): LayoutRole => ({ slug, name, parent: parent ? { slug: parent } : null });

// The shape reported in #102: the real team plus leftover unparented `[TEST]` roles.
const LIVE_SHAPE: LayoutRole[] = [
  role('test-builder', '[TEST] Builder'),
  role('test-chief', '[TEST] Chief Strategist'),
  role('builder', 'Builder', 'arina'),
  role('dev-guardian', 'Dev Guardian', 'arina'),
  role('growth', 'Growth', 'arina'),
  role('chief-strategist', 'Chief Strategist', 'arina'),
  role('chief-of-staff', 'Chief of Staff', 'arina'),
  role('hermes', 'Hermes', 'chief-of-staff'),
  role('arina', 'Арина'),
];

describe('map tree layout', () => {
  it('recognises [TEST] role names', () => {
    assert.equal(isTestRole('[TEST] Builder'), true);
    assert.equal(isTestRole('  [test] chief'), true);
    assert.equal(isTestRole('Builder [TEST]'), false);
    assert.equal(isTestRole('Арина'), false);
  });

  it('puts the real team on top as a depth-first vertical tree and [TEST] roots last', () => {
    const { rows, maxDepth } = layoutTree(LIVE_SHAPE);
    assert.deepEqual(
      rows.map((r) => [r.role.slug, r.depth, r.row, r.parent]),
      [
        ['arina', 0, 0, null],
        ['builder', 1, 1, 'arina'],
        ['chief-of-staff', 1, 2, 'arina'],
        ['hermes', 2, 3, 'chief-of-staff'],
        ['chief-strategist', 1, 4, 'arina'],
        ['dev-guardian', 1, 5, 'arina'],
        ['growth', 1, 6, 'arina'],
        ['test-builder', 0, 7, null],
        ['test-chief', 0, 8, null],
      ],
    );
    assert.equal(maxDepth, 2);
    assert.deepEqual(
      rows.filter((r) => r.test).map((r) => r.role.slug),
      ['test-builder', 'test-chief'],
    );
  });

  it('orders real roots by tree size, then name; [TEST] children after real siblings', () => {
    const { rows } = layoutTree([
      role('solo', 'Aaron'),
      role('lead', 'Zed'),
      role('a', 'Alpha', 'lead'),
      role('t', '[TEST] Alpha', 'lead'),
      role('b', 'Beta', 'lead'),
    ]);
    assert.deepEqual(
      rows.map((r) => r.role.slug),
      ['lead', 'a', 'b', 't', 'solo'],
    );
  });

  it('treats a role whose parent is not on the map as a root', () => {
    const { rows } = layoutTree([role('x', 'X', 'gone'), role('y', 'Y', 'x')]);
    assert.deepEqual(
      rows.map((r) => [r.role.slug, r.depth]),
      [
        ['x', 0],
        ['y', 1],
      ],
    );
  });

  it('shows every role once even with a parent cycle', () => {
    const { rows } = layoutTree([role('a', 'A', 'b'), role('b', 'B', 'a'), role('self', 'Self', 'self')]);
    assert.equal(rows.length, 3);
    assert.deepEqual(new Set(rows.map((r) => r.role.slug)), new Set(['a', 'b', 'self']));
    assert.deepEqual(
      rows.map((r) => r.row),
      [0, 1, 2],
    );
  });

  it('keeps a wide team in one column: rows grow, not width', () => {
    const roles = [role('head', 'Head'), ...Array.from({ length: 40 }, (_, i) => role(`r${i}`, `Role ${String(i).padStart(2, '0')}`, 'head'))];
    for (let i = 0; i < 12; i++) roles.push(role(`root${i}`, `Root ${i}`));
    const { rows, maxDepth } = layoutTree(roles);
    assert.equal(rows.length, roles.length);
    assert.equal(maxDepth, 1);
    assert.equal(rows[0].role.slug, 'head');
  });

  it('indents less in deep trees so the indent stays within a fixed budget', () => {
    assert.equal(indentFor(0), 24);
    assert.equal(indentFor(2), 24);
    assert.equal(indentFor(10), 12);
    assert.equal(indentFor(100), 8);
    for (const d of [1, 3, 5, 8, 15]) assert.ok(indentFor(d) * d <= 120);
  });

  it('draws arcs only for links the tree does not already show', () => {
    const { rows } = layoutTree(LIVE_SHAPE);
    const arcs = arcsFor(rows, [
      { from: 'builder', to: 'arina', declared: true }, // the reporting line itself (a `parent` link)
      { from: 'arina', to: 'builder', declared: false }, // a recorded interaction along it is still shown
      { from: 'dev-guardian', to: 'builder', declared: true },
      { from: 'builder', to: 'builder', declared: false },
      { from: 'builder', to: 'nobody', declared: true },
    ]);
    assert.deepEqual(
      arcs.map((a) => [a.from, a.to, a.fromRow, a.toRow, a.declared]),
      [
        ['arina', 'builder', 0, 1, false],
        ['dev-guardian', 'builder', 5, 1, true],
      ],
    );
  });
});
