import { useMemo, useState } from 'preact/hooks';
import { api, enc, post } from '../api.ts';
import { navigate } from '../router.ts';
import { Alert, ArchiveControls, Badge, Button, Card, Empty, Field, label, Loading, Page, STATUS_TONE, Time, useAction, useData } from '../ui.tsx';

export const STATUSES = ['open', 'in_progress', 'blocked', 'in_review', 'done', 'cancelled'];
export const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const OPEN = ['open', 'in_progress', 'blocked', 'in_review'];

interface TaskSummary {
  id: string;
  title: string;
  status: string;
  priority: string;
  role: string | null;
  project: string | null;
  parent_id: string | null;
  due_date: string | null;
  rev: number;
  updated_at: string;
  blocking_reason: string | null;
  archived: boolean;
}
interface Issue {
  id: string;
  number: number;
  title: string;
  state: 'open' | 'closed';
  url: string;
  labels: string[];
  updated_at: string;
  repo: string;
  project: string | null;
  role: string | null;
}
interface Tree {
  tasks: TaskSummary[];
  dependencies: { task_id: string; depends_on_id: string; depends_on_title: string; depends_on_status: string }[];
  issues: Issue[];
}

interface AgentChoice {
  slug: string;
  name: string;
  platform: string;
  roles: string[];
}

/** Role and project choices for selects. */
export function useChoices() {
  return useData(() => api<{ roles: { slug: string; name: string }[]; projects: { slug: string; name: string }[]; agents?: AgentChoice[] }>('/choices'));
}

type Dep = { title: string; status: string };

function TaskRow({ t, depth, deps }: { t: TaskSummary; depth: number; deps: Map<string, Dep[]> }) {
  // Dependencies come with their own title and status, so a filter never hides what a task waits for.
  const waiting = (deps.get(t.id) ?? []).filter((d) => !['done', 'cancelled'].includes(d.status));
  return (
    <li class={`task depth-${Math.min(depth, 4)}`}>
      <a href={`/tasks/${enc(t.id)}`} class="task-link">
        <span class="task-title">
          {t.priority === 'urgent' || t.priority === 'high' ? <Badge tone="warn">{t.priority}</Badge> : null} {t.title}
        </span>
        <span class="task-meta">
          <Badge tone={STATUS_TONE[t.status]}>{label(t.status)}</Badge>
          {t.role && <span>@{t.role}</span>}
          {t.project && <span>{t.project}</span>}
          {t.due_date && <span>due {t.due_date}</span>}
          {t.archived && <Badge>archived</Badge>}
        </span>
        {waiting.length > 0 && <span class="task-deps small">waits for: {waiting.map((d) => d.title).join(', ')}</span>}
        {t.status === 'blocked' && t.blocking_reason && <span class="task-deps small">blocked: {t.blocking_reason}</span>}
      </a>
    </li>
  );
}

function IssueRow({ i, roles, onChange }: { i: Issue; roles: { slug: string; name: string }[]; onChange: () => void }) {
  const act = useAction();
  return (
    <li class="task issue">
      <div class="task-link">
        <span class="task-title">
          <a href={i.url} target="_blank" rel="noopener noreferrer">
            {i.repo}#{i.number}
          </a>{' '}
          {i.title}
        </span>
        <span class="task-meta">
          <Badge tone={i.state === 'open' ? 'neutral' : 'ok'}>{i.state}</Badge>
          {i.project && <span>{i.project}</span>}
          {i.labels.slice(0, 4).map((l) => (
            <span key={l} class="label">
              {l}
            </span>
          ))}
          <select
            aria-label={`Role for issue ${i.number}`}
            value={i.role ?? ''}
            disabled={act.busy}
            onChange={(e) => act.run(() => post(`/issues/${enc(i.id)}/role`, { role: (e.target as HTMLSelectElement).value || null })).then(onChange)}
          >
            <option value="">no role</option>
            {roles.map((r) => (
              <option key={r.slug} value={r.slug}>
                @{r.slug}
              </option>
            ))}
          </select>
        </span>
        {act.error && <span class="error small">{act.error}</span>}
      </div>
    </li>
  );
}

/** The task list as last shown (with its filters), so Back from a task returns to the same view. */
let lastListUrl = '/tasks';
const listUrl = () => `/tasks${location.search}`;

export function TasksScreen() {
  const q = new URLSearchParams(location.search);
  lastListUrl = listUrl();
  const [project, setProject] = useState(q.get('project') ?? '');
  const [role, setRole] = useState(q.get('role') ?? '');
  const [status, setStatus] = useState(q.get('status') ?? 'active');
  const [archived, setArchived] = useState(q.get('archived') === '1');
  const choices = useChoices();
  const tree = useData(() => {
    const p = new URLSearchParams();
    if (project) p.set('project', project);
    if (role && role !== '-') p.set('role', role);
    const st = status === 'active' ? OPEN : status === 'all' ? [] : [status];
    for (const s of st) p.append('status', s);
    if (archived) p.set('archived', '1');
    return api<Tree>(`/tasks?${p}`);
  }, [project, role, status, archived]);

  const setFilter = (k: string, v: string, set: (v: string) => void) => {
    set(v);
    const p = new URLSearchParams(location.search);
    if (v) p.set(k, v);
    else p.delete(k);
    history.replaceState(null, '', `/tasks${p.size ? `?${p}` : ''}`);
    lastListUrl = listUrl();
  };

  const view = useMemo(() => {
    const d = tree.data;
    if (!d) return null;
    const tasks = role === '-' ? d.tasks.filter((t) => !t.role) : d.tasks;
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const deps = new Map<string, Dep[]>();
    for (const x of d.dependencies) deps.set(x.task_id, [...(deps.get(x.task_id) ?? []), { title: x.depends_on_title, status: x.depends_on_status }]);
    const children = new Map<string, TaskSummary[]>();
    const roots: TaskSummary[] = [];
    for (const t of tasks) {
      if (t.parent_id && byId.has(t.parent_id)) children.set(t.parent_id, [...(children.get(t.parent_id) ?? []), t]);
      else roots.push(t);
    }
    const rows: { t: TaskSummary; depth: number }[] = [];
    const walk = (t: TaskSummary, depth: number, seen: Set<string>) => {
      if (seen.has(t.id)) return;
      seen.add(t.id);
      rows.push({ t, depth });
      for (const c of children.get(t.id) ?? []) walk(c, depth + 1, seen);
    };
    const seen = new Set<string>();
    for (const r of roots) walk(r, 0, seen);
    return { rows, deps, issues: role === '-' ? d.issues.filter((i) => !i.role) : d.issues };
  }, [tree.data, role]);

  return (
    <Page
      title="Tasks"
      actions={
        <Button kind="primary" onClick={() => navigate(`/tasks/new${project ? `?project=${enc(project)}` : ''}`)}>
          New task
        </Button>
      }
    >
      <div class="filters">
        <select aria-label="Status" value={status} onChange={(e) => setFilter('status', (e.target as HTMLSelectElement).value, setStatus)}>
          <option value="active">Open and in progress</option>
          <option value="all">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {label(s)}
            </option>
          ))}
        </select>
        <select aria-label="Role" value={role} onChange={(e) => setFilter('role', (e.target as HTMLSelectElement).value, setRole)}>
          <option value="">All roles</option>
          <option value="-">No role</option>
          {choices.data?.roles.map((r) => (
            <option key={r.slug} value={r.slug}>
              {r.name}
            </option>
          ))}
        </select>
        <select aria-label="Project" value={project} onChange={(e) => setFilter('project', (e.target as HTMLSelectElement).value, setProject)}>
          <option value="">All projects</option>
          {choices.data?.projects.map((p) => (
            <option key={p.slug} value={p.slug}>
              {p.name}
            </option>
          ))}
        </select>
        <label class="check">
          <input
            type="checkbox"
            checked={archived}
            onChange={(e) => setFilter('archived', (e.target as HTMLInputElement).checked ? '1' : '', (v) => setArchived(v === '1'))}
          />{' '}
          archived
        </label>
      </div>
      <Loading error={tree.error} loading={tree.loading && !tree.data}>
        {view && (
          <>
            {view.rows.length ? (
              <ul class="tasks">
                {view.rows.map(({ t, depth }) => (
                  <TaskRow key={t.id} t={t} depth={depth} deps={view.deps} />
                ))}
              </ul>
            ) : (
              <Empty>No tasks match these filters.</Empty>
            )}
            {view.issues.length > 0 && (
              <>
                <h2>GitHub issues</h2>
                <p class="muted small">Read-only mirror. The role is the only thing you set here.</p>
                <ul class="tasks">
                  {view.issues.map((i) => (
                    <IssueRow key={i.id} i={i} roles={choices.data?.roles ?? []} onChange={tree.reload} />
                  ))}
                </ul>
              </>
            )}
          </>
        )}
      </Loading>
    </Page>
  );
}

interface TaskFull extends TaskSummary {
  for_agent?: string | null;
  description: string;
  result: string;
  blocking_reason: string;
  claimed_by: { role?: string; connection?: string } | null;
  created_by: { role?: string; connection?: string } | null;
  depends_on: { id: string; title: string; status: string }[] | string[];
  subtasks: { id: string; title: string; status: string }[];
  created_at: string;
  comments: TaskComment[];
  comments_total: number;
  comments_cursor: string | null;
}

interface TaskComment {
  id: string;
  body: string;
  actor_kind: string;
  connection_name: string | null;
  claimed_role: string | null;
  agent?: string | null;
  created_at: string;
}

export function TaskScreen({ id }: { id: string }) {
  const isNew = id === 'new';
  const q = new URLSearchParams(location.search);
  const task = useData(() => (isNew ? Promise.resolve(null) : api<TaskFull>(`/entity/task/${enc(id)}`)), [id]);
  const choices = useChoices();
  const all = useData(() => api<Tree>('/tasks?archived=0'));
  const t = task.data;
  return (
    <Page title={isNew ? 'New task' : (t?.title ?? 'Task')} back={lastListUrl}>
      <Loading error={task.error} loading={task.loading}>
        {(isNew || t) && (
          <TaskForm
            key={t?.rev ?? 'new'}
            task={t ?? undefined}
            defaults={{ project: q.get('project') ?? '', parent_id: q.get('parent') ?? '' }}
            roles={choices.data?.roles ?? []}
            projects={choices.data?.projects ?? []}
            agents={choices.data?.agents ?? []}
            others={(all.data?.tasks ?? []).filter((x) => x.id !== id)}
            onSaved={(saved) => (isNew ? navigate(`/tasks/${enc(saved.id)}`, true) : task.reload())}
          />
        )}
        {t && <TaskExtras key={`${t.id}-${t.comments_total}`} task={t} onChange={task.reload} />}
      </Loading>
    </Page>
  );
}

function TaskForm({
  task,
  defaults,
  roles,
  projects,
  agents,
  others,
  onSaved,
}: {
  task?: TaskFull;
  defaults: { project: string; parent_id: string };
  roles: { slug: string; name: string }[];
  projects: { slug: string; name: string }[];
  agents: AgentChoice[];
  others: TaskSummary[];
  onSaved: (t: { id: string }) => void;
}) {
  const depIds = (task?.depends_on ?? []).map((d) => (typeof d === 'string' ? d : d.id));
  const [f, setF] = useState({
    title: task?.title ?? '',
    description: task?.description ?? '',
    status: task?.status ?? 'open',
    priority: task?.priority ?? 'normal',
    role: task?.role ?? '',
    for_agent: task?.for_agent ?? '',
    project: task?.project ?? defaults.project,
    parent_id: task?.parent_id ?? defaults.parent_id,
    due_date: task?.due_date ?? '',
    result: task?.result ?? '',
    blocking_reason: task?.blocking_reason ?? '',
    depends_on: depIds,
  });
  const act = useAction();
  const set = (k: keyof typeof f) => (e: Event) => setF({ ...f, [k]: (e.target as HTMLInputElement).value });
  const save = (e: Event) => {
    e.preventDefault();
    void act.run(async () => {
      const saved = await post<{ id: string }>('/tasks', {
        ...(task ? { id: task.id, rev: task.rev } : {}),
        title: f.title,
        description: f.description,
        status: f.status,
        priority: f.priority,
        role: f.role || null,
        for_agent: f.for_agent || null,
        project: f.project || null,
        parent_id: f.parent_id || null,
        due_date: f.due_date || null,
        result: f.result,
        blocking_reason: f.blocking_reason,
        depends_on: f.depends_on,
      });
      onSaved(saved);
    });
  };
  return (
    <form class="stack" onSubmit={save}>
      <Field label="Title">
        <input value={f.title} onInput={set('title')} required maxLength={300} />
      </Field>
      <Field label="Description">
        <textarea value={f.description} onInput={set('description')} rows={5} />
      </Field>
      <div class="grid2">
        <Field label="Status">
          <select value={f.status} onChange={set('status')}>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {label(s)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Priority">
          <select value={f.priority} onChange={set('priority')}>
            {PRIORITIES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Role">
          <select value={f.role} onChange={set('role')}>
            <option value="">no role</option>
            {roles.map((r) => (
              <option key={r.slug} value={r.slug}>
                {r.name}
              </option>
            ))}
          </select>
        </Field>
        {(agents.length > 0 || f.for_agent) && (
          <Field label="For agent" hint="Optional. Only agents that may take the chosen role.">
            <select value={f.for_agent} onChange={set('for_agent')}>
              <option value="">any agent with the role</option>
              {agents
                .filter((a) => a.slug === f.for_agent || (f.role && a.roles.includes(f.role)))
                .map((a) => (
                  <option key={a.slug} value={a.slug}>
                    {a.name} · {a.platform}
                  </option>
                ))}
            </select>
          </Field>
        )}
        <Field label="Project">
          <select value={f.project} onChange={set('project')}>
            <option value="">no project</option>
            {projects.map((p) => (
              <option key={p.slug} value={p.slug}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Due date">
          <input type="date" value={f.due_date} onInput={set('due_date')} />
        </Field>
        <Field label="Parent task">
          <select value={f.parent_id} onChange={set('parent_id')}>
            <option value="">none</option>
            {others.map((o) => (
              <option key={o.id} value={o.id}>
                {o.title}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {f.status === 'blocked' && (
        <Field label="Why it is blocked">
          <input value={f.blocking_reason} onInput={set('blocking_reason')} />
        </Field>
      )}
      <Field label="Depends on" hint="Tasks that must be finished first.">
        <select
          multiple
          size={Math.min(6, Math.max(3, others.length))}
          value={f.depends_on as unknown as string}
          onChange={(e) => setF({ ...f, depends_on: [...(e.target as HTMLSelectElement).selectedOptions].map((o) => o.value) })}
        >
          {others.map((o) => (
            <option key={o.id} value={o.id} selected={f.depends_on.includes(o.id)}>
              {o.title}
            </option>
          ))}
        </select>
      </Field>
      {(task || f.status === 'done') && (
        <Field label="Result">
          <textarea value={f.result} onInput={set('result')} rows={3} />
        </Field>
      )}
      {act.error && <Alert>{act.error}</Alert>}
      <div class="row">
        <Button kind="primary" type="submit" busy={act.busy}>
          {task ? 'Save' : 'Create task'}
        </Button>
      </div>
    </form>
  );
}

function TaskExtras({ task, onChange }: { task: TaskFull; onChange: () => void }) {
  const [comment, setComment] = useState('');
  const act = useAction();
  const older = useAction();
  const [earlier, setEarlier] = useState<TaskComment[]>([]);
  const [cursor, setCursor] = useState<string | null>(task.comments_cursor);
  return (
    <>
      <Card>
        <dl class="facts small">
          <dt>Created</dt>
          <dd>
            <Time at={task.created_at} />
            {task.created_by?.role ? ` by @${task.created_by.role}` : ''}
          </dd>
          <dt>Updated</dt>
          <dd>
            <Time at={task.updated_at} />
          </dd>
          {task.claimed_by && (
            <>
              <dt>Claimed by</dt>
              <dd>{task.claimed_by.role ? `@${task.claimed_by.role}` : (task.claimed_by.connection ?? 'someone')}</dd>
            </>
          )}
        </dl>
        {task.subtasks.length > 0 && (
          <>
            <h3>Subtasks</h3>
            <ul class="plain">
              {task.subtasks.map((s) => (
                <li key={s.id}>
                  <a href={`/tasks/${enc(s.id)}`}>{s.title}</a> <Badge tone={STATUS_TONE[s.status]}>{label(s.status)}</Badge>
                </li>
              ))}
            </ul>
          </>
        )}
        <div class="row">
          <a class="btn btn-default" href={`/tasks/new?parent=${enc(task.id)}${task.project ? `&project=${enc(task.project)}` : ''}`}>
            Add subtask
          </a>
          <a class="btn btn-quiet" href={`/log?entity_type=task&entity_id=${enc(task.id)}`}>
            History
          </a>
          <ArchiveControls type="task" id={task.id} archived={task.archived} onDone={onChange} onDeleted={() => navigate(lastListUrl)} />
        </div>
      </Card>
      <h2>Comments</h2>
      {task.comments.length === 0 && <Empty>No comments yet.</Empty>}
      {cursor && (
        <Button
          kind="quiet"
          busy={older.busy}
          onClick={() =>
            void older.run(async () => {
              const page = await api<TaskFull>(`/entity/task/${enc(task.id)}?cursor=${enc(cursor)}`);
              setEarlier([...page.comments, ...earlier]);
              setCursor(page.comments_cursor);
            })
          }
        >
          Show older comments ({task.comments_total - task.comments.length - earlier.length})
        </Button>
      )}
      {older.error && <Alert>{older.error}</Alert>}
      <ul class="comments">
        {[...earlier, ...task.comments].map((c) => (
          <li key={c.id}>
            <div class="small muted">
              {c.actor_kind === 'owner' ? 'You' : (c.connection_name ?? 'agent')}
              {c.agent ? `: ${c.agent}` : ''}
              {c.claimed_role ? ` as @${c.claimed_role}` : ''} · <Time at={c.created_at} />
            </div>
            <pre class="prose">{c.body}</pre>
          </li>
        ))}
      </ul>
      <form
        class="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void act.run(() => post(`/tasks/${enc(task.id)}/comment`, { body: comment })).then((r) => {
            if (r) {
              setComment('');
              onChange();
            }
          });
        }}
      >
        <Field label="Add a comment">
          <textarea value={comment} rows={3} onInput={(e) => setComment((e.target as HTMLTextAreaElement).value)} />
        </Field>
        {act.error && <Alert>{act.error}</Alert>}
        <Button type="submit" busy={act.busy} disabled={!comment.trim()}>
          Comment
        </Button>
      </form>
    </>
  );
}
