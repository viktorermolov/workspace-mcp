import { useState } from 'preact/hooks';
import { api, enc, searchAll } from '../api.ts';
import { Markdown } from '../markdown.ts';
import { navigate, useLocation } from '../router.ts';
import { Alert, Badge, Button, Diff, Empty, Loading, Page, Time, useData, type DiffLine } from '../ui.tsx';

type Kind = 'rules' | 'role' | 'project' | 'document';

interface RulesSet {
  id: string;
  slug: string;
  title: string;
  project: string | null;
  project_id: string | null;
  project_archived: boolean;
  is_default: boolean;
  version: number;
  updated_at: string;
}

interface RulesFull {
  id: string;
  slug: string;
  title: string;
  project: string | null;
  is_default: boolean;
  text: string;
  rev: number;
  version: number;
  updated_at: string | null;
  sets?: RulesSet[];
  archived?: boolean;
}

interface RoleFull {
  id: string;
  slug: string;
  name: string;
  area: string;
  setup_notes: string;
  instruction: string;
  instruction_version: number;
  archived: boolean;
  updated_at: string;
}

interface ProjectFull {
  id: string;
  slug: string;
  name: string;
  focus: string;
  state: string;
  description: string;
  description_version: number;
  archived: boolean;
  updated_at: string;
}

interface DocFull {
  id: string;
  title: string;
  kind: string;
  body: string;
  version: number;
  archived: boolean;
  updated_at: string;
  attached_to: { type: string; id?: string; slug?: string };
}

interface VersionInfo {
  number: number;
  author: { connection: string | null; role: string | null; owner?: boolean } | string | null;
  note: string | null;
  rollback_of: number | null;
  created_at: string;
}

interface SearchHit {
  id: string;
  title: string;
  snippet?: string;
  updated_at?: string;
  archived?: boolean;
}

const who = (v: VersionInfo) =>
  typeof v.author === 'string' ? (v.author === 'owner' ? 'you' : v.author) : v.author?.connection ? `${v.author.connection}${v.author.role ? ` as @${v.author.role}` : ''}` : 'you';

function entityPath(type: Kind, id?: string): string {
  if (type === 'rules') return `/entity/rules${id ? `/${enc(id)}` : ''}`;
  return `/entity/${type}/${enc(id!)}`;
}

function versionsPath(type: Kind, id?: string): string {
  return `/versions/${type}${id ? `/${enc(id)}` : ''}`;
}

function versionPath(type: Kind, id: string | undefined, n: number): string {
  return `/version/${type}${id ? `/${enc(id)}` : ''}?number=${n}`;
}

function comparePath(type: Kind, id: string | undefined, from: number, to: number): string {
  return `/compare/${type}${id ? `/${enc(id)}` : ''}?from=${from}&to=${to}`;
}

function readHref(type: Kind, id?: string, query?: string): string {
  const base = type === 'rules' ? (id ? `/read/rules/${enc(id)}` : '/read/rules') : `/read/${type}/${enc(id!)}`;
  return query ? `${base}?${query}` : base;
}

function editHref(type: Kind, id?: string, isDefault?: boolean): string | null {
  if (type === 'rules') return !id || isDefault ? '/rules' : null;
  if (type === 'role') return `/roles/${enc(id!)}`;
  if (type === 'project') return `/projects/${enc(id!)}`;
  return `/documents/${enc(id!)}`;
}

function historyHref(type: Kind, id?: string): string {
  return type === 'rules' && !id ? '/history/rules' : `/history/${type}/${enc(id!)}`;
}

export function ReadIndex() {
  const { query } = useLocation();
  const archived = query.get('archived') === '1';
  const q = archived ? '&archived=1' : '';
  const rules = useData(() => api<RulesFull>('/entity/rules'), []);
  const roles = useData(() => searchAll<SearchHit>(`/search?type=role${q}`), [archived]);
  const projects = useData(() => searchAll<SearchHit>(`/search?type=project${q}`), [archived]);
  const docs = useData(() => searchAll<SearchHit>(`/search?type=document${q}`), [archived]);
  const sets = rules.data?.sets ?? [];
  const def = sets.filter((s) => s.is_default);
  const workspace = sets.filter((s) => !s.is_default && !s.project);
  const byProject = new Map<string, RulesSet[]>();
  for (const s of sets) {
    if (!s.project || (!archived && s.project_archived)) continue;
    const list = byProject.get(s.project) ?? [];
    list.push(s);
    byProject.set(s.project, list);
  }
  const toggleArchived = (on: boolean) => navigate(on ? '/read?archived=1' : '/read');
  return (
    <Page title="Reading">
      <p class="muted">Rendered working rules, role instructions, project descriptions and documents. Only you can open these pages.</p>
      <label class="check">
        <input type="checkbox" checked={archived} onChange={(e) => toggleArchived((e.target as HTMLInputElement).checked)} /> include archived
      </label>
      <Loading error={rules.error} loading={rules.loading}>
        <section class="read-group">
          <h2>Working rules</h2>
          {def.length ? (
            <ul class="list">
              {def.map((s) => (
                <li key={s.id}>
                  <a href={readHref('rules')}>
                    <strong>{s.title}</strong>
                    <span class="muted small">
                      {s.slug} · v{s.version} · <Time at={s.updated_at} />
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>No working rules yet.</Empty>
          )}
        </section>
        <section class="read-group">
          <h2>Other workspace rules</h2>
          {workspace.length ? (
            <ul class="list">
              {workspace.map((s) => (
                <li key={s.id}>
                  <a href={readHref('rules', s.id)}>
                    <strong>{s.title}</strong>
                    <span class="muted small">
                      {s.slug} · v{s.version} · <Time at={s.updated_at} />
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>No other workspace rules sets.</Empty>
          )}
        </section>
        <section class="read-group">
          <h2>Project rules</h2>
          {byProject.size ? (
            [...byProject.entries()].map(([project, list]) => (
              <div key={project}>
                <h3 class="read-sub">{project}</h3>
                <ul class="list">
                  {list.map((s) => (
                    <li key={s.id}>
                      <a href={readHref('rules', s.id)}>
                        <strong>{s.title}</strong>
                        <span class="muted small">
                          {s.slug} · v{s.version} · <Time at={s.updated_at} />
                        </span>
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))
          ) : (
            <Empty>No project rules sets.</Empty>
          )}
        </section>
      </Loading>
      <section class="read-group">
        <h2>Roles</h2>
        <Loading error={roles.error} loading={roles.loading}>
          {roles.data && !roles.data.results.length && <Empty>No roles yet.</Empty>}
          <ul class="list">
            {roles.data?.results.map((r) => (
              <li key={r.id}>
                <a href={readHref('role', r.id)}>
                  <strong>{r.title}</strong>
                  {r.snippet && <span class="muted small">{r.snippet.slice(0, 140)}</span>}
                </a>
              </li>
            ))}
          </ul>
        </Loading>
      </section>
      <section class="read-group">
        <h2>Projects</h2>
        <Loading error={projects.error} loading={projects.loading}>
          {projects.data && !projects.data.results.length && <Empty>No projects yet.</Empty>}
          <ul class="list">
            {projects.data?.results.map((p) => (
              <li key={p.id}>
                <a href={readHref('project', p.id)}>
                  <strong>{p.title}</strong>
                  {p.snippet && <span class="muted small">{p.snippet.slice(0, 140)}</span>}
                </a>
              </li>
            ))}
          </ul>
        </Loading>
      </section>
      <section class="read-group">
        <h2>Documents</h2>
        <Loading error={docs.error} loading={docs.loading}>
          {docs.data && !docs.data.results.length && <Empty>No documents yet.</Empty>}
          <ul class="list">
            {docs.data?.results.map((d) => (
              <li key={d.id}>
                <a href={readHref('document', d.id)}>
                  <strong>{d.title}</strong>
                  <span class="muted small">
                    updated <Time at={d.updated_at} />
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </Loading>
      </section>
    </Page>
  );
}

export function ReadItem({ type, id }: { type: Kind; id?: string }) {
  const { query } = useLocation();
  const wanted = Number(query.get('v') || '') || 0;
  const archivedOk = query.get('archived') === '1';
  const entity = useData(() => api<RulesFull & RoleFull & ProjectFull & DocFull>(entityPath(type, id)), [type, id]);
  const versions = useData(() => api<{ versions: VersionInfo[] }>(versionsPath(type, id)), [type, id]);
  const e = entity.data;
  const list = versions.data?.versions ?? [];
  const latest = list[0]?.number ?? (type === 'role' ? e?.instruction_version : type === 'project' ? e?.description_version : e?.version) ?? 0;
  const viewing = wanted > 0 && wanted !== latest ? wanted : 0;
  const past = useData(
    () => (viewing ? api<{ body: string; number: number; note: string | null; created_at: string }>(versionPath(type, id, viewing)) : Promise.resolve(null)),
    [type, id, viewing],
  );
  const archived = !!e?.archived;
  const hidden = archived && !archivedOk;
  const title = !e ? 'Reading' : type === 'rules' ? (e.title || 'Working rules') : type === 'document' ? e.title : e.name;
  const edit = e ? editHref(type, type === 'rules' ? e.id : id, type === 'rules' ? e.is_default : undefined) : null;
  const currentBody =
    type === 'rules' ? (e?.text ?? '') : type === 'role' ? (e?.instruction ?? '') : type === 'project' ? (e?.description ?? '') : (e?.body ?? '');
  const body = viewing && past.data ? past.data.body : currentBody;
  const currentVersion = type === 'role' ? (e?.instruction_version ?? 0) : type === 'project' ? (e?.description_version ?? 0) : (e?.version ?? 0);
  const shownVersion = viewing || currentVersion;
  const shownAuthor = (viewing ? list.find((v) => v.number === viewing) : list.find((v) => v.number === shownVersion)) ?? null;
  const shownAt = viewing && past.data ? past.data.created_at : shownAuthor?.created_at;
  const q = new URLSearchParams();
  if (archivedOk) q.set('archived', '1');
  const qs = q.toString();
  const withV = (n: number) => {
    const p = new URLSearchParams(qs);
    if (n && n !== latest) p.set('v', String(n));
    return readHref(type, id, p.toString());
  };

  return (
    <Page
      title={title}
      back="/read"
      actions={
        e && (
          <>
            {edit && <a href={edit}>Edit</a>}
            {currentVersion > 0 && <a href={historyHref(type, type === 'rules' && e.is_default ? undefined : e.id ?? id)}>Full history</a>}
          </>
        )
      }
    >
      <Loading error={entity.error || (viewing ? past.error : null)} loading={entity.loading}>
        {e && hidden && (
          <Alert kind="info">
            This item is archived.{' '}
            <a href={readHref(type, id, 'archived=1')}>Show archived items</a> to read it.
          </Alert>
        )}
        {e && !hidden && (
          <>
            <ReadSticky versions={list.length} current={shownVersion} latest={latest} />
            {viewing > 0 && (
              <Alert kind="info">
                You are viewing version {viewing}. <a href={withV(0)}>Open the current version</a>
                {edit && (
                  <>
                    {' '}
                    or <a href={edit}>edit</a>
                  </>
                )}
                .
              </Alert>
            )}
            <p class="muted small">
              {type === 'rules' && (
                <>
                  {e.is_default ? 'Default working rules' : 'Rules set'} · {e.slug}
                  {e.project ? ` · project ${e.project}` : ''}
                </>
              )}
              {type === 'role' && (
                <>
                  @{e.slug}
                  {e.area ? ` · ${e.area}` : ''}
                </>
              )}
              {type === 'project' && (
                <>
                  {e.slug}
                  {e.focus ? ` · ${e.focus}` : ''}
                </>
              )}
              {type === 'document' && (
                <>
                  {e.kind}
                  {e.attached_to?.type && e.attached_to.type !== 'workspace' ? ` · ${e.attached_to.type} ${e.attached_to.slug ?? ''}` : ' · workspace'}
                </>
              )}
              {shownVersion ? ` · version ${shownVersion}` : ' · no versions yet'}
              {shownAuthor && shownAt && (
                <>
                  {' '}
                  · {who(shownAuthor)} · <Time at={shownAt} />
                </>
              )}
              {e.archived ? ' · archived' : ''}
            </p>
            <div class="read-layout">
              <div class="read-main">
                {type === 'role' ? (
                  <>
                    <h2>Instruction</h2>
                    <Markdown text={body} />
                    <h2>Setup notes</h2>
                    <p class="muted small">Current text only. This field is not versioned.</p>
                    <Markdown text={e.setup_notes ?? ''} />
                  </>
                ) : (
                  <Markdown text={body} />
                )}
                {type === 'project' && <ProjectRules id={e.id} archivedOk={archivedOk} />}
                <HistoryBlock type={type} id={id} versions={list} latest={latest} currentHref={(n) => withV(n)} />
              </div>
            </div>
          </>
        )}
      </Loading>
    </Page>
  );
}

function ReadSticky({ versions, current, latest }: { versions: number; current: number; latest: number }) {
  return (
    <div class="read-sticky" aria-label="Section counts">
      <a href="#history">History ({versions})</a>
      {current && current !== latest ? <Badge tone="warn">v{current} of {latest}</Badge> : current ? <Badge tone="accent">v{current}</Badge> : null}
    </div>
  );
}

function ProjectRules({ id, archivedOk }: { id: string; archivedOk: boolean }) {
  const rules = useData(() => api<RulesFull>('/entity/rules'), []);
  const mine = (rules.data?.sets ?? []).filter((s) => s.project_id === id && (archivedOk || !s.project_archived));
  if (rules.loading && !rules.data) return null;
  return (
    <section class="read-group">
      <h2>Rules sets for this project</h2>
      {mine.length ? (
        <ul class="list">
          {mine.map((s) => (
            <li key={s.id}>
              <a href={readHref('rules', s.id)}>
                <strong>{s.title}</strong>
                <span class="muted small">
                  {s.slug} · v{s.version}
                </span>
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <Empty>No rules sets attached to this project.</Empty>
      )}
    </section>
  );
}

function HistoryBlock({ type, id, versions, latest, currentHref }: { type: Kind; id?: string; versions: VersionInfo[]; latest: number; currentHref: (n: number) => string }) {
  const [open, setOpen] = useState(true);
  const [from, setFrom] = useState<number | null>(null);
  const cmpFrom = from ?? (latest > 1 ? latest - 1 : 0);
  const cmp = useData(
    () => (latest ? api<{ added: number; removed: number; diff: DiffLine[] }>(comparePath(type, id, cmpFrom, latest)) : Promise.resolve(null)),
    [type, id, cmpFrom, latest],
  );
  return (
    <section id="history" class="read-history">
      <div class="section-head">
        <h2>History</h2>
        <Button kind="quiet" onClick={() => setOpen(!open)}>
          {open ? 'Hide' : 'Show'}
        </Button>
      </div>
      {open && (
        <>
          {!versions.length && <Empty>No versions yet.</Empty>}
          {versions.length > 0 && (
            <>
              <div class="filters">
                <label>
                  Compare{' '}
                  <select value={cmpFrom} onChange={(e) => setFrom(Number((e.target as HTMLSelectElement).value))} aria-label="From version">
                    <option value={0}>empty</option>
                    {versions.map((v) => (
                      <option key={v.number} value={v.number}>
                        v{v.number}
                      </option>
                    ))}
                  </select>
                </label>
                <span> with current (v{latest})</span>
              </div>
              <Loading error={cmp.error} loading={cmp.loading && !cmp.data}>
                {cmp.data && (
                  <>
                    <p class="small muted">
                      +{cmp.data.added} −{cmp.data.removed} lines
                    </p>
                    <div class="read-diff">
                      <Diff lines={cmp.data.diff} />
                    </div>
                  </>
                )}
              </Loading>
              <ul class="list versions">
                {versions.map((v) => (
                  <li key={v.number}>
                    <div class="version-row">
                      <div>
                        <strong>v{v.number}</strong> {v.number === latest && <Badge tone="accent">current</Badge>}
                        {v.rollback_of ? <Badge>restored v{v.rollback_of}</Badge> : null}
                        <div class="small muted">
                          {who(v)} · <Time at={v.created_at} />
                          {v.note ? ` · ${v.note}` : ''}
                        </div>
                      </div>
                      <div class="row">
                        <a class="btn btn-quiet" href={currentHref(v.number === latest ? 0 : v.number)}>
                          {v.number === latest ? 'Open current' : 'Open'}
                        </a>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  );
}
