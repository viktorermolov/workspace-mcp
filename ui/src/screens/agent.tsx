import { api, enc } from '../api.ts';
import { Empty, label, Loading, Page, Time, useData } from '../ui.tsx';
import { entityHref } from './content.tsx';

interface AgentTask {
  id: string;
  title: string;
  status: string;
  role: string | null;
  project: string | null;
}
interface AgentOverview {
  id: string;
  slug: string;
  name: string;
  platform: { id: string; name: string; active: boolean } | null;
  roles: { id: string; slug: string; name: string; archived: boolean }[];
  tasks_for_agent: AgentTask[];
  tasks_claimed: AgentTask[];
  last_checkpoint: { id: string; done: string; stopped_at: string; next: string; created_at: string; role: string; project: string | null } | null;
  recent: { id: number; at: string; claimed_role: string | null; entity_type: string; entity_id: string | null; action: string; summary: string }[];
}

function TaskList({ tasks, empty }: { tasks: AgentTask[]; empty: string }) {
  if (!tasks.length) return <Empty>{empty}</Empty>;
  return (
    <ul class="list">
      {tasks.map((t) => (
        <li key={t.id}>
          <a href={`/tasks/${enc(t.id)}`}>
            <strong>{t.title}</strong>
            <span class="muted small">
              {label(t.status)}
              {t.role ? ` · @${t.role}` : ''}
              {t.project ? ` · ${t.project}` : ''}
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}

/** One agent: where it runs, the roles it may take, its tasks, its last checkpoint and what it did last. */
export function AgentScreen({ id }: { id: string }) {
  const agent = useData(() => api<AgentOverview>(`/agents/${enc(id)}`), [id]);
  const a = agent.data;
  return (
    <Page title={a?.name ?? 'Agent'} back="/" actions={a ? <a href="/connections">Edit under its platform</a> : undefined}>
      <Loading error={agent.error} loading={agent.loading}>
        {a && (
          <div class="agent-view">
            <p class="small">
              {a.platform ? (
                <>
                  Runs on <strong>{a.platform.name}</strong>
                  {!a.platform.active && <span class="muted"> (revoked)</span>}
                </>
              ) : (
                <>
                  <strong>No platform yet.</strong> <a href="/connections">Attach it to a platform</a> so it can work.
                </>
              )}{' '}
              <span class="muted">· @{a.slug}</span>
            </p>
            <div class="section-head">
              <h2>Roles it may take</h2>
            </div>
            {a.roles.length === 0 ? (
              <Empty>No roles yet.</Empty>
            ) : (
              <p class="platform-roles">
                {a.roles.map((r) => (
                  <a key={r.id} class="chip" href={`/roles/${enc(r.slug)}`}>
                    {r.name}
                    {r.archived ? ' (archived)' : ''}
                  </a>
                ))}
              </p>
            )}
            <div class="section-head">
              <h2>Tasks addressed to it · {a.tasks_for_agent.length}</h2>
            </div>
            <TaskList tasks={a.tasks_for_agent} empty="No open task is addressed to this agent." />
            {a.tasks_claimed.length > 0 && (
              <>
                <div class="section-head">
                  <h2>Other tasks it has taken · {a.tasks_claimed.length}</h2>
                </div>
                <TaskList tasks={a.tasks_claimed} empty="" />
              </>
            )}
            <div class="section-head">
              <h2>Last checkpoint</h2>
            </div>
            {a.last_checkpoint ? (
              <div class="checkpoint">
                <span class="small muted">
                  <Time at={a.last_checkpoint.created_at} /> · as @{a.last_checkpoint.role}
                  {a.last_checkpoint.project ? ` · ${a.last_checkpoint.project}` : ''}
                </span>
                <p class="small">Done: {a.last_checkpoint.done}</p>
                <p class="small">Stopped at: {a.last_checkpoint.stopped_at}</p>
                <p class="small">Next: {a.last_checkpoint.next}</p>
              </div>
            ) : (
              <Empty>No checkpoint under this agent's name yet. It is recorded when the agent passes its name in calls.</Empty>
            )}
            <div class="section-head">
              <h2>Recent changes</h2>
            </div>
            {a.recent.length === 0 ? (
              <Empty>Nothing recorded under this agent's name yet.</Empty>
            ) : (
              <ul class="log">
                {a.recent.map((e) => {
                  const href = entityHref(e.entity_type, e.entity_id);
                  return (
                    <li key={e.id}>
                      <div class="log-main">{href ? <a href={href}>{e.summary}</a> : e.summary}</div>
                      <div class="small muted">
                        <Time at={e.at} />
                        {e.claimed_role ? ` · as @${e.claimed_role}` : ''}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
      </Loading>
    </Page>
  );
}
