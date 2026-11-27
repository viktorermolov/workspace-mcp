import { useEffect, useState } from 'preact/hooks';
import { api, ApiError, post } from '../api.ts';
import { passkeysSupported, registerPasskey, signInWithPasskey } from '../passkey.ts';
import { navigate } from '../router.ts';
import { Alert, Button, Field, Time, useAction, useData } from '../ui.tsx';

function Standalone({ title, children }: { title: string; children: preact.ComponentChildren }) {
  useEffect(() => {
    document.title = `${title} · Workspace`;
  }, [title]);
  return (
    <main class="standalone">
      <div class="standalone-card">
        <div class="brand" aria-hidden="true">
          <img src="/favicon.svg" alt="" width="40" height="40" />
        </div>
        <h1>{title}</h1>
        {children}
      </div>
    </main>
  );
}

function NoPasskeys() {
  return <Alert>This browser does not support passkeys. Open the page in a current version of Safari, Chrome, Edge or Firefox.</Alert>;
}

/** First-time setup and recovery: a one-time code from the server console, then a new passkey. */
export function SetupScreen() {
  const state = useData(() => api<{ has_owner: boolean }>('/api/setup/state'));
  const [code, setCode] = useState('');
  const [done, setDone] = useState(false);
  const act = useAction();
  const recovery = !!state.data?.has_owner;

  const submit = (e: Event) => {
    e.preventDefault();
    void act.run(async () => {
      const r = await post<{ context: string; purpose: string }>('/api/setup/verify', { code: code.trim() });
      await registerPasskey(r.context);
      setDone(true);
    });
  };

  if (done) {
    return (
      <Standalone title={recovery ? 'New passkey added' : 'Workspace is ready'}>
        <p>
          {recovery
            ? 'You are signed in with the new passkey. You can remove the lost one under Passkeys.'
            : 'Your passkey is registered and you are signed in. Next, connect your first AI platform.'}
        </p>
        <Button kind="primary" onClick={() => navigate(recovery ? '/passkeys' : '/connections?welcome=1')}>
          Continue
        </Button>
      </Standalone>
    );
  }

  return (
    <Standalone title={state.loading ? 'Workspace' : recovery ? 'Recover access' : 'Set up your workspace'}>
      {!passkeysSupported() && <NoPasskeys />}
      <p class="lead">
        {recovery ? (
          <>
            Enter a recovery code to register a new passkey for the owner. Get a code on the server with <code>cli recovery-code</code>.
          </>
        ) : (
          <>Enter the one-time setup code printed in the server log on first start, then create the owner passkey.</>
        )}
      </p>
      <form onSubmit={submit} class="stack">
        <Field label={recovery ? 'Recovery code' : 'Setup code'}>
          <input
            name="code"
            value={code}
            onInput={(e) => setCode((e.target as HTMLInputElement).value)}
            autoComplete="one-time-code"
            autoCapitalize="characters"
            spellcheck={false}
            required
            maxLength={64}
            placeholder="XXXX-XXXX-XXXX"
          />
        </Field>
        {act.error && <Alert>{act.error}</Alert>}
        <Button kind="primary" type="submit" busy={act.busy} disabled={!code.trim()}>
          {recovery ? 'Add a passkey' : 'Create passkey'}
        </Button>
      </form>
      {recovery && (
        <p class="muted small">
          Have your passkey? <a href="/login">Sign in</a>
        </p>
      )}
    </Standalone>
  );
}

/** Passkey sign-in; on an authorization request it continues to the consent screen. */
export function LoginScreen() {
  const params = new URLSearchParams(location.search);
  const oauth = params.has('sig') ? location.search.slice(1) : undefined;
  const nextParam = params.get('next');
  const next = nextParam && nextParam.startsWith('/') && !nextParam.startsWith('//') ? nextParam : '/';
  const act = useAction();
  const state = useData(() => api<{ has_owner: boolean }>('/api/setup/state'));

  useEffect(() => {
    if (state.data && !state.data.has_owner) navigate('/setup', true);
  }, [state.data]);

  const signIn = () =>
    act.run(async () => {
      const r = await signInWithPasskey(oauth);
      if (r.url) {
        const u = new URL(r.url, location.origin);
        if (u.origin === location.origin) navigate(u.pathname + u.search);
        else location.assign(u.toString());
        return;
      }
      navigate(next, true);
    });

  return (
    <Standalone title="Sign in">
      {!passkeysSupported() && <NoPasskeys />}
      <p class="lead">{oauth ? 'An AI platform asks to connect to your workspace. Sign in to review the request.' : 'Sign in to your workspace with your passkey.'}</p>
      {act.error && <Alert>{act.error}</Alert>}
      <Button kind="primary" onClick={signIn} busy={act.busy}>
        Sign in with passkey
      </Button>
      <p class="muted small">
        Lost your passkey? <a href="/setup">Use a recovery code</a>
      </p>
    </Standalone>
  );
}

interface ContinueTarget {
  client_id: string;
  name: string;
  agents: number;
  roles: { slug: string; name: string }[];
  sole_agent: boolean;
}

type ContinueWith =
  | { mode: 'auto'; target: ContinueTarget }
  | { mode: 'choice'; candidates: ContinueTarget[] }
  | { mode: 'new' };

interface ConsentInfo {
  client: { client_id: string; name: string | null; uri: string | null; redirect_uris: string[]; registration: string; created_at: string | null };
  connection: { name: string; approved_at: string | null; revoked_at: string | null } | null;
  continue_with: ContinueWith;
}

function platformSummary(t: ContinueTarget): string {
  const bits = [`${t.agents} ${t.agents === 1 ? 'agent' : 'agents'}`];
  if (t.roles.length) bits.push(`roles ${t.roles.map((r) => r.name).join(', ')}`);
  else bits.push('no confirmed roles');
  if (t.sole_agent) bits.push('sole agent');
  return bits.join(', ');
}

/** OAuth consent: shows who asks and where the answer goes, and names the connection. */
export function ConsentScreen() {
  const oauthQuery = location.search.slice(1);
  const params = new URLSearchParams(oauthQuery);
  const clientId = params.get('client_id') ?? '';
  const redirect = params.get('redirect_uri') ?? '';
  const [name, setName] = useState('');
  const [choice, setChoice] = useState<string>(''); // '' = new platform
  const act = useAction();
  const info = useData(async () => {
    try {
      return await api<ConsentInfo>(`/consent/client?client_id=${encodeURIComponent(clientId)}`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        navigate(`/login?next=${encodeURIComponent(location.pathname + location.search)}`, true);
      }
      throw e;
    }
  }, [clientId]);

  useEffect(() => {
    const c = info.data;
    // The suggested name fills only an empty field: this runs after the screen is shown, and the owner
    // may already have typed a name by then.
    if (c) {
      const suggested = c.continue_with.mode === 'auto' ? c.continue_with.target.name : (c.connection?.name ?? c.client.name ?? '');
      setName((typed) => typed || suggested);
    }
  }, [info.data]);

  const decide = (accept: boolean) =>
    act.run(async () => {
      const cont = info.data?.continue_with;
      const autoName = cont?.mode === 'auto' ? cont.target.name : '';
      const body: { accept: boolean; name: string; oauth_query: string; continue_client_id?: string | null } = {
        accept,
        name: name.trim() || autoName,
        oauth_query: oauthQuery,
      };
      if (accept && cont?.mode === 'choice') body.continue_client_id = choice || null;
      const r = await post<{ url: string }>('/consent', body);
      location.assign(r.url);
    });

  let host = redirect;
  try {
    host = new URL(redirect).host;
  } catch {
    /* keep the raw value */
  }

  if (!clientId) return <Standalone title="Invalid request">The authorization request is incomplete. Start the connection again from the platform.</Standalone>;

  return (
    <Standalone title="Connect a platform">
      {info.error && <Alert>{info.error}</Alert>}
      {info.data && (
        <>
          <p class="lead">
            <strong>{info.data.client.name || 'An unnamed client'}</strong> asks for full access to this workspace: it can read and change roles, rules, projects,
            documents and tasks.
          </p>
          <dl class="facts">
            <dt>Sends you back to</dt>
            <dd>
              <code>{host}</code>
            </dd>
            {info.data.client.registration === 'client-id-metadata-document' ? (
              <>
                <dt>Identified by</dt>
                <dd>
                  <code class="wrap">{info.data.client.client_id}</code>
                </dd>
              </>
            ) : (
              <>
                <dt>Registered</dt>
                <dd>
                  with this server, <Time at={info.data.client.created_at} />
                </dd>
              </>
            )}
            {info.data.client.uri && (
              <>
                <dt>Website</dt>
                <dd>
                  <code class="wrap">{info.data.client.uri}</code>
                </dd>
              </>
            )}
          </dl>
          <p class="muted small">Approve only a connection you started yourself just now. You can revoke it at any time under Platforms.</p>
          {info.data.continue_with.mode === 'auto' && (
            <p class="notice" role="status">
              Continues platform {info.data.continue_with.target.name}: {platformSummary(info.data.continue_with.target)}.
            </p>
          )}
          {info.data.continue_with.mode === 'choice' && (
            <fieldset class="stack">
              <legend>This client can continue an existing platform, or start a new one</legend>
              {info.data.continue_with.candidates.map((t) => (
                <label class="row" key={t.client_id}>
                  <input type="radio" name="continue" checked={choice === t.client_id} onChange={() => setChoice(t.client_id)} />
                  <span>
                    Continue platform {t.name}: {platformSummary(t)}
                  </span>
                </label>
              ))}
              <label class="row">
                <input type="radio" name="continue" checked={choice === ''} onChange={() => setChoice('')} />
                <span>New platform</span>
              </label>
            </fieldset>
          )}
          {info.data.continue_with.mode !== 'auto' && (
            <Field label="Name this platform" hint="For example Grok or Claude. Shown in the log next to everything it does.">
              <input value={name} maxLength={100} onInput={(e) => setName((e.target as HTMLInputElement).value)} placeholder="For example: Claude on my phone" />
            </Field>
          )}
          {act.error && <Alert>{act.error}</Alert>}
          <div class="row">
            <Button kind="primary" onClick={() => decide(true)} busy={act.busy} disabled={info.data.continue_with.mode !== 'auto' && !name.trim()}>
              Approve
            </Button>
            <Button onClick={() => decide(false)} busy={act.busy}>
              Deny
            </Button>
          </div>
        </>
      )}
    </Standalone>
  );
}
