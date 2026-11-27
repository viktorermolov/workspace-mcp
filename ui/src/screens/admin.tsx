import { useState } from 'preact/hooks';
import { api, del, enc, post, request } from '../api.ts';
import { registerPasskey, signOut } from '../passkey.ts';
import { navigate } from '../router.ts';
import { Alert, Badge, Button, Card, Empty, Field, Loading, Page, Time, useAction, useData } from '../ui.tsx';
import { entityHref } from './content.tsx';

function Copy({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      kind="quiet"
      onClick={() =>
        navigator.clipboard?.writeText(text).then(
          () => {
            setDone(true);
            setTimeout(() => setDone(false), 1500);
          },
          () => undefined,
        )
      }
    >
      {done ? 'Copied' : label}
    </Button>
  );
}

function Secret({ label, value }: { label: string; value: string }) {
  return (
    <div class="secret">
      <span class="field-label">{label}</span>
      <div class="row">
        <code class="wrap">{value}</code>
        <Copy text={value} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- connections

interface Client {
  client_id: string;
  name: string | null;
  uri: string | null;
  redirect_uris: string[];
  registration: string;
  created_at: string | null;
}
interface AllowedRole {
  id: string;
  slug: string;
  name: string;
  source: 'owner' | 'suggested';
}
interface WorkspaceRole {
  id: string;
  slug: string;
  name: string;
  edit_any: boolean;
}
interface Connection {
  client_id: string;
  name: string;
  client_name: string | null;
  created_at: string;
  approved_at: string | null;
  last_activity_at: string | null;
  revoked_at: string | null;
  client: Client | null;
  active: boolean;
  roles?: AllowedRole[];
  roles_confirmed_at?: string | null;
  roles_suggested_at?: string | null;
  roles_confirmed?: boolean;
}
interface ConnectionsPayload {
  connections: Connection[];
  pending_clients: Client[];
  role_enforcement: 'warn' | 'enforce';
  unconfirmed_active: { client_id: string; name: string }[];
  roles: WorkspaceRole[];
}
interface Me {
  member_id: string;
  name: string;
  version: string;
  public_url: string;
  mcp_url: string;
  source_url: string;
}

export function useMe() {
  return useData(() => api<Me>('/me'));
}

const REG: Record<string, string> = {
  'client-id-metadata-document': 'identified by its own URL',
  registered: 'registered with this server',
};

export function ConnectionsScreen() {
  const welcome = new URLSearchParams(location.search).has('welcome');
  const me = useMe();
  const list = useData(() => api<ConnectionsPayload>('/connections'));
  const agents = useData(() => api<{ agents: Agent[] }>('/agents'));
  const [diagFor, setDiagFor] = useState<string | null>(null);
  const [showManual, setShowManual] = useState(false);
  const act = useAction();
  const conns = list.data?.connections ?? [];
  const active = conns.filter((c) => c.active);
  const revoked = conns.filter((c) => !c.active);
  const revoke = (c: Connection) => {
    if (!confirm(`Revoke "${c.name}"? Its tokens stop working at once. The platform has to connect again to get access back.`)) return;
    void act.run(async () => {
      await post(`/connections/${enc(c.client_id)}/revoke`);
      await list.reload();
    });
  };
  const rename = (c: Connection) => {
    const name = prompt('New name for this connection', c.name);
    if (!name?.trim()) return;
    void act.run(async () => {
      await post(`/connections/${enc(c.client_id)}/rename`, { name: name.trim() });
      await list.reload();
    });
  };
  const removeClient = (id: string) => {
    if (!confirm('Delete this client registration? A platform that still uses it will have to register again.')) return;
    void act.run(async () => {
      await del(`/clients/${enc(id)}`);
      await list.reload();
    });
  };
  return (
    <Page
      title="Connections"
      actions={
        <Button kind="default" onClick={() => setShowManual(!showManual)}>
          {showManual ? 'Close' : 'Create a client'}
        </Button>
      }
    >
      {me.data && (
        <Card class={welcome ? 'notice' : ''}>
          {welcome && <p>Your workspace is ready. Add it to an AI platform as a custom connector (remote MCP server) with this address:</p>}
          {!welcome && <p class="muted small">Address to give an AI platform (custom connector, remote MCP server):</p>}
          <div class="row">
            <code class="wrap big">{me.data.mcp_url}</code>
            <Copy text={me.data.mcp_url} />
          </div>
          <p class="muted small">
            The platform opens a sign-in page here; approve it with your passkey. Most platforms register themselves. If one asks for a client id and secret, use
            “Create a client”.
          </p>
        </Card>
      )}
      {showManual && <ManualClient onCreated={() => list.reload()} />}
      {act.error && <Alert>{act.error}</Alert>}
      <Loading error={list.error} loading={list.loading}>
        {list.data && (
          <RoleAccessSettings
            data={list.data}
            busy={act.busy}
            onChange={() => list.reload()}
            run={act.run}
          />
        )}
        <h2>Active</h2>
        {!active.length && <Empty>No platform is connected yet.</Empty>}
        <ul class="list">
          {active.map((c) => (
            <li key={c.client_id}>
              <div class="version-row">
                <div>
                  <strong>{c.name}</strong>
                  <div class="small muted">
                    {c.client_name && c.client_name !== c.name ? `${c.client_name} · ` : ''}approved <Time at={c.approved_at} /> · last used <Time at={c.last_activity_at} />
                  </div>
                  {c.client && (
                    <div class="small muted">
                      {REG[c.client.registration] ?? c.client.registration}
                      {c.client.redirect_uris[0] ? ` · returns to ${hostOf(c.client.redirect_uris[0])}` : ''}
                    </div>
                  )}
                </div>
                <div class="row">
                  <Button kind="quiet" onClick={() => rename(c)}>
                    Rename
                  </Button>
                  <Button kind="quiet" onClick={() => setDiagFor(diagFor === c.client_id ? null : c.client_id)}>
                    Diagnostics
                  </Button>
                  <Button kind="danger" onClick={() => revoke(c)} busy={act.busy}>
                    Revoke
                  </Button>
                </div>
              </div>
              {diagFor === c.client_id && <Diagnostics clientId={c.client_id} />}
              {list.data && c.active && (
                <AgentList connection={c} agents={(agents.data?.agents ?? []).filter((a) => a.platform.id === c.client_id)} workspaceRoles={list.data.roles} onChanged={() => agents.reload()} />
              )}
              {list.data && (
                <ConnectionRoleList
                  key={`${c.client_id}:${c.roles_confirmed_at ?? ''}`}
                  connection={c}
                  workspaceRoles={list.data.roles}
                  busy={act.busy}
                  run={act.run}
                  onSaved={() => list.reload()}
                />
              )}
            </li>
          ))}
        </ul>
        {(list.data?.pending_clients.length ?? 0) > 0 && (
          <>
            <h2>Registered, not approved</h2>
            <p class="muted small">Platforms that registered or started a sign-in but were never approved. Unused registrations are removed automatically.</p>
            <ul class="list">
              {list.data!.pending_clients.map((c) => (
                <li key={c.client_id}>
                  <div class="version-row">
                    <div>
                      <strong>{c.name || 'Unnamed client'}</strong>
                      <div class="small muted">
                        {REG[c.registration] ?? c.registration} · <Time at={c.created_at} />
                        {c.redirect_uris[0] ? ` · returns to ${hostOf(c.redirect_uris[0])}` : ''}
                      </div>
                      <div class="small muted">
                        Client id <code class="wrap">{c.client_id}</code>
                      </div>
                    </div>
                    <div class="row">
                      <Button kind="quiet" onClick={() => setDiagFor(diagFor === c.client_id ? null : c.client_id)}>
                        Diagnostics
                      </Button>
                      <Button kind="quiet" onClick={() => removeClient(c.client_id)}>
                        Delete
                      </Button>
                    </div>
                  </div>
                  {diagFor === c.client_id && <Diagnostics clientId={c.client_id} />}
                </li>
              ))}
            </ul>
          </>
        )}
        {revoked.length > 0 && (
          <>
            <h2>Revoked</h2>
            <ul class="list">
              {revoked.map((c) => (
                <li key={c.client_id}>
                  <div class="version-row">
                    <div>
                      <strong>{c.name}</strong>
                      <div class="small muted">
                        revoked <Time at={c.revoked_at} />
                      </div>
                    </div>
                    <Button kind="quiet" onClick={() => removeClient(c.client_id)}>
                      Delete
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
        <h2>Connection attempts</h2>
        <p class="muted small">Every step of recent connection attempts, including failed ones. Useful when a platform cannot connect.</p>
        <Diagnostics />
      </Loading>
    </Page>
  );
}

function RoleAccessSettings({
  data,
  busy,
  onChange,
  run,
}: {
  data: ConnectionsPayload;
  busy: boolean;
  onChange: () => void;
  run: (fn: () => Promise<void>) => void;
}) {
  const [mode, setMode] = useState(data.role_enforcement);
  const [override, setOverride] = useState(false);
  const pending = data.unconfirmed_active;
  const blocked = mode === 'enforce' && data.role_enforcement !== 'enforce' && pending.length > 0 && !override;
  const saveMode = () =>
    run(async () => {
      await post('/settings/role-enforcement', { mode, override });
      setOverride(false);
      onChange();
    });
  const toggleEditAny = (r: WorkspaceRole, edit_any: boolean) =>
    run(async () => {
      await post(`/roles/${enc(r.id)}/edit-any`, { edit_any });
      onChange();
    });
  return (
    <>
      {data.role_enforcement === 'warn' && (
        <Card class="notice">
          <p>
            Role checks are in <strong>warning</strong> mode: writes still go through, but the server records a warning when a
            role is missing, unknown, archived, not on a confirmed list, or used to edit someone else’s item. Review each
            connection’s list, mark the roles that may edit any item, then switch to enforce. A week is a reasonable window;
            only you can turn enforcement on, and it does not switch automatically.
          </p>
        </Card>
      )}
      <Card>
        <h2>Role enforcement</h2>
        <p class="muted small">
          Each agent write must name a role that exists, is not archived, and is on that connection’s confirmed list. A
          suggested list from history is a draft and has no effect until you confirm it.
        </p>
        <label class="row">
          <input type="radio" name="role_enforcement" checked={mode === 'warn'} onChange={() => setMode('warn')} /> Warning
          mode (default after an upgrade)
        </label>
        <label class="row">
          <input type="radio" name="role_enforcement" checked={mode === 'enforce'} onChange={() => setMode('enforce')} />{' '}
          Enforce
        </label>
        {mode === 'enforce' && pending.length > 0 && data.role_enforcement !== 'enforce' && (
          <>
            <p class="muted small">These active connections do not yet have a confirmed list:</p>
            <ul class="small">
              {pending.map((c) => (
                <li key={c.client_id}>{c.name}</li>
              ))}
            </ul>
            <label class="row">
              <input type="checkbox" checked={override} onChange={(e) => setOverride((e.target as HTMLInputElement).checked)} />{' '}
              Turn on enforcement anyway (recorded in the log). Writes on an unconfirmed connection will be refused until
              you confirm its list.
            </label>
          </>
        )}
        {mode !== data.role_enforcement && (
          <Button kind="primary" onClick={saveMode} busy={busy} disabled={blocked}>
            Save enforcement
          </Button>
        )}
      </Card>
      <Card>
        <h2>Roles that may edit any item</h2>
        <p class="muted small">
          A role may edit items that belong to it. Tick a role here if it may also edit everyone else’s (for example an
          entry or chief-of-staff role). Only you can change this; agents cannot grant it through MCP.
        </p>
        {!data.roles.length && <p class="muted small">No roles yet.</p>}
        <ul class="list">
          {data.roles.map((r) => (
            <li key={r.id}>
              <label class="row">
                <input type="checkbox" checked={r.edit_any} disabled={busy} onChange={(e) => toggleEditAny(r, (e.target as HTMLInputElement).checked)} />{' '}
                <strong>{r.name}</strong>
                <span class="muted small">@{r.slug}</span>
              </label>
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}

interface Agent {
  id: string;
  slug: string;
  name: string;
  rev: number;
  platform: { id: string; name: string; active: boolean };
  roles: { id: string; slug: string; name: string; archived: boolean }[];
}

/** The named bots that run on one platform, and the roles each of them may take. */
function AgentList({ connection, agents, workspaceRoles, onChanged }: { connection: Connection; agents: Agent[]; workspaceRoles: WorkspaceRole[]; onChanged: () => void }) {
  const [editing, setEditing] = useState<string | null>(null);
  const act = useAction();
  const remove = (a: Agent) => {
    if (!confirm(`Remove the agent "${a.name}"? The log keeps what it did.`)) return;
    act.run(async () => {
      await del(`/agents/${enc(a.id)}`);
      onChanged();
    });
  };
  return (
    <div class="connection-roles agents">
      <p class="small muted">Agents on this platform, and the roles each may take.</p>
      {act.error && <Alert>{act.error}</Alert>}
      <ul class="plain">
        {agents.map((a) =>
          editing === a.id ? (
            <li key={a.id}>
              <AgentForm
                connection={connection}
                agent={a}
                workspaceRoles={workspaceRoles}
                onDone={() => {
                  setEditing(null);
                  onChanged();
                }}
                onCancel={() => setEditing(null)}
              />
            </li>
          ) : (
            <li key={a.id} class="version-row">
              <div>
                <a href={`/agents/${enc(a.slug)}`}>
                  <strong>{a.name}</strong>
                </a>{' '}
                <span class="muted small">@{a.slug}</span>
                <div class="row">{a.roles.length ? a.roles.map((r) => <Badge key={r.id}>{r.name}</Badge>) : <span class="muted small">no roles yet</span>}</div>
              </div>
              <div class="row">
                <Button kind="quiet" onClick={() => setEditing(a.id)}>
                  Edit
                </Button>
                <Button kind="quiet" onClick={() => remove(a)} busy={act.busy}>
                  Remove
                </Button>
              </div>
            </li>
          ),
        )}
      </ul>
      {editing === 'new' ? (
        <AgentForm
          connection={connection}
          workspaceRoles={workspaceRoles}
          onDone={() => {
            setEditing(null);
            onChanged();
          }}
          onCancel={() => setEditing(null)}
        />
      ) : (
        <Button kind="default" onClick={() => setEditing('new')}>
          Add an agent
        </Button>
      )}
    </div>
  );
}

function AgentForm({ connection, agent, workspaceRoles, onDone, onCancel }: { connection: Connection; agent?: Agent; workspaceRoles: WorkspaceRole[]; onDone: () => void; onCancel: () => void }) {
  const [name, setName] = useState(agent?.name ?? '');
  const [selected, setSelected] = useState<Set<string>>(new Set((agent?.roles ?? []).map((r) => r.id)));
  const act = useAction();
  const toggle = (id: string) =>
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const save = (e: Event) => {
    e.preventDefault();
    act.run(async () => {
      await post('/agents', agent ? { id: agent.id, rev: agent.rev, name, roles: [...selected] } : { name, platform: connection.client_id, roles: [...selected] });
      onDone();
    });
  };
  return (
    <form class="agent-form" onSubmit={save}>
      {act.error && <Alert>{act.error}</Alert>}
      <Field label="Agent name">
        <input value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} required maxLength={300} />
      </Field>
      <fieldset>
        <legend>Roles it may take</legend>
        {!workspaceRoles.length && <p class="small muted">Create a role first.</p>}
        <ul class="plain">
          {workspaceRoles.map((r) => (
            <li key={r.id}>
              <label class="row">
                <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggle(r.id)} /> {r.name} <span class="muted small">@{r.slug}</span>
              </label>
            </li>
          ))}
        </ul>
      </fieldset>
      <div class="row">
        <Button kind="primary" type="submit" busy={act.busy}>
          {agent ? 'Save agent' : 'Add agent'}
        </Button>
        <Button kind="quiet" type="button" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function ConnectionRoleList({
  connection,
  workspaceRoles,
  busy,
  run,
  onSaved,
}: {
  connection: Connection;
  workspaceRoles: WorkspaceRole[];
  busy: boolean;
  run: (fn: () => Promise<void>) => void;
  onSaved: () => void;
}) {
  const initial = new Set((connection.roles ?? []).map((r) => r.id));
  const suggested = new Set((connection.roles ?? []).filter((r) => r.source === 'suggested').map((r) => r.id));
  const [selected, setSelected] = useState<Set<string>>(initial);
  const toggle = (id: string) =>
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const save = () =>
    run(async () => {
      await post(`/connections/${enc(connection.client_id)}/roles`, { roles: [...selected], confirm: true });
      onSaved();
    });
  return (
    <div class="connection-roles">
      <p class="small muted">
        Roles this connection may sign writes as.
        {connection.roles_confirmed ? ' List confirmed.' : ' Not confirmed — a suggested list is a draft and has no effect in enforce.'}
      </p>
      {!workspaceRoles.length && <p class="small muted">Create a role first, then add it here.</p>}
      <ul class="plain">
        {workspaceRoles.map((r) => (
          <li key={r.id}>
            <label class="row">
              <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggle(r.id)} /> {r.name}{' '}
              <span class="muted small">@{r.slug}</span>
              {suggested.has(r.id) && !connection.roles_confirmed && <Badge>from this connection’s history</Badge>}
            </label>
          </li>
        ))}
      </ul>
      <Button kind="default" onClick={save} busy={busy}>
        Save and confirm this list
      </Button>
    </div>
  );
}

function hostOf(u: string) {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
}

interface Diag {
  id: number;
  at: string;
  client_id: string | null;
  step: string;
  method: string;
  path: string;
  status: number;
  outcome: string;
  detail: Record<string, unknown> | null;
}

function Diagnostics({ clientId }: { clientId?: string }) {
  const d = useData(() => api<{ entries: Diag[] }>(`/diagnostics?limit=${clientId ? 50 : 30}${clientId ? `&client_id=${enc(clientId)}` : ''}`), [clientId]);
  return (
    <Loading error={d.error} loading={d.loading}>
      {d.data && !d.data.entries.length && <Empty>No attempts recorded.</Empty>}
      {d.data && d.data.entries.length > 0 && (
        <div class="table-wrap">
          <table class="diag">
            <thead>
              <tr>
                <th>When</th>
                <th>Step</th>
                <th>Result</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {d.data.entries.map((e) => (
                <tr key={e.id} class={e.outcome === 'ok' ? '' : 'bad'}>
                  <td>
                    <Time at={e.at} />
                  </td>
                  <td>
                    {e.step}
                    <div class="small muted">
                      {e.method} {e.path}
                    </div>
                  </td>
                  <td>
                    <Badge tone={e.outcome === 'ok' ? 'ok' : 'danger'}>{e.status}</Badge>
                  </td>
                  <td class="small">
                    {e.detail
                      ? Object.entries(e.detail)
                          .filter(([, v]) => v !== null && v !== undefined && v !== '')
                          .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
                          .join(' · ')
                      : ''}
                    {!clientId && e.client_id ? <div class="muted wrap">{e.client_id}</div> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Loading>
  );
}

function ManualClient({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState('');
  const [uris, setUris] = useState('');
  const [confidential, setConfidential] = useState(true);
  const [created, setCreated] = useState<{ client_id: string; client_secret: string | null } | null>(null);
  const act = useAction();
  const submit = (e: Event) => {
    e.preventDefault();
    void act.run(async () => {
      const r = await post<{ client_id: string; client_secret: string | null }>('/clients', {
        name: name.trim(),
        redirect_uris: uris
          .split(/\s+/)
          .map((s) => s.trim())
          .filter(Boolean),
        confidential,
      });
      setCreated(r);
      onCreated();
    });
  };
  if (created)
    return (
      <Card class="notice">
        <p>
          <strong>Client created.</strong> Enter these values in the platform's connector settings. The secret is shown only now; if you lose it, delete the client and
          create a new one.
        </p>
        <Secret label="Client id" value={created.client_id} />
        {created.client_secret && <Secret label="Client secret" value={created.client_secret} />}
        <Button onClick={() => setCreated(null)}>Done</Button>
      </Card>
    );
  return (
    <Card>
      <form class="stack" onSubmit={submit}>
        <p class="muted small">For a platform that does not register itself and asks for a client id and secret. The platform's help names the redirect URL to enter.</p>
        <Field label="Name">
          <input value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} required maxLength={200} placeholder="For example: Grok" />
        </Field>
        <Field label="Redirect URLs" hint="One per line. https only (http only for localhost).">
          <textarea value={uris} onInput={(e) => setUris((e.target as HTMLTextAreaElement).value)} rows={2} required />
        </Field>
        <label class="check">
          <input type="checkbox" checked={confidential} onChange={(e) => setConfidential((e.target as HTMLInputElement).checked)} /> The platform keeps a client secret
          (recommended)
        </label>
        {act.error && <Alert>{act.error}</Alert>}
        <Button kind="primary" type="submit" busy={act.busy}>
          Create client
        </Button>
      </form>
    </Card>
  );
}

// ---------------------------------------------------------------- log

interface LogRow {
  id: number;
  at: string;
  by: string;
  actor_kind?: string;
  connection_name?: string | null;
  claimed_role?: string | null;
  agent?: string | null;
  owner_role?: string | null;
  whose?: string | null;
  entity_type: string;
  entity_id: string | null;
  action: string;
  summary: string;
}

export function LogScreen() {
  const q = new URLSearchParams(location.search);
  const et = q.get('entity_type');
  const eid = q.get('entity_id');
  const filtered = !!(et && eid);
  const [pages, setPages] = useState<LogRow[][]>([]);
  const [cursor, setCursor] = useState<string | number | null>(null);
  const [more, setMore] = useState(false);
  const load = async (after: string | number | null) => {
    if (filtered) {
      const r = await api<{ events: LogRow[]; next_cursor: string | null; has_more: boolean }>(`/log?entity_type=${enc(et!)}&entity_id=${enc(eid!)}&limit=50${after ? `&cursor=${enc(String(after))}` : ''}`);
      return { rows: r.events, next: r.next_cursor, more: r.has_more };
    }
    const r = await api<{ events: LogRow[] }>(`/log/latest?limit=50${after ? `&before=${after}` : ''}`);
    const last = r.events[r.events.length - 1];
    const rows = r.events.map((e) => ({ ...e, by: e.actor_kind === 'owner' ? 'you' : `${e.connection_name ?? e.actor_kind ?? 'system'}${e.agent ? `: ${e.agent}` : ''}` }));
    return { rows, next: last ? last.id : null, more: r.events.length === 50 };
  };
  const first = useData(async () => {
    const r = await load(null);
    setPages([r.rows]);
    setCursor(r.next);
    setMore(r.more);
    return true;
  }, [et, eid]);
  const act = useAction();
  const loadMore = () =>
    act.run(async () => {
      const r = await load(cursor);
      setPages((p) => [...p, r.rows]);
      setCursor(r.next);
      setMore(r.more);
    });
  const rows = pages.flat();
  return (
    <Page title={filtered ? 'History of one item' : 'Log'} back={filtered ? entityHref(et!, eid) ?? undefined : undefined}>
      <p class="muted">
        {filtered ? 'Every recorded change to this item, newest first.' : 'Everything that happened in the workspace, newest first, with who did it and whose item it was.'} The
        role is the name the agent gave for the change. After you turn on enforcement, the server only accepts a role that
        exists, is not archived, and is on that connection’s confirmed list.
      </p>
      {filtered && (
        <p>
          <a href="/log">Show the whole log</a>
        </p>
      )}
      <Loading error={first.error} loading={first.loading}>
        {!rows.length && <Empty>Nothing recorded yet.</Empty>}
        <ul class="log">
          {rows.map((r) => {
            const href = entityHref(r.entity_type, r.entity_id);
            return (
              <li key={r.id}>
                <div class="log-main">{href ? <a href={href}>{r.summary}</a> : r.summary}</div>
                <div class="small muted">
                  <Time at={r.at} /> · {r.by}
                  {r.claimed_role ? ` as @${r.claimed_role}` : ''}
                  {r.whose ? ` · ${r.whose}` : r.owner_role && r.owner_role !== r.claimed_role ? ` · item of @${r.owner_role}` : ''} · <code>{r.action}</code>
                </div>
              </li>
            );
          })}
        </ul>
        {act.error && <Alert>{act.error}</Alert>}
        {more && (
          <Button onClick={loadMore} busy={act.busy}>
            Show older
          </Button>
        )}
      </Loading>
    </Page>
  );
}

// ---------------------------------------------------------------- GitHub

interface GhRepo {
  id: number;
  full_name: string;
  created_at: string;
  last_synced_at: string | null;
  project: string | null;
  project_name: string | null;
  open_issues: number;
  default_role: string | null;
  assigners: { slug: string; name: string }[];
}

interface GhStatus {
  connected: boolean;
  login: string | null;
  connected_at: string | null;
  last_sync: { at: string; ok: boolean; message: string | null; issues: number } | null;
  sync_interval_minutes: number;
  repos: GhRepo[];
}

interface RoleChoice {
  slug: string;
  name: string;
}

function RoleAssignerFields({
  roles,
  defaultRole,
  onDefault,
  assigners,
  onToggle,
}: {
  roles: RoleChoice[];
  defaultRole: string;
  onDefault: (slug: string) => void;
  assigners: string[];
  onToggle: (slug: string, on: boolean) => void;
}) {
  return (
    <>
      <Field label="Default role" hint="Applied only to newly synced issues. Existing issues are left unchanged.">
        <select class="touch-target" value={defaultRole} onChange={(e) => onDefault((e.target as HTMLSelectElement).value)}>
          <option value="">none</option>
          {roles.map((r) => (
            <option key={r.slug} value={r.slug}>
              {r.name} (@{r.slug})
            </option>
          ))}
        </select>
      </Field>
      <div class="field">
        <span class="field-label">Who can assign a role</span>
        <span class="field-hint">Besides you and roles allowed to edit any item. This does not change what those roles may edit.</span>
        {roles.length === 0 ? (
          <p class="muted small">No roles yet.</p>
        ) : (
          <div class="stack">
            {roles.map((r) => (
              <label class="touch-row" key={r.slug}>
                <input type="checkbox" checked={assigners.includes(r.slug)} onChange={(e) => onToggle(r.slug, (e.target as HTMLInputElement).checked)} />
                {r.name} (@{r.slug})
              </label>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function RepoSettings({ repo, roles, onChange }: { repo: GhRepo; roles: RoleChoice[]; onChange: () => void }) {
  const act = useAction();
  const [defaultRole, setDefaultRole] = useState(repo.default_role ?? '');
  const [assigners, setAssigners] = useState<string[]>(repo.assigners.map((a) => a.slug));
  const toggle = (slug: string, on: boolean) => setAssigners((cur) => (on ? [...cur, slug] : cur.filter((s) => s !== slug)));
  const save = () =>
    act.run(async () => {
      await post(`/github/repos/${repo.id}`, { default_role: defaultRole || null, assigners });
      onChange();
    });
  return (
    <li class="repo-settings">
      <div class="version-row">
        <div>
          <strong>{repo.full_name}</strong>
          <div class="small muted">
            {repo.open_issues} open issues · {repo.project_name ? `project ${repo.project_name}` : 'no project'} · synced <Time at={repo.last_synced_at} />
          </div>
        </div>
        <Button
          kind="quiet"
          class="touch-target"
          onClick={() =>
            confirm(`Stop mirroring ${repo.full_name}? Its mirrored issues are removed.`) &&
            act.run(async () => {
              await del(`/github/repos/${repo.id}`);
              onChange();
            })
          }
        >
          Remove
        </Button>
      </div>
      <RoleAssignerFields
        roles={roles}
        defaultRole={defaultRole}
        onDefault={setDefaultRole}
        assigners={assigners}
        onToggle={toggle}
      />
      {act.error && <Alert>{act.error}</Alert>}
      <Button kind="primary" class="touch-target" onClick={save} busy={act.busy}>
        Save
      </Button>
    </li>
  );
}

export function GitHubScreen() {
  const st = useData(() => api<GhStatus>('/github'));
  const choices = useData(() => api<{ roles: RoleChoice[] }>('/choices'));
  const s = st.data;
  const act = useAction();
  const [token, setToken] = useState('');
  const connect = (e: Event) => {
    e.preventDefault();
    void act.run(async () => {
      await post('/github/token', { token: token.trim() });
      setToken('');
      await st.reload();
    });
  };
  const disconnect = () => {
    if (!confirm('Disconnect GitHub? The stored token and all mirrored issues are removed. Tasks are not touched.')) return;
    void act.run(async () => {
      await del('/github');
      await st.reload();
    });
  };
  const sync = () =>
    act.run(async () => {
      await post('/github/sync');
      await st.reload();
    });
  return (
    <Page title="GitHub issues">
      <div class="github-screen">
      <p class="muted">
        A read-only mirror of open issues from repositories you choose. Agents can search and read them; nothing is ever written to GitHub. Issue text is shown to agents
        as data, never as instructions. You can set a default role for new issues and choose which roles may assign the local role label; agents cannot change those settings.
      </p>
      {act.error && <Alert>{act.error}</Alert>}
      <Loading error={st.error} loading={st.loading}>
        {s && !s.connected && (
          <Card>
            <form class="stack" onSubmit={connect}>
              <Field
                label="Personal access token"
                hint={
                  <>
                    Create a fine-grained token on GitHub with read-only access to <em>Issues</em> and <em>Metadata</em> for the repositories you want. The token is stored
                    encrypted and is never shown again.
                  </>
                }
              >
                <input type="password" value={token} onInput={(e) => setToken((e.target as HTMLInputElement).value)} autoComplete="off" spellcheck={false} required />
              </Field>
              <Button kind="primary" type="submit" busy={act.busy}>
                Connect
              </Button>
            </form>
          </Card>
        )}
        {s?.connected && (
          <>
            <Card>
              <p>
                Connected as <strong>{s.login}</strong> <Time at={s.connected_at} />.
              </p>
              <p class="small muted">
                {s.last_sync ? (
                  <>
                    Last sync <Time at={s.last_sync.at} />: {s.last_sync.ok ? `${s.last_sync.issues} issues updated` : `failed (${s.last_sync.message ?? 'error'})`}.{' '}
                  </>
                ) : (
                  'Not synced yet. '
                )}
                Syncs every {s.sync_interval_minutes} minutes.
              </p>
              <div class="row">
                <Button onClick={sync} busy={act.busy}>
                  Sync now
                </Button>
                <Button kind="danger" onClick={disconnect} busy={act.busy}>
                  Disconnect
                </Button>
              </div>
            </Card>
            <h2>Repositories</h2>
            {!s.repos.length && <Empty>No repositories yet.</Empty>}
            <ul class="list">
              {s.repos.map((r) => (
                <RepoSettings key={r.id} repo={r} roles={choices.data?.roles ?? []} onChange={st.reload} />
              ))}
            </ul>
            <AddRepo existing={s.repos.map((r) => r.full_name)} roles={choices.data?.roles ?? []} onAdded={st.reload} />
          </>
        )}
      </Loading>
      </div>
    </Page>
  );
}

function AddRepo({ existing, roles, onAdded }: { existing: string[]; roles: RoleChoice[]; onAdded: () => void }) {
  const avail = useData(() => api<{ repos: { full_name: string }[] }>('/github/available'));
  const choices = useData(() => api<{ projects: { slug: string; name: string }[] }>('/choices'));
  const [repo, setRepo] = useState('');
  const [project, setProject] = useState('');
  const [defaultRole, setDefaultRole] = useState('');
  const [assigners, setAssigners] = useState<string[]>([]);
  const act = useAction();
  const options = (avail.data?.repos ?? []).filter((r) => !existing.includes(r.full_name));
  const toggle = (slug: string, on: boolean) => setAssigners((cur) => (on ? [...cur, slug] : cur.filter((s) => s !== slug)));
  return (
    <Card class="github-add">
      <form
        class="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void act.run(async () => {
            await post('/github/repos', { full_name: repo, project: project || null, default_role: defaultRole || null, assigners });
            setRepo('');
            setProject('');
            setDefaultRole('');
            setAssigners([]);
            onAdded();
          });
        }}
      >
        <div class="grid2">
          <Field label="Repository" hint={avail.error ? `Could not list repositories: ${avail.error}` : 'Repositories the token can read.'}>
            <select class="touch-target" value={repo} onChange={(e) => setRepo((e.target as HTMLSelectElement).value)} required>
              <option value="">{avail.loading ? 'Loading…' : 'choose'}</option>
              {options.map((r) => (
                <option key={r.full_name} value={r.full_name}>
                  {r.full_name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Link to project" hint="Optional: its issues show with that project.">
            <select class="touch-target" value={project} onChange={(e) => setProject((e.target as HTMLSelectElement).value)}>
              <option value="">none</option>
              {choices.data?.projects.map((p) => (
                <option key={p.slug} value={p.slug}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <RoleAssignerFields roles={roles} defaultRole={defaultRole} onDefault={setDefaultRole} assigners={assigners} onToggle={toggle} />
        {act.error && <Alert>{act.error}</Alert>}
        <Button kind="primary" class="touch-target" type="submit" busy={act.busy} disabled={!repo}>
          Add repository
        </Button>
      </form>
    </Card>
  );
}

// ---------------------------------------------------------------- webhooks

const EVENTS = ['task.assigned', 'task.updated', 'task.commented', 'task.unblocked', 'role.updated', 'review.commented'];
interface Hook {
  id: string;
  role: string;
  role_name: string;
  url: string;
  has_authorization: boolean;
  events: string[];
  enabled: boolean;
  created_at: string;
  updated_at: string;
  deliveries: { delivered: number; failed: number; pending: number; last_at: string | null };
}
interface Delivery {
  id: string;
  status: string;
  events: unknown;
  attempts: number;
  last_status: number | null;
  last_error: string | null;
  next_attempt_at: string | null;
  created_at: string;
  delivered_at: string | null;
}

export function WebhooksScreen() {
  const list = useData(() => api<{ webhooks: Hook[] }>('/webhooks'));
  const [editing, setEditing] = useState<Hook | 'new' | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Page
      title="Webhooks"
      actions={
        <Button kind="primary" onClick={() => setEditing('new')}>
          New webhook
        </Button>
      }
    >
      <p class="muted">
        Wake a role's agent when something changes for it: the workspace sends a signed POST with what changed. The receiver then calls <code>start</code> to fetch the
        details. Several events within 10 seconds are sent as one delivery; failures are retried.
      </p>
      {editing && (
        <HookForm
          hook={editing === 'new' ? undefined : editing}
          onDone={() => {
            setEditing(null);
            void list.reload();
          }}
        />
      )}
      <Loading error={list.error} loading={list.loading}>
        {list.data && !list.data.webhooks.length && !editing && <Empty>No webhooks.</Empty>}
        <ul class="list">
          {list.data?.webhooks.map((h) => (
            <li key={h.id}>
              <div class="version-row">
                <div>
                  <strong>@{h.role}</strong> {!h.enabled && <Badge tone="warn">off</Badge>}
                  <div class="small wrap">{h.url}</div>
                  <div class="small muted">
                    {h.events.join(', ')} · {h.deliveries.delivered} delivered, {h.deliveries.failed} failed{h.deliveries.pending ? `, ${h.deliveries.pending} pending` : ''}
                  </div>
                </div>
                <div class="row">
                  <Button kind="quiet" onClick={() => setOpen(open === h.id ? null : h.id)}>
                    {open === h.id ? 'Close' : 'Details'}
                  </Button>
                  <Button kind="quiet" onClick={() => setEditing(h)}>
                    Edit
                  </Button>
                </div>
              </div>
              {open === h.id && <HookDetails hook={h} onChanged={list.reload} />}
            </li>
          ))}
        </ul>
      </Loading>
    </Page>
  );
}

function HookForm({ hook, onDone }: { hook?: Hook; onDone: () => void }) {
  const choices = useData(() => api<{ roles: { slug: string; name: string }[] }>('/choices'));
  const [f, setF] = useState({ role: hook?.role ?? '', url: hook?.url ?? '', authorization: '', clearAuth: false, events: hook?.events ?? ['task.assigned', 'task.unblocked'], enabled: hook?.enabled ?? true });
  const act = useAction();
  const toggle = (e: string) => setF({ ...f, events: f.events.includes(e) ? f.events.filter((x) => x !== e) : [...f.events, e] });
  const submit = (ev: Event) => {
    ev.preventDefault();
    void act.run(async () => {
      const authorization = f.clearAuth ? null : f.authorization ? f.authorization : hook ? undefined : null;
      await post('/webhooks', { id: hook?.id, role: f.role, url: f.url.trim(), events: f.events, enabled: f.enabled, authorization });
      onDone();
    });
  };
  return (
    <Card>
      <form class="stack" onSubmit={submit}>
        <div class="grid2">
          <Field label="Role">
            <select value={f.role} onChange={(e) => setF({ ...f, role: (e.target as HTMLSelectElement).value })} required>
              <option value="">choose</option>
              {choices.data?.roles.map((r) => (
                <option key={r.slug} value={r.slug}>
                  {r.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="URL" hint="https only. Internal addresses are refused.">
            <input type="url" value={f.url} onInput={(e) => setF({ ...f, url: (e.target as HTMLInputElement).value })} required />
          </Field>
        </div>
        <Field
          label="Authorization header (optional)"
          hint={hook?.has_authorization ? 'A value is stored. Leave empty to keep it.' : 'Sent as the Authorization header, for example a bearer token the receiver expects.'}
        >
          <input type="password" value={f.authorization} onInput={(e) => setF({ ...f, authorization: (e.target as HTMLInputElement).value })} autoComplete="off" />
        </Field>
        {hook?.has_authorization && (
          <label class="check">
            <input type="checkbox" checked={f.clearAuth} onChange={(e) => setF({ ...f, clearAuth: (e.target as HTMLInputElement).checked })} /> Remove the stored value
          </label>
        )}
        <fieldset class="links">
          <legend>Events</legend>
          {EVENTS.map((e) => (
            <label class="check" key={e}>
              <input type="checkbox" checked={f.events.includes(e)} onChange={() => toggle(e)} /> <code>{e}</code>
            </label>
          ))}
        </fieldset>
        <label class="check">
          <input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: (e.target as HTMLInputElement).checked })} /> Enabled
        </label>
        {act.error && <Alert>{act.error}</Alert>}
        <div class="row">
          <Button kind="primary" type="submit" busy={act.busy}>
            {hook ? 'Save' : 'Create webhook'}
          </Button>
          <Button kind="quiet" onClick={onDone}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}

function HookDetails({ hook, onChanged }: { hook: Hook; onChanged: () => void }) {
  const d = useData(() => api<{ deliveries: Delivery[] }>(`/webhooks/${enc(hook.id)}/deliveries?limit=30`), [hook.id]);
  const [secret, setSecret] = useState<string | null>(null);
  const act = useAction();
  return (
    <div class="stack details">
      <div class="row">
        <Button
          onClick={() =>
            act.run(async () => {
              await post(`/webhooks/${enc(hook.id)}/test`);
              await d.reload();
            })
          }
          busy={act.busy}
        >
          Send a test
        </Button>
        <Button kind="quiet" onClick={() => act.run(async () => setSecret((await api<{ signing_secret: string }>(`/webhooks/${enc(hook.id)}/secret`)).signing_secret))}>
          Show signing secret
        </Button>
        <Button
          kind="danger"
          onClick={() =>
            confirm('Delete this webhook and its delivery log?') &&
            act.run(async () => {
              await del(`/webhooks/${enc(hook.id)}`);
              onChanged();
            })
          }
        >
          Delete
        </Button>
      </div>
      {secret && <Secret label="Signing secret (HMAC-SHA256, see the docs)" value={secret} />}
      {act.error && <Alert>{act.error}</Alert>}
      <Loading error={d.error} loading={d.loading}>
        {d.data && !d.data.deliveries.length && <Empty>No deliveries yet.</Empty>}
        {d.data && d.data.deliveries.length > 0 && (
          <div class="table-wrap">
            <table class="diag">
              <thead>
                <tr>
                  <th>Created</th>
                  <th>Status</th>
                  <th>Attempts</th>
                  <th>Last answer</th>
                </tr>
              </thead>
              <tbody>
                {d.data.deliveries.map((x) => (
                  <tr key={x.id} class={x.status === 'failed' ? 'bad' : ''}>
                    <td>
                      <Time at={x.created_at} />
                    </td>
                    <td>
                      <Badge tone={x.status === 'delivered' ? 'ok' : x.status === 'failed' ? 'danger' : 'warn'}>{x.status}</Badge>
                    </td>
                    <td>{x.attempts}</td>
                    <td class="small">
                      {x.last_status ?? ''} {x.last_error ?? ''}
                      {x.status === 'pending' && x.next_attempt_at ? (
                        <div class="muted">
                          next try <Time at={x.next_attempt_at} />
                        </div>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Loading>
    </div>
  );
}

// ---------------------------------------------------------------- backups, export, import

export function DataScreen() {
  const b = useData(() => api<{ backups: { name: string; reason: string; created_at: string; size: number }[]; interval_hours: number; keep: number }>('/backups'));
  const imp = useData(() => api<{ empty: boolean }>('/import'));
  const act = useAction();
  const [done, setDone] = useState<string | null>(null);
  const doImport = (file: File) =>
    act.run(async () => {
      if (!confirm(`Import ${file.name} into this empty workspace?`)) return;
      const res = await request('/api/owner/import', { method: 'POST', body: file, headers: { 'content-type': 'application/zip' } });
      const r = (await res.json()) as { counts?: Record<string, number> };
      setDone(`Imported: ${Object.entries(r.counts ?? {}).map(([k, v]) => `${v} ${k}`).join(', ') || 'done'}.`);
      await imp.reload();
    });
  return (
    <Page title="Export and backups">
      {act.error && <Alert>{act.error}</Alert>}
      {done && <Alert kind="ok">{done}</Alert>}
      <h2>Export</h2>
      <p class="muted">
        A zip with readable Markdown and JSON: rules, roles, projects, documents with every version, tasks and the log. No tokens, passkeys or secrets.
      </p>
      <a class="btn btn-primary" href="/api/owner/export" download>
        Download export
      </a>
      {imp.data?.empty && (
        <>
          <h2>Import</h2>
          <p class="muted">The workspace is empty, so an export can be imported here (for example when moving to a new server). A backup is made first.</p>
          <input type="file" accept=".zip,application/zip" aria-label="Export file" onChange={(e) => {
            const f = (e.target as HTMLInputElement).files?.[0];
            if (f) void doImport(f);
          }} />
        </>
      )}
      <h2>Backups</h2>
      <p class="muted">
        Full copies of the database (every {b.data?.interval_hours ?? '…'} hours, the last {b.data?.keep ?? '…'} kept, plus one before every migration). Keep a copy
        off the server too. Restore with <code>cli restore</code> while the service is stopped; see the docs.
      </p>
      <Button
        onClick={() =>
          act.run(async () => {
            const r = await post<{ name: string }>('/backups');
            setDone(`Backup ${r.name} created.`);
            await b.reload();
          })
        }
        busy={act.busy}
      >
        Back up now
      </Button>
      <Loading error={b.error} loading={b.loading}>
        {b.data && !b.data.backups.length && <Empty>No backups yet.</Empty>}
        <ul class="list">
          {b.data?.backups.map((x) => (
            <li key={x.name}>
              <div class="version-row">
                <div>
                  <strong class="wrap">{x.name}</strong>
                  <div class="small muted">
                    {x.reason} · <Time at={x.created_at} /> · {(x.size / 1024).toFixed(0)} KB
                  </div>
                </div>
                <a class="btn btn-quiet" href={`/api/owner/backups/${enc(x.name)}/download`} download>
                  Download
                </a>
              </div>
            </li>
          ))}
        </ul>
      </Loading>
    </Page>
  );
}

// ---------------------------------------------------------------- passkeys

export function PasskeysScreen() {
  const list = useData(() => api<{ passkeys: { id: string; name: string | null; deviceType: string; backedUp: number | boolean; createdAt: string }[] }>('/passkeys'));
  const act = useAction();
  const [code, setCode] = useState<{ code: string; expires_at: string; setup_url: string } | null>(null);
  const addHere = () =>
    act.run(async () => {
      const c = await post<{ code: string }>('/passkeys/code');
      const v = await post<{ context: string }>('/api/setup/verify', { code: c.code });
      await registerPasskey(v.context);
      await list.reload();
    });
  return (
    <Page title="Passkeys">
      <p class="muted">Passkeys that can sign in as the owner. Keep at least two, on different devices, so losing one phone does not lock you out.</p>
      {act.error && <Alert>{act.error}</Alert>}
      <Loading error={list.error} loading={list.loading}>
        <ul class="list">
          {list.data?.passkeys.map((p) => (
            <li key={p.id}>
              <div class="version-row">
                <div>
                  <strong>{p.name || 'Passkey'}</strong>
                  <div class="small muted">
                    added <Time at={p.createdAt} /> · {p.backedUp ? 'synced' : 'this device only'}
                  </div>
                </div>
                <div class="row">
                  <Button
                    kind="quiet"
                    onClick={() => {
                      const name = prompt('Name for this passkey', p.name ?? '');
                      if (name !== null)
                        void act.run(async () => {
                          await post(`/passkeys/${enc(p.id)}/rename`, { name: name.trim() });
                          await list.reload();
                        });
                    }}
                  >
                    Rename
                  </Button>
                  <Button
                    kind="danger"
                    onClick={() =>
                      confirm('Delete this passkey? It can no longer sign in.') &&
                      act.run(async () => {
                        await del(`/passkeys/${enc(p.id)}`);
                        await list.reload();
                      })
                    }
                  >
                    Delete
                  </Button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      </Loading>
      <div class="row">
        <Button kind="primary" onClick={addHere} busy={act.busy}>
          Add a passkey on this device
        </Button>
        <Button onClick={() => act.run(async () => setCode(await post('/passkeys/code')))}>Add on another device</Button>
      </div>
      {code && (
        <Card class="notice">
          <p>
            On the other device, open <code class="wrap">{code.setup_url}</code> and enter this code. It works once and expires <Time at={code.expires_at} />.
          </p>
          <Secret label="One-time code" value={code.code} />
        </Card>
      )}
    </Page>
  );
}

// ---------------------------------------------------------------- more

export function getTheme(): string {
  try {
    return localStorage.getItem('theme') ?? 'auto';
  } catch {
    return 'auto';
  }
}
export function applyTheme(t: string): void {
  if (t === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
  try {
    if (t === 'auto') localStorage.removeItem('theme');
    else localStorage.setItem('theme', t);
  } catch {
    /* storage blocked */
  }
}

export function MoreScreen() {
  const me = useMe();
  const [theme, setTheme] = useState(getTheme());
  const act = useAction();
  const links: [string, string, string][] = [
    ['/rules', 'Working rules', 'Shared by every role'],
    ['/read', 'Reading', 'Rendered rules, instructions and documents'],
    ['/reviews', 'Reviews', 'Review comments waiting for a reply or a resolution'],
    ['/roles', 'Roles', 'Who does what'],
    ['/projects', 'Projects and documents', 'Descriptions, specs, notes'],
    ['/github', 'GitHub issues', 'Read-only mirror'],
    ['/connections', 'Connections', 'AI platforms with access'],
    ['/webhooks', 'Webhooks', 'Wake agents on changes'],
    ['/log', 'Log', 'Everything, with who did it'],
    ['/data', 'Export and backups', 'Your data, in readable form'],
    ['/passkeys', 'Passkeys', 'How you sign in'],
  ];
  return (
    <Page title="More">
      <ul class="list nav-list">
        {links.map(([href, title, sub]) => (
          <li key={href}>
            <a href={href}>
              <strong>{title}</strong>
              <span class="muted small">{sub}</span>
            </a>
          </li>
        ))}
      </ul>
      <h2>Appearance</h2>
      <div class="segmented" role="radiogroup" aria-label="Theme">
        {['auto', 'light', 'dark'].map((t) => (
          <button
            key={t}
            type="button"
            role="radio"
            aria-checked={theme === t}
            class={theme === t ? 'on' : ''}
            onClick={() => {
              applyTheme(t);
              setTheme(t);
            }}
          >
            {t === 'auto' ? 'System' : t === 'light' ? 'Light' : 'Dark'}
          </button>
        ))}
      </div>
      {me.data && (
        <>
          <h2>This server</h2>
          <dl class="facts">
            <dt>MCP address</dt>
            <dd>
              <code class="wrap">{me.data.mcp_url}</code> <Copy text={me.data.mcp_url} />
            </dd>
            <dt>Version</dt>
            <dd>{me.data.version}</dd>
            <dt>Source code</dt>
            <dd>
              <a href={me.data.source_url} target="_blank" rel="noopener noreferrer">
                {me.data.source_url}
              </a>{' '}
              (AGPL-3.0)
            </dd>
          </dl>
        </>
      )}
      {act.error && <Alert>{act.error}</Alert>}
      <Button
        kind="default"
        onClick={() =>
          act.run(async () => {
            await signOut();
            navigate('/login', true);
          })
        }
        busy={act.busy}
      >
        Sign out
      </Button>
    </Page>
  );
}
