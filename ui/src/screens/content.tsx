import { useEffect, useState } from 'preact/hooks';
import { api, enc, post, searchAll } from '../api.ts';
import { navigate } from '../router.ts';
import { Alert, ArchiveControls, Badge, Button, Card, Diff, Empty, Field, label, Loading, Page, Prose, STATUS_TONE, Time, useAction, useData, type DiffLine } from '../ui.tsx';

type VType = 'rules' | 'role' | 'project' | 'document';
const histHref = (type: VType, id?: string) => `/history/${type}${id ? `/${enc(id)}` : ''}`;

// ---------------------------------------------------------------- rules

export function RulesScreen() {
  const rules = useData(() => api<{ text: string; rev: number; version: number; updated_at: string | null }>('/entity/rules'));
  const [text, setText] = useState<string | null>(null);
  const act = useAction();
  const r = rules.data;
  const save = (e: Event) => {
    e.preventDefault();
    void act.run(async () => {
      await post('/rules', { text, rev: r?.rev });
      setText(null);
      await rules.reload();
    });
  };
  return (
    <Page title="Working rules" actions={<><a href="/read/rules">Read</a>{r && r.version > 0 ? <a href={histHref('rules')}>History</a> : null}</>}>
      <p class="muted">
        Shared by every role on every platform. Agents receive them in the <code>instructions</code> of <code>start</code>. Changes here are versioned.
      </p>
      <Loading error={rules.error} loading={rules.loading}>
        {r && (
          <form class="stack" onSubmit={save}>
            <Field label={`Rules${r.version ? ` · version ${r.version}` : ''}`}>
              <textarea class="tall" value={text ?? r.text} onInput={(e) => setText((e.target as HTMLTextAreaElement).value)} rows={14} />
            </Field>
            {act.error && <Alert>{act.error}</Alert>}
            <div class="row">
              <Button kind="primary" type="submit" busy={act.busy} disabled={text === null || text === r.text}>
                Save new version
              </Button>
              {text !== null && (
                <Button kind="quiet" onClick={() => setText(null)}>
                  Discard
                </Button>
              )}
            </div>
          </form>
        )}
      </Loading>
    </Page>
  );
}

// ---------------------------------------------------------------- roles

interface RoleFull {
  id: string;
  slug: string;
  name: string;
  area: string;
  setup_notes: string;
  instruction: string;
  instruction_version: number;
  links: { id: string; from: string; to: string; type: string }[];
  rev: number;
  archived: boolean;
  updated_at: string;
}

export function RolesScreen() {
  const [archived, setArchived] = useState(false);
  const list = useData(() => searchAll<{ id: string; title: string; snippet: string; updated_at: string; archived?: boolean }>(`/search?type=role${archived ? '&archived=1' : ''}`), [archived]);
  return (
    <Page
      title="Roles"
      actions={
        <Button kind="primary" onClick={() => navigate('/roles/new')}>
          New role
        </Button>
      }
    >
      <label class="check">
        <input type="checkbox" checked={archived} onChange={(e) => setArchived((e.target as HTMLInputElement).checked)} /> include archived
      </label>
      <Loading error={list.error} loading={list.loading}>
        {list.data && !list.data.results.length && <Empty>No roles yet.</Empty>}
        <ul class="list">
          {list.data?.results.map((r) => (
            <li key={r.id}>
              <a href={`/roles/${enc(r.id)}`}>
                <strong>{r.title}</strong>
                {r.snippet && <span class="muted small">{r.snippet.slice(0, 140)}</span>}
              </a>
            </li>
          ))}
        </ul>
      </Loading>
    </Page>
  );
}

export function RoleScreen({ id }: { id: string }) {
  const isNew = id === 'new';
  const role = useData(() => (isNew ? Promise.resolve(null) : api<RoleFull>(`/entity/role/${enc(id)}`)), [id]);
  const choices = useData(() => api<{ roles: { slug: string; name: string }[] }>('/choices'));
  const r = role.data;
  return (
    <Page title={isNew ? 'New role' : (r?.name ?? 'Role')} back="/roles" actions={r ? <><a href={`/read/role/${enc(r.id)}`}>Read</a><a href={histHref('role', r.id)}>History</a></> : undefined}>
      <Loading error={role.error} loading={role.loading}>
        {(isNew || r) && (
          <RoleForm
            key={r?.rev ?? 'new'}
            role={r ?? undefined}
            others={(choices.data?.roles ?? []).filter((x) => x.slug !== r?.slug)}
            onSaved={(saved) => (isNew ? navigate(`/roles/${enc(saved.id)}`, true) : role.reload())}
          />
        )}
        {r && (
          <div class="row">
            <a class="btn btn-default" href={`/tasks?role=${enc(r.slug)}`}>
              Tasks of this role
            </a>
            <ArchiveControls type="role" id={r.id} archived={r.archived} onDone={role.reload} onDeleted={() => navigate('/roles')} />
          </div>
        )}
      </Loading>
    </Page>
  );
}

const LINK_TYPES = ['delegates_to', 'reports_to', 'reviews', 'works_with'];

function RoleForm({ role, others, onSaved }: { role?: RoleFull; others: { slug: string; name: string }[]; onSaved: (r: { id: string }) => void }) {
  const [f, setF] = useState({
    name: role?.name ?? '',
    slug: role?.slug ?? '',
    area: role?.area ?? '',
    instruction: role?.instruction ?? '',
    setup_notes: role?.setup_notes ?? '',
    links: (role?.links ?? []).filter((l) => l.from === role?.slug).map((l) => ({ to: l.to, type: l.type })),
  });
  const act = useAction();
  const set = (k: 'name' | 'slug' | 'area' | 'instruction' | 'setup_notes') => (e: Event) => setF({ ...f, [k]: (e.target as HTMLInputElement).value });
  const save = (e: Event) => {
    e.preventDefault();
    void act.run(async () => {
      const body: Record<string, unknown> = role
        ? { id: role.id, rev: role.rev, name: f.name, area: f.area, instruction: f.instruction, setup_notes: f.setup_notes, links: f.links.filter((l) => l.to) }
        : { name: f.name, slug: f.slug || undefined, area: f.area, instruction: f.instruction, setup_notes: f.setup_notes, links: f.links.filter((l) => l.to) };
      onSaved(await post<{ id: string }>('/roles', body));
    });
  };
  const instructionChanged = role && f.instruction !== role.instruction;
  return (
    <form class="stack" onSubmit={save}>
      <div class="grid2">
        <Field label="Name">
          <input value={f.name} onInput={set('name')} required maxLength={100} />
        </Field>
        <Field label="Short id" hint={role ? 'Fixed after creation.' : 'Optional; made from the name.'}>
          <input value={f.slug} onInput={set('slug')} disabled={!!role} pattern="[a-z0-9][a-z0-9-]*" maxLength={50} />
        </Field>
      </div>
      <Field label="Area of responsibility">
        <input value={f.area} onInput={set('area')} maxLength={500} />
      </Field>
      <Field label={`Instruction${role?.instruction_version ? ` · version ${role.instruction_version}` : ''}`} hint="What an agent in this role does. Sent in the instructions of start; versioned.">
        <textarea class="tall" value={f.instruction} onInput={set('instruction')} rows={10} />
      </Field>
      {instructionChanged && <Alert kind="warn">Saving changes the behaviour of every later session in this role.</Alert>}
      <Field label="Setup notes" hint="What to recreate on a new platform (for example a scheduled routine). Data, not an instruction.">
        <textarea value={f.setup_notes} onInput={set('setup_notes')} rows={3} />
      </Field>
      <fieldset class="links">
        <legend>Links to other roles</legend>
        {f.links.map((l, i) => (
          <div class="row" key={i}>
            <select aria-label="Link type" value={l.type} onChange={(e) => setF({ ...f, links: f.links.map((x, j) => (j === i ? { ...x, type: (e.target as HTMLSelectElement).value } : x)) })}>
              {LINK_TYPES.map((t) => (
                <option key={t} value={t}>
                  {label(t)}
                </option>
              ))}
            </select>
            <select aria-label="Role" value={l.to} onChange={(e) => setF({ ...f, links: f.links.map((x, j) => (j === i ? { ...x, to: (e.target as HTMLSelectElement).value } : x)) })}>
              <option value="">choose a role</option>
              {others.map((o) => (
                <option key={o.slug} value={o.slug}>
                  {o.name}
                </option>
              ))}
            </select>
            <Button kind="quiet" onClick={() => setF({ ...f, links: f.links.filter((_, j) => j !== i) })} aria-label="Remove link">
              ×
            </Button>
          </div>
        ))}
        <Button kind="quiet" onClick={() => setF({ ...f, links: [...f.links, { to: '', type: 'delegates_to' }] })} disabled={!others.length}>
          Add a link
        </Button>
      </fieldset>
      {act.error && <Alert>{act.error}</Alert>}
      <Button kind="primary" type="submit" busy={act.busy}>
        {role ? 'Save' : 'Create role'}
      </Button>
    </form>
  );
}


// ---------------------------------------------------------------- projects and documents

interface ProjectFull {
  id: string;
  slug: string;
  name: string;
  focus: string;
  state: string;
  repos: string[];
  description: string;
  description_version: number;
  rev: number;
  archived: boolean;
  updated_at: string;
  open_tasks: { id: string; title: string; status: string; role: string | null }[];
  documents: { id: string; title: string; kind: string; version: number; updated_at: string }[];
}

export function ProjectsScreen() {
  const [archived, setArchived] = useState(false);
  const list = useData(() => searchAll<{ id: string; title: string; snippet: string; updated_at: string }>(`/search?type=project${archived ? '&archived=1' : ''}`), [archived]);
  const docs = useData(() => searchAll<{ id: string; title: string; snippet: string; updated_at: string }>('/search?type=document'));
  return (
    <Page
      title="Projects and documents"
      actions={
        <Button kind="primary" onClick={() => navigate('/projects/new')}>
          New project
        </Button>
      }
    >
      <label class="check">
        <input type="checkbox" checked={archived} onChange={(e) => setArchived((e.target as HTMLInputElement).checked)} /> include archived
      </label>
      <Loading error={list.error} loading={list.loading}>
        {list.data && !list.data.results.length && <Empty>No projects yet.</Empty>}
        <ul class="list">
          {list.data?.results.map((p) => (
            <li key={p.id}>
              <a href={`/projects/${enc(p.id)}`}>
                <strong>{p.title}</strong>
                {p.snippet && <span class="muted small">{p.snippet.slice(0, 140)}</span>}
              </a>
            </li>
          ))}
        </ul>
      </Loading>
      <div class="section-head">
        <h2>All documents</h2>
        <a class="btn btn-default" href="/documents/new">
          New document
        </a>
      </div>
      <Loading error={docs.error} loading={docs.loading}>
        {docs.data && !docs.data.results.length && <Empty>No documents yet.</Empty>}
        <ul class="list">
          {docs.data?.results.map((d) => (
            <li key={d.id}>
              <a href={`/documents/${enc(d.id)}`}>
                <strong>{d.title}</strong>
                <span class="muted small">
                  updated <Time at={d.updated_at} />
                </span>
              </a>
            </li>
          ))}
        </ul>
      </Loading>
    </Page>
  );
}

export function ProjectScreen({ id }: { id: string }) {
  const isNew = id === 'new';
  const project = useData(() => (isNew ? Promise.resolve(null) : api<ProjectFull>(`/entity/project/${enc(id)}`)), [id]);
  const p = project.data;
  return (
    <Page title={isNew ? 'New project' : (p?.name ?? 'Project')} back="/projects" actions={p ? <><a href={`/read/project/${enc(p.id)}`}>Read</a><a href={histHref('project', p.id)}>History</a></> : undefined}>
      <Loading error={project.error} loading={project.loading}>
        {(isNew || p) && <ProjectForm key={p?.rev ?? 'new'} project={p ?? undefined} onSaved={(s) => (isNew ? navigate(`/projects/${enc(s.id)}`, true) : project.reload())} />}
        {p && (
          <>
            <div class="section-head">
              <h2>Open tasks</h2>
              <a class="btn btn-default" href={`/tasks/new?project=${enc(p.slug)}`}>
                New task
              </a>
            </div>
            {p.open_tasks.length ? (
              <ul class="list">
                {p.open_tasks.map((t) => (
                  <li key={t.id}>
                    <a href={`/tasks/${enc(t.id)}`}>
                      <strong>{t.title}</strong>
                      <span class="small">
                        <Badge tone={STATUS_TONE[t.status]}>{label(t.status)}</Badge> {t.role ? `@${t.role}` : ''}
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty>No open tasks.</Empty>
            )}
            <div class="section-head">
              <h2>Documents</h2>
              <a class="btn btn-default" href={`/documents/new?project=${enc(p.slug)}`}>
                New document
              </a>
            </div>
            {p.documents.length ? (
              <ul class="list">
                {p.documents.map((d) => (
                  <li key={d.id}>
                    <a href={`/documents/${enc(d.id)}`}>
                      <strong>{d.title}</strong>
                      <span class="muted small">
                        {d.kind} · v{d.version} · <Time at={d.updated_at} />
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty>No documents.</Empty>
            )}
            <div class="row">
              <ArchiveControls type="project" id={p.id} archived={p.archived} onDone={project.reload} onDeleted={() => navigate('/projects')} />
            </div>
          </>
        )}
      </Loading>
    </Page>
  );
}

function ProjectForm({ project, onSaved }: { project?: ProjectFull; onSaved: (p: { id: string }) => void }) {
  const [f, setF] = useState({
    name: project?.name ?? '',
    slug: project?.slug ?? '',
    focus: project?.focus ?? '',
    state: project?.state ?? '',
    description: project?.description ?? '',
    repos: (project?.repos ?? []).join('\n'),
  });
  const act = useAction();
  const set = (k: keyof typeof f) => (e: Event) => setF({ ...f, [k]: (e.target as HTMLInputElement).value });
  const save = (e: Event) => {
    e.preventDefault();
    void act.run(async () => {
      const repos = f.repos
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      const common = { name: f.name, focus: f.focus, state: f.state, description: f.description, repos };
      onSaved(await post<{ id: string }>('/projects', project ? { id: project.id, rev: project.rev, ...common } : { ...common, slug: f.slug || undefined }));
    });
  };
  return (
    <form class="stack" onSubmit={save}>
      <div class="grid2">
        <Field label="Name">
          <input value={f.name} onInput={set('name')} required maxLength={200} />
        </Field>
        <Field label="Short id" hint={project ? 'Fixed after creation.' : 'Optional; made from the name.'}>
          <input value={f.slug} onInput={set('slug')} disabled={!!project} pattern="[a-z0-9][a-z0-9-]*" maxLength={50} />
        </Field>
      </div>
      <Field label="Current focus">
        <input value={f.focus} onInput={set('focus')} maxLength={1000} />
      </Field>
      <Field label="State" hint="Where the project stands right now.">
        <textarea value={f.state} onInput={set('state')} rows={3} />
      </Field>
      <Field label={`Description${project?.description_version ? ` · version ${project.description_version}` : ''}`}>
        <textarea value={f.description} onInput={set('description')} rows={6} />
      </Field>
      <Field label="Repositories" hint="One owner/name per line. Links only; GitHub issues come from the GitHub screen.">
        <textarea value={f.repos} onInput={set('repos')} rows={2} />
      </Field>
      {act.error && <Alert>{act.error}</Alert>}
      <Button kind="primary" type="submit" busy={act.busy}>
        {project ? 'Save' : 'Create project'}
      </Button>
    </form>
  );
}

interface DocFull {
  id: string;
  title: string;
  kind: string;
  body: string;
  attached_to: { type: 'workspace' | 'project' | 'role'; id?: string; slug?: string };
  version: number;
  rev: number;
  archived: boolean;
  updated_at: string;
}

const DOC_KINDS = ['note', 'decision', 'spec', 'guide', 'reference', 'log'];

export function DocumentScreen({ id }: { id: string }) {
  const isNew = id === 'new';
  const q = new URLSearchParams(location.search);
  const doc = useData(() => (isNew ? Promise.resolve(null) : api<DocFull>(`/entity/document/${enc(id)}`)), [id]);
  const choices = useData(() => api<{ roles: { slug: string; name: string }[]; projects: { slug: string; name: string }[] }>('/choices'));
  const [editing, setEditing] = useState(isNew);
  const d = doc.data;
  const back = d?.attached_to.type === 'project' && d.attached_to.id ? `/projects/${enc(d.attached_to.id)}` : '/projects';
  return (
    <Page
      title={isNew ? 'New document' : (d?.title ?? 'Document')}
      back={back}
      actions={
        d && (
          <>
            <a href={`/read/document/${enc(d.id)}`}>Read</a>
            <a href={histHref('document', d.id)}>History</a>
            {!editing && <Button onClick={() => setEditing(true)}>Edit</Button>}
          </>
        )
      }
    >
      <Loading error={doc.error} loading={doc.loading}>
        {d && !editing && (
          <>
            <p class="muted small">
              {d.kind} · version {d.version} · updated <Time at={d.updated_at} />
              {d.attached_to.type !== 'workspace' ? ` · ${d.attached_to.type} ${d.attached_to.slug ?? ''}` : ' · workspace'}
              {d.archived ? ' · archived' : ''}
            </p>
            <Prose text={d.body} />
            <div class="row">
              <ArchiveControls type="document" id={d.id} archived={d.archived} onDone={doc.reload} onDeleted={() => navigate('/projects')} />
            </div>
          </>
        )}
        {(isNew || (d && editing)) && (
          <DocForm
            key={d?.rev ?? 'new'}
            doc={d ?? undefined}
            defaultProject={q.get('project') ?? ''}
            choices={choices.data ?? { roles: [], projects: [] }}
            onCancel={d ? () => setEditing(false) : undefined}
            onSaved={(s) => {
              setEditing(false);
              if (isNew) navigate(`/documents/${enc(s.id)}`, true);
              else void doc.reload();
            }}
          />
        )}
      </Loading>
    </Page>
  );
}

function DocForm({
  doc,
  defaultProject,
  choices,
  onSaved,
  onCancel,
}: {
  doc?: DocFull;
  defaultProject: string;
  choices: { roles: { slug: string; name: string }[]; projects: { slug: string; name: string }[] };
  onSaved: (d: { id: string }) => void;
  onCancel?: () => void;
}) {
  const initialScope = doc ? (doc.attached_to.type === 'workspace' ? 'workspace' : `${doc.attached_to.type}:${doc.attached_to.slug ?? doc.attached_to.id}`) : defaultProject ? `project:${defaultProject}` : 'workspace';
  const [f, setF] = useState({ title: doc?.title ?? '', kind: doc?.kind ?? 'note', body: doc?.body ?? '', scope: initialScope, note: '' });
  const act = useAction();
  const set = (k: keyof typeof f) => (e: Event) => setF({ ...f, [k]: (e.target as HTMLInputElement).value });
  const save = (e: Event) => {
    e.preventDefault();
    void act.run(async () => {
      const [type, sid] = f.scope.split(':');
      const attach_to = type === 'workspace' ? { type: 'workspace' } : { type, id: sid };
      onSaved(await post<{ id: string }>('/documents', { ...(doc ? { id: doc.id, rev: doc.rev } : {}), title: f.title, kind: f.kind, body: f.body, attach_to, note: f.note || undefined }));
    });
  };
  return (
    <form class="stack" onSubmit={save}>
      <Field label="Title">
        <input value={f.title} onInput={set('title')} required maxLength={300} />
      </Field>
      <div class="grid2">
        <Field label="Kind">
          <select value={f.kind} onChange={set('kind')}>
            {[...new Set([...DOC_KINDS, f.kind])].map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Belongs to">
          <select value={f.scope} onChange={set('scope')}>
            <option value="workspace">the whole workspace</option>
            {choices.projects.map((p) => (
              <option key={p.slug} value={`project:${p.slug}`}>
                project {p.name}
              </option>
            ))}
            {choices.roles.map((r) => (
              <option key={r.slug} value={`role:${r.slug}`}>
                role {r.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="Text" hint="Plain text or Markdown. Shown as text, never as HTML.">
        <textarea class="tall mono" value={f.body} onInput={set('body')} rows={16} />
      </Field>
      {doc && (
        <Field label="Note for this version" hint="Optional: why you changed it.">
          <input value={f.note} onInput={set('note')} maxLength={500} />
        </Field>
      )}
      {act.error && <Alert>{act.error}</Alert>}
      <div class="row">
        <Button kind="primary" type="submit" busy={act.busy}>
          {doc ? 'Save new version' : 'Create document'}
        </Button>
        {onCancel && (
          <Button kind="quiet" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- versions

interface VersionInfo {
  number: number;
  author: { connection: string | null; role: string | null; owner?: boolean } | null;
  note: string | null;
  rollback_of: number | null;
  created_at: string;
}

export function HistoryScreen({ type, id }: { type: VType; id?: string }) {
  const versions = useData(() => api<{ versions: VersionInfo[] }>(`/versions/${type}${id ? `/${enc(id)}` : ''}`), [type, id]);
  const list = versions.data?.versions ?? [];
  const latest = list[0]?.number ?? 0;
  const [from, setFrom] = useState(0);
  const [to, setTo] = useState(0);
  const [view, setView] = useState<number | null>(null);
  useEffect(() => {
    if (latest) {
      setTo(latest);
      setFrom(Math.max(0, latest - 1));
    }
  }, [latest]);
  const cmp = useData(
    () => (to ? api<{ added: number; removed: number; diff: DiffLine[] }>(`/compare/${type}${id ? `/${enc(id)}` : ''}?from=${from}&to=${to}`) : Promise.resolve(null)),
    [type, id, from, to],
  );
  const body = useData(() => (view ? api<{ body: string; number: number }>(`/version/${type}${id ? `/${enc(id)}` : ''}?number=${view}`) : Promise.resolve(null)), [type, id, view]);
  const act = useAction();
  const entity = useData(() => api<{ rev: number; name?: string; title?: string }>(`/entity/${type}${id ? `/${enc(id)}` : ''}`), [type, id, latest]);
  const rollbackTo = (n: number) => {
    if (!confirm(`Restore the text of version ${n}? This adds a new version; nothing is deleted.`)) return;
    void act.run(async () => {
      await post('/rollback', { type, id, to_version: n, rev: entity.data?.rev });
      await versions.reload();
    });
  };
  const back = type === 'rules' ? (id ? `/read/rules/${enc(id)}` : '/rules') : type === 'role' ? `/roles/${enc(id!)}` : type === 'project' ? `/projects/${enc(id!)}` : `/documents/${enc(id!)}`;
  const name = type === 'rules' ? 'Working rules' : (entity.data?.name ?? entity.data?.title ?? type);
  const who = (v: VersionInfo) => (v.author?.connection ? `${v.author.connection}${v.author.role ? ` as @${v.author.role}` : ''}` : 'you');
  return (
    <Page title={`History: ${name}`} back={back}>
      <Loading error={versions.error} loading={versions.loading}>
        {!list.length && <Empty>No versions yet.</Empty>}
        {list.length > 0 && (
          <>
            <div class="filters">
              <label>
                Compare{' '}
                <select value={from} onChange={(e) => setFrom(Number((e.target as HTMLSelectElement).value))} aria-label="From version">
                  <option value={0}>empty</option>
                  {list.map((v) => (
                    <option key={v.number} value={v.number}>
                      v{v.number}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                with{' '}
                <select value={to} onChange={(e) => setTo(Number((e.target as HTMLSelectElement).value))} aria-label="To version">
                  {list.map((v) => (
                    <option key={v.number} value={v.number}>
                      v{v.number}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <Loading error={cmp.error} loading={cmp.loading && !cmp.data}>
              {cmp.data && (
                <>
                  <p class="small muted">
                    +{cmp.data.added} −{cmp.data.removed} lines
                  </p>
                  <Diff lines={cmp.data.diff} />
                </>
              )}
            </Loading>
            {act.error && <Alert>{act.error}</Alert>}
            <h2>Versions</h2>
            <ul class="list versions">
              {list.map((v) => (
                <li key={v.number}>
                  <div class="version-row">
                    <div>
                      <strong>v{v.number}</strong> {v.number === latest && <Badge tone="accent">current</Badge>} {v.rollback_of ? <Badge>restored v{v.rollback_of}</Badge> : null}
                      <div class="small muted">
                        {who(v)} · <Time at={v.created_at} />
                        {v.note ? ` · ${v.note}` : ''}
                      </div>
                    </div>
                    <div class="row">
                      <Button kind="quiet" onClick={() => setView(view === v.number ? null : v.number)}>
                        {view === v.number ? 'Hide' : 'View'}
                      </Button>
                      {v.number !== latest && (
                        <Button kind="default" onClick={() => rollbackTo(v.number)} busy={act.busy}>
                          Restore
                        </Button>
                      )}
                    </div>
                  </div>
                  {view === v.number && body.data && <Prose text={body.data.body} />}
                </li>
              ))}
            </ul>
          </>
        )}
      </Loading>
    </Page>
  );
}

// ---------------------------------------------------------------- changes since the last visit

interface ChangeItem {
  id: number;
  at: string;
  by: string;
  claimed_role?: string | null;
  owner_role?: string | null;
  whose?: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  summary: string;
  critical: boolean;
  versioned: { type: VType; id: string | null; version: number } | null;
  diff: { from: number; to: number; added: number; removed: number; lines: DiffLine[]; truncated: boolean } | null;
}
interface Feed {
  last_review_event_id: number;
  latest_event_id: number;
  review_up_to: number;
  has_more: boolean;
  items: ChangeItem[];
}

export function entityHref(type: string, id: string | null): string | null {
  if (!id) return type === 'rules' ? '/rules' : null;
  switch (type) {
    case 'role':
      return `/roles/${enc(id)}`;
    case 'project':
      return `/projects/${enc(id)}`;
    case 'document':
      return `/documents/${enc(id)}`;
    case 'task':
      return `/tasks/${enc(id)}`;
    case 'rules':
      return '/rules';
    case 'connection':
      return '/connections';
    case 'webhook':
      return '/webhooks';
    case 'github':
      return '/github';
    default:
      return null;
  }
}

export function ChangesScreen({ onReviewed }: { onReviewed?: () => void }) {
  const feed = useData(() => api<Feed>('/changes'));
  const act = useAction();
  const f = feed.data;
  const markReviewed = () =>
    act.run(async () => {
      await post('/changes/reviewed', { up_to: f!.review_up_to });
      await feed.reload();
      onReviewed?.();
    });
  const undo = (c: ChangeItem) => {
    if (!c.versioned || !c.diff) return;
    const target = c.diff.from;
    if (!confirm(target === 0 ? 'This was the first version; restoring is not possible. Archive the item instead.' : `Restore version ${target}? A new version is added; history stays.`)) return;
    if (target === 0) return;
    void act.run(async () => {
      const ent = await api<{ rev: number }>(`/entity/${c.versioned!.type}${c.versioned!.id ? `/${enc(c.versioned!.id)}` : ''}`);
      await post('/rollback', { type: c.versioned!.type, id: c.versioned!.id ?? undefined, to_version: target, rev: ent.rev });
      await feed.reload();
    });
  };
  const critical = f?.items.filter((i) => i.critical) ?? [];
  const other = f?.items.filter((i) => !i.critical) ?? [];
  const Item = ({ c }: { c: ChangeItem }) => {
    const href = entityHref(c.entity_type, c.entity_id);
    return (
      <li class={`change ${c.critical ? 'critical' : ''}`}>
        <div class="change-head">
          <span>{href ? <a href={href}>{c.summary}</a> : c.summary}</span>
          <span class="small muted">
            {c.by}
            {c.whose ? ` · ${c.whose}` : ''} · <Time at={c.at} />
          </span>
        </div>
        {c.diff && (
          <>
            <Diff lines={c.diff.lines} truncated={c.diff.truncated} />
            <div class="row">
              {c.diff.from > 0 && (
                <Button kind="default" onClick={() => undo(c)} busy={act.busy}>
                  Roll back to v{c.diff.from}
                </Button>
              )}
              {c.versioned && (
                <a class="btn btn-quiet" href={histHref(c.versioned.type, c.versioned.id ?? undefined)}>
                  History
                </a>
              )}
            </div>
          </>
        )}
      </li>
    );
  };
  return (
    <Page
      title="Changes"
      actions={
        f && f.items.length > 0 ? (
          <Button kind="primary" onClick={markReviewed} busy={act.busy}>
            {f.has_more ? 'Mark these reviewed' : 'Mark all reviewed'}
          </Button>
        ) : undefined
      }
    >
      <p class="muted">What agents changed since you last marked changes as reviewed. Edits to working rules and role instructions come first.</p>
      {act.error && <Alert>{act.error}</Alert>}
      <Loading error={feed.error} loading={feed.loading}>
        {f && !f.items.length && <Empty>Nothing new since your last review.</Empty>}
        {critical.length > 0 && (
          <>
            <h2>Rules and role instructions</h2>
            <ul class="changes">
              {critical.map((c) => (
                <Item key={c.id} c={c} />
              ))}
            </ul>
          </>
        )}
        {other.length > 0 && (
          <>
            <h2>Everything else</h2>
            <ul class="changes">
              {other.map((c) => (
                <Item key={c.id} c={c} />
              ))}
            </ul>
          </>
        )}
        {f?.has_more && <p class="muted small">These are the oldest unreviewed changes. Mark them reviewed to see the next ones, or open the log.</p>}
      </Loading>
    </Page>
  );
}

export function Notice({ children }: { children: preact.ComponentChildren }) {
  return <Card class="notice">{children}</Card>;
}
