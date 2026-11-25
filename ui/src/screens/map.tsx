import { api, enc } from '../api.ts';
import { Badge, Card, Empty, Loading, Page, Time, useData } from '../ui.tsx';

interface MapRole {
  id: string;
  slug: string;
  name: string;
  area: string;
  open_tasks: Record<string, number>;
  open_total: number;
  last_checkpoint: { at: string; stopped_at: string; next: string; project: string | null } | null;
  last_activity_at: string | null;
}
interface MapData {
  roles: MapRole[];
  links: { from: string; to: string; type: string }[];
  interactions: { from: string; to: string; kind: string; count: number; last_at: string }[];
  unassigned_open_tasks: number;
}

const KIND: Record<string, string> = { assigned: 'gave tasks to', commented: 'commented on tasks of', delegates_to: 'delegates to', reports_to: 'reports to' };

/** Roles as a small network: nodes on a circle, declared links solid, recorded interactions dashed. */
function Graph({ data }: { data: MapData }) {
  const n = data.roles.length;
  if (n < 2 || n > 16) return null;
  const size = 320;
  const r = 118;
  const c = size / 2;
  const pos = new Map(data.roles.map((role, i) => [role.slug, { x: c + r * Math.cos((2 * Math.PI * i) / n - Math.PI / 2), y: c + r * Math.sin((2 * Math.PI * i) / n - Math.PI / 2), role }]));
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
    <svg class="graph" viewBox={`0 0 ${size} ${size}`} role="img" aria-label="Roles and how they interact">
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
        const pad = 26;
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
          <circle cx={x} cy={y} r="22" class={role.open_total ? 'graph-node busy' : 'graph-node'} />
          <text x={x} y={y + 4} text-anchor="middle" class="graph-count">
            {role.open_total}
          </text>
          <text x={x} y={y + 38} text-anchor="middle" class="graph-label">
            {role.name.length > 14 ? `${role.name.slice(0, 13)}…` : role.name}
          </text>
        </a>
      ))}
    </svg>
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
              Numbers are open tasks. Solid arrows are declared links, dashed arrows are recorded interactions. Times are when something was recorded, not live status.
            </p>
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
                      </a>
                      <a href={`/tasks?role=${enc(r.slug)}`}>
                        <Badge tone={r.open_total ? 'accent' : 'neutral'}>{r.open_total} open</Badge>
                      </a>
                    </div>
                    {r.area && <p class="muted">{r.area}</p>}
                    {/* The breakdown by status adds nothing when every open task is plain "open": the badge already says it. */}
                    {Object.keys(r.open_tasks).some((s) => s !== 'open') && (
                      <p class="small">
                        {Object.entries(r.open_tasks)
                          .map(([s, n]) => `${n} ${s.replace('_', ' ')}`)
                          .join(' · ')}
                      </p>
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
