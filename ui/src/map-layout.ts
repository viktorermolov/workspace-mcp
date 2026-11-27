// Layout of the Map graph: a vertical, indented tree of role cards that always fits the screen width.
// Pure functions (no DOM), so they are unit-tested in test/map-layout.test.ts.

export interface LayoutRole {
  slug: string;
  name: string;
  parent?: { slug: string } | null;
}

export interface TreeRow<R extends LayoutRole = LayoutRole> {
  role: R;
  /** 0 for a root. */
  depth: number;
  /** Position from the top, 0-based; one card per row. */
  row: number;
  /** Slug of the parent card this row hangs under, or null for a root. */
  parent: string | null;
  /** The name marks it as a test or fixture role (`[TEST] …`). */
  test: boolean;
}

export interface TreeLayout<R extends LayoutRole = LayoutRole> {
  rows: TreeRow<R>[];
  maxDepth: number;
}

/** Roles named like `[TEST] Builder` are test or fixture records, not part of the real team. */
export function isTestRole(name: string): boolean {
  return /^\s*\[test\]/i.test(name);
}

/**
 * Orders roles as a depth-first, top-to-bottom tree.
 * - A role hangs under its parent when the parent is in the list; otherwise it is a root.
 * - Roots: real roles first, the biggest tree first (so the head of the team is on top), then by name;
 *   roots named `[TEST] …` always come after every real tree.
 * - Children: real roles before `[TEST] …` roles, then by name.
 * - A parent cycle (not reachable from any root) is still shown, starting from its first role by the same order.
 */
export function layoutTree<R extends LayoutRole>(roles: R[]): TreeLayout<R> {
  const bySlug = new Map(roles.map((r) => [r.slug, r]));
  const children = new Map<string, R[]>();
  const hasParent = new Set<string>();
  for (const r of roles) {
    const p = r.parent?.slug;
    if (p && p !== r.slug && bySlug.has(p)) {
      const list = children.get(p) ?? [];
      list.push(r);
      children.set(p, list);
      hasParent.add(r.slug);
    }
  }
  const byName = (a: R, b: R) => Number(isTestRole(a.name)) - Number(isTestRole(b.name)) || a.name.localeCompare(b.name) || a.slug.localeCompare(b.slug);
  for (const list of children.values()) list.sort(byName);

  const sizeMemo = new Map<string, number>();
  const size = (slug: string, stack: Set<string>): number => {
    const known = sizeMemo.get(slug);
    if (known !== undefined) return known;
    if (stack.has(slug)) return 0;
    stack.add(slug);
    let n = 1;
    for (const k of children.get(slug) ?? []) n += size(k.slug, stack);
    stack.delete(slug);
    sizeMemo.set(slug, n);
    return n;
  };
  const rootOrder = (a: R, b: R) =>
    Number(isTestRole(a.name)) - Number(isTestRole(b.name)) || size(b.slug, new Set()) - size(a.slug, new Set()) || byName(a, b);

  const rows: TreeRow<R>[] = [];
  const seen = new Set<string>();
  let maxDepth = 0;
  const visit = (role: R, depth: number, parent: string | null) => {
    if (seen.has(role.slug)) return;
    seen.add(role.slug);
    rows.push({ role, depth, row: rows.length, parent, test: isTestRole(role.name) });
    if (depth > maxDepth) maxDepth = depth;
    for (const k of children.get(role.slug) ?? []) visit(k, depth + 1, role.slug);
  };
  for (const root of roles.filter((r) => !hasParent.has(r.slug)).sort(rootOrder)) visit(root, 0, null);
  // Roles whose parent chain loops never reach a root above; show them rather than drop them.
  for (const r of [...roles].sort(byName)) if (!seen.has(r.slug)) visit(r, 0, null);
  return { rows, maxDepth };
}

/** Horizontal indent per tree level, in CSS pixels: deep trees indent less, so the cards keep their width. */
export function indentFor(maxDepth: number, maxIndent = 24, budget = 120): number {
  if (maxDepth < 1) return maxIndent;
  return Math.max(8, Math.min(maxIndent, Math.floor(budget / maxDepth)));
}

export interface ArcInput {
  from: string;
  to: string;
  declared: boolean;
}

export interface Arc {
  from: string;
  to: string;
  fromRow: number;
  toRow: number;
  declared: boolean;
}

/**
 * Links and interactions other than the reporting line drawn by the tree itself.
 * A declared link that only repeats the reporting line (either direction) is dropped; self-links and links to
 * roles not on the map are dropped.
 */
export function arcsFor(rows: TreeRow[], pairs: ArcInput[]): Arc[] {
  const rowOf = new Map(rows.map((r) => [r.role.slug, r]));
  const out: Arc[] = [];
  for (const p of pairs) {
    const a = rowOf.get(p.from);
    const b = rowOf.get(p.to);
    if (!a || !b || a === b) continue;
    const treeEdge = a.parent === b.role.slug || b.parent === a.role.slug;
    if (treeEdge && p.declared) continue;
    out.push({ from: p.from, to: p.to, fromRow: a.row, toRow: b.row, declared: p.declared });
  }
  return out;
}
