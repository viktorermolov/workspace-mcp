import { api, enc } from '../api.ts';
import { type ArcInput, arcsFor, indentFor, isTestRole, layoutTree } from '../map-layout.ts';
import { Empty, Loading, Page, Time, useData } from '../ui.tsx';

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
  agents?: { slug: string; name: string; platform: string }[];
  last_checkpoint: { at: string; stopped_at: string; next: string; project: string | null } | null;
  last_activity_at: string | null;
}
interface MapPlatform {
  id: string;
  name: string;
  last_activity_at: string | null;
  agents: { slug: string; name: string; roles: { slug: string; name: string }[] }[];
}
interface MapData {
  roles: MapRole[];
  platforms?: MapPlatform[];
  links: { from: string; to: string; type: string }[];
  interactions: { from: string; to: string; kind: string; count: number; last_at: string }[];
  interactions_truncated?: boolean;
  unassigned_open_tasks: number;
}

// Card tree geometry, in CSS pixels. Cards stretch to the available width, so the tree never needs sideways scrolling.
const PITCH = 64;
const CARD_H = 52;
const GUTTER = 40;

/** Roles as a vertical tree of cards: lines on the left are the reporting line; arrows on the right are other links. */
function Graph({ data }: { data: MapData }) {
  if (data.roles.length < 1) return null;
  const { rows, maxDepth } = layoutTree(data.roles);
  const indent = indentFor(maxDepth);
  const pairs = new Map<string, ArcInput>();
  for (const l of data.links) pairs.set(`${l.from}>${l.to}`, { from: l.from, to: l.to, declared: true });
  for (const i of data.interactions) {
    const k = `${i.from}>${i.to}`;
    if (!pairs.has(k)) pairs.set(k, { from: i.from, to: i.to, declared: false });
  }
  const arcs = arcsFor(rows, [...pairs.values()]);
  const gutter = arcs.length ? GUTTER : 0;
  const height = rows.length * PITCH - (PITCH - CARD_H);
  const bySlug = new Map(rows.map((r) => [r.role.slug, r]));
  const mid = (row: number) => row * PITCH + CARD_H / 2;
  return (
    <div class="graph-wrap">
      <div class="graph" data-layout="tree" role="group" aria-label="Reporting tree of roles" style={{ height: `${height}px` }}>
        <svg class="graph-lines" width={(maxDepth + 1) * indent} height={height} aria-hidden="true">
          {rows.map((r) => {
            const p = r.parent ? bySlug.get(r.parent) : undefined;
            if (!p) return null;
            const x = p.depth * indent + indent / 2;
            return <path key={r.role.slug} class="graph-link" d={`M${x},${p.row * PITCH + CARD_H} V${mid(r.row)} H${r.depth * indent}`} />;
          })}
        </svg>
        {gutter > 0 && (
          <svg class="graph-arcs" width={gutter} height={height} aria-hidden="true">
            <defs>
              <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" class="graph-arrow" />
              </marker>
            </defs>
            {arcs.map((a) => {
              const span = Math.abs(a.toRow - a.fromRow);
              const bend = Math.min(gutter - 4, 10 + 4 * span);
              const c = (bend - 1) / 0.75;
              const y1 = mid(a.fromRow) - 6;
              const y2 = mid(a.toRow) + 6;
              return (
                <path
                  key={`${a.from}>${a.to}`}
                  class={a.declared ? 'graph-link' : 'graph-link recorded'}
                  d={`M2,${y1} C${c},${y1} ${c},${y2} 3,${y2}`}
                  marker-end="url(#arrow)"
                />
              );
            })}
          </svg>
        )}
        {rows.map(({ role, depth, row, test }) => (
          <a
            key={role.slug}
            href={`/roles/${enc(role.slug)}`}
            class={`graph-card${role.open_total ? ' busy' : ''}${role.archived ? ' archived' : ''}${test ? ' test' : ''}`}
            data-slug={role.slug}
            data-depth={depth}
            title={role.name}
            aria-label={`${role.name}${role.archived ? ' (archived)' : ''}: ${role.open_total} open tasks`}
            style={{ top: `${row * PITCH}px`, left: `${depth * indent}px`, right: `${gutter}px`, height: `${CARD_H}px` }}
          >
            <span class="graph-name">
              {role.name}
              {role.archived && <span class="graph-archived"> · archived</span>}
            </span>
            <span class="graph-count">{role.open_total} open</span>
          </a>
        ))}
      </div>
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
            {(data.platforms ?? []).length > 0 && (
              <section class="platforms" aria-label="Platforms and their agents">
                {data.platforms!.map((p) => (
                  <div class="platform" key={p.id}>
                    <div class="platform-head">
                      <strong>{p.name}</strong>
                      <span class="small muted">
                        {p.agents.length === 1 ? '1 agent' : `${p.agents.length} agents`} · last used <Time at={p.last_activity_at} />
                      </span>
                    </div>
                    {p.agents.length === 0 ? (
                      <p class="small muted">
                        No agents recorded. <a href="/connections">Add one</a>
                      </p>
                    ) : (
                      <ul class="plain platform-agents">
                        {p.agents.map((a) => (
                          <li key={a.slug}>
                            <a class="platform-agent" href={`/agents/${enc(a.slug)}`}>
                              {a.name}
                            </a>
                            <span class="platform-roles">
                              {a.roles.length === 0 && <span class="small muted">no roles yet</span>}
                              {a.roles.map((r) => (
                                <a key={r.slug} class="chip" href={`/roles/${enc(r.slug)}`}>
                                  {r.name}
                                </a>
                              ))}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ))}
              </section>
            )}
            <Graph data={data} />
            <p class="muted small legend">
              At the top: each platform, its agents and the roles they may take. Each card in the tree is a role with its open tasks; tap it to open the role's page with its instruction, tasks, routines and last checkpoint. Lines on the left are the reporting line, top to bottom. Arrows on the right: solid are declared links, dashed are recorded interactions (assigned, commented, claimed). Times are record times, not live status.
              {data.roles.some((r) => isTestRole(r.name)) && ' Test roles (named [TEST] …) are dashed and listed after the team.'}
            </p>
            {data.interactions_truncated && <p class="muted small">The dashed lines only cover the most recent 2,000 recorded interactions in the last 30 days.</p>}
            {data.unassigned_open_tasks > 0 && (
              <p>
                <a href="/tasks?role=-">{data.unassigned_open_tasks === 1 ? '1 open task' : `${data.unassigned_open_tasks} open tasks`}</a> {data.unassigned_open_tasks === 1 ? 'has' : 'have'} no role.
              </p>
            )}
          </>
        )}
      </Loading>
    </Page>
  );
}
