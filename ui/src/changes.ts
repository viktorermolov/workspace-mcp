/**
 * Groups changes by the item they touch, so a task that was created, assigned and claimed is one
 * card instead of three. Groups keep the order of their newest change; inside a group the oldest comes first.
 */
export function groupChanges<T extends { id: number; entity_type: string; entity_id: string | null }>(items: T[]): T[][] {
  const groups = new Map<string, T[]>();
  for (const c of items) {
    const key = c.entity_id ? `${c.entity_type}:${c.entity_id}` : `single:${c.id}`;
    const g = groups.get(key);
    if (g) g.push(c);
    else groups.set(key, [c]);
  }
  return [...groups.values()].map((g) => [...g].sort((a, b) => a.id - b.id));
}
