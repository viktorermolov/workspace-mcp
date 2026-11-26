import { api, enc } from '../api.ts';
import { Badge, Card, Empty, Loading, Page, Time, useData } from '../ui.tsx';

interface MapRole {
  id: string;
  slug: string;
  name: string;
  area: string;
  archived?: boolean;
  parent?: { id: string; slug: string } | null;
  depth?: number;
  open_tasks: Record<string, number>;
  open_total: number;
  open_task_list?: { id: string; title: string; status: string }[];
  open_more?: number;
  routines?: { id: string; name: string; schedule: string; status: string; last_run: string | null }[];
  last_checkpoint: { at: string; stopped_at: string; next: string; project: string | null } | null;
  last_activity_at: string | null;
}
interface MapData {
  roles: MapRole[];
  links: { from: string; to: string; type: string }[];
  interactions: { from: string; to: string; kind: string; count: number; last_at: string }[];
  interactions_truncated?: boolean;
  unassigned_open_tasks: number;
}

const KIND: Record<string, string> = {
  assigned: 'gave tasks to',
  commented: 'commented on tasks of',
  claimed: 'claimed a task of',
  delegates_to: 'delegates to',
  reports_to: 'reports to',
  parent: 'reports to',
};

const COL = 160;
const ROW = 110;
const PAD_X = 48;
const PAD_Y = 44;
const NODE_R = 22;

function layoutForest(roles: MapRole[]) {
  const bySlug = new Map(roles.map((r) => [r.slug, r]));
  const children = new Map<string, string[]>();
  const hasParent = new Set<string>();
  for (const r of roles) {
    const p = r.parent?.slug;
    if (p && bySlug.has(p)) {
      const list = children.get(p) ?? [];
      list.push(r.slug);
      children.set(p, list);
      hasParent.add(r.slug);
    }
  }
  for (const list of children.values()) list.sort((a, b) => (bySlug.get(a)?.name ?? a).localeCompare(bySlug.get(b)?.name ?? b));
  const roots = roles
    .filter((r) => !hasParent.has(r.slug))
    .map((r) => r.slug)
    .sort((a, b) => (bySlug.get(a)?.name ?? a).localeCompare(bySlug.get(b)?.name ?? b));

  const subtreeW = new Map<string, number>();
  const walkW = (slug: string, stack: Set<string>): number => {
    if (subtreeW.has(slug)) return subtreeW.get(slug)!;
    if (stack.has(slug)) {
      subtreeW.set(slug, 1);
      return 1;
    }
    stack.add(slug);
    const kids = children.get(slug) ?? [];
    const w = kids.length ? kids.reduce((s, k) => s + walkW(k, stack), 0) : 1;
    stack.delete(slug);
    subtreeW.set(slug, w);
    return w;
  };
  for (const root of roots) walkW(root, new Set());

  const pos = new Map<string, { x: number; y: number; role: MapRole }>();
  const place = (slug: string, left: number, depth: number, stack: Set<string>) => {
    const w = subtreeW.get(slug) ?? 1;
    const role = bySlug.get(slug)!;
    pos.set(slug, { x: left + (w * COL) / 2, y: PAD_Y + depth * ROW, role });
    if (stack.has(slug)) return;
    stack.add(slug);
    let cx = left;
    for (const k of children.get(slug) ?? []) {
      const kw = subtreeW.get(k) ?? 1;
      place(k, cx, depth + 1, stack);
      cx += kw * COL;
    }
    stack.delete(slug);
  };
  let left = PAD_X;
  for (const root of roots) {
    const w = subtreeW.get(root) ?? 1;
    place(root, left, 0, new Set());
    left += w * COL + 24;
  }
  const xs = [...pos.values()].map((p) => p.x);
  const ys = [...pos.values()].map((p) => p.y);
  const width = Math.max(320, (xs.length ? Math.max(...xs) : 0) + PAD_X + 48);
  const height = Math.max(200, (ys.length ? Math.max(...ys) : 0) + PAD_Y + 56);
  return { pos, width, height };
}

/** Roles as a top-down forest: solid arrows are reporting and declared links, dashed arrows are recorded interactions. */
function Graph({ data }: { data: MapData }) {
  const n = data.roles.length;
  if (n < 1) return null;
  const { pos, width, height } = layoutForest(data.roles);
  const pairs = new Map<string, { from: string; to: string; declared: boolean; recorded: number }>();
  for (const l of data.links) {
    const k = `${l.from}>${l.to}`;
    pairs.set(k, { from: l.from, to: l.to, declared: true, recorded: pairs.get(k)?.recorded ?? 0 });
  }
  for (const i of data.interactions) {
    const k = `${i.from}>${i.to}`;
    const p = pairs.get(k) ?? { from: i.from, to: i.to, declared: false, recorded: 0 };
    p.recorded += i.count;
    pairs.set(k, p);
  }
  return (
    <div class="graph-wrap">
      <svg class="graph" data-layout="tree" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Reporting tree of roles">
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" class="graph-arrow" />
          </marker>
        </defs>
        {[...pairs.values()].map((p) => {
          const a = pos.get(p.from);
          const b = pos.get(p.to);
          if (!a || !b || a === b) return null;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const len = Math.hypot(dx, dy) || 1;
          const pad = NODE_R + 4;
          return (
            <line
              key={`${p.from}>${p.to}`}
              x1={a.x + (dx / len) * pad}
              y1={a.y + (dy / len) * pad}
              x2={b.x - (dx / len) * pad}
              y2={b.y - (dy / len) * pad}
              class={p.declared ? 'graph-link' : 'graph-link recorded'}
              marker-end="url(#arrow)"
            />
          );
        })}
        {[...pos.values()].map(({ x, y, role }) => (
          <a key={role.slug} href={`/roles/${enc(role.slug)}`}>
            <rect x={x - 22} y={y - 22} width="44" height="44" class="graph-hit" />
            <circle cx={x} cy={y} r={NODE_R} class={`graph-node${role.open_total ? ' busy' : ''}${role.archived ? ' archived' : ''}`} />
            <text x={x} y={y + 4} text-anchor="middle" class="graph-count">
              {role.open_total}
            </text>
            <text x={x} y={y + 38} text-anchor="middle" class="graph-label">
              {role.name.length > 14 ? `${role.name.slice(0, 13)}…` : role.name}
            </text>
            {role.archived && (
              <text x={x} y={y + 50} text-anchor="middle" class="graph-label archived-label">
                archived
              </text>
            )}
          </a>
        ))}
      </svg>
    </div>
  );
}

export function MapScreen() {
  const { data, error, loading } = useData(() => api<MapData>('/map'));
  return (
    <Page title="Map">
      <Loading error={error} loading={loading}>
        {data && !data.roles.length && (
          <Empty>
            No roles yet. Ask a connected agent to fill the workspace (it calls <code>start</code> and gets instructions), or add a role under <a href="/roles">Roles</a>.
          </Empty>
        )}
        {data && data.roles.length > 0 && (
          <>
            <Graph data={data} />
            <p class="muted small legend">
              Numbers are open tasks. Solid arrows are the reporting line and declared links; dashed arrows are recorded interactions (assigned, commented, claimed). Times are record times, not live status.
            </p>
            {data.interactions_truncated && <p class="muted small">The dashed lines only cover the most recent 2,000 recorded interactions in the last 30 days.</p>}
            {data.unassigned_open_tasks > 0 && (
              <p>
                <a href="/tasks?role=-">{data.unassigned_open_tasks} open tasks</a> have no role.
              </p>
            )}
            <div class="cards">
              {data.roles.map((r) => {
                const out = [...data.links.filter((l) => l.from === r.slug).map((l) => ({ to: l.to, kind: l.type, count: 0 })), ...data.interactions.filter((i) => i.from === r.slug).map((i) => ({ to: i.to, kind: i.kind, count: i.count }))];
                return (
                  <Card key={r.slug}>
                    <div class="card-head">
                      <a class="card-title" href={`/roles/${enc(r.slug)}`}>
                        {r.name}
                        {r.archived ? ' (archived)' : ''}
                      </a>
                      <a href={`/tasks?role=${enc(r.slug)}`}>
                        <Badge tone={r.open_total ? 'accent' : 'neutral'}>{r.open_total} open</Badge>
                      </a>
                    </div>
                    {r.area && <p class="muted">{r.area}</p>}
                    {Object.keys(r.open_tasks).some((s) => s !== 'open') && (
                      <p class="small">
                        {Object.entries(r.open_tasks)
                          .map(([s, n]) => `${n} ${s.replace('_', ' ')}`)
                          .join(' · ')}
                      </p>
                    )}
                    {(r.open_task_list ?? []).length > 0 && (
                      <ul class="plain small">
                        {r.open_task_list!.map((t) => (
                          <li key={t.id}>
                            <a href={`/tasks/${enc(t.id)}`}>{t.title}</a>
                          </li>
                        ))}
                        {(r.open_more ?? 0) > 0 && <li class="muted">{r.open_more} more open</li>}
                      </ul>
                    )}
                    {(r.routines ?? []).length > 0 && (
                      <ul class="plain small">
                        {r.routines!.map((rt) => (
                          <li key={rt.id}>
                            {rt.name} · {rt.schedule}
                            {rt.status === 'paused' ? ' (paused)' : ''}
                          </li>
                        ))}
                      </ul>
                    )}
                    {r.last_checkpoint && (
                      <div class="checkpoint">
                        <span class="small muted">
                          Last checkpoint <Time at={r.last_checkpoint.at} />
                          {r.last_checkpoint.project ? ` · ${r.last_checkpoint.project}` : ''}
                        </span>
                        {r.last_checkpoint.stopped_at && <p class="small">Stopped at: {r.last_checkpoint.stopped_at}</p>}
                        {r.last_checkpoint.next && <p class="small">Next: {r.last_checkpoint.next}</p>}
                      </div>
                    )}
                    {out.length > 0 && (
                      <ul class="plain small">
                        {out.map((o, i) => (
                          <li key={i}>
                            {KIND[o.kind] ?? o.kind.replace(/_/g, ' ')} <a href={`/roles/${enc(o.to)}`}>{o.to}</a>
                            {o.count ? ` (${o.count})` : ''}
                          </li>
                        ))}
                      </ul>
                    )}
                    <p class="small muted">
                      Last recorded activity <Time at={r.last_activity_at} />
                    </p>
                  </Card>
                );
              })}
            </div>
          </>
        )}
      </Loading>
    </Page>
  );
}
