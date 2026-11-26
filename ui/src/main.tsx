import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { api, ApiError, post, setUnauthorizedHandler } from './api.ts';
import { match, navigate, onLinkClick, useLocation } from './router.ts';
import { applyTheme, ConnectionsScreen, DataScreen, getTheme, GitHubScreen, LogScreen, MoreScreen, PasskeysScreen, WebhooksScreen } from './screens/admin.tsx';
import { ConsentScreen, LoginScreen, SetupScreen } from './screens/auth.tsx';
import { ChangesScreen, DocumentScreen, HistoryScreen, ProjectScreen, ProjectsScreen, RoleScreen, RolesScreen, RulesScreen } from './screens/content.tsx';
import { ReadIndex, ReadItem } from './screens/read.tsx';
import { MapScreen } from './screens/map.tsx';
import { TaskScreen, TasksScreen } from './screens/tasks.tsx';
import { Alert, Button } from './ui.tsx';
import './styles.css';

applyTheme(getTheme());

const STANDALONE = ['/setup', '/login', '/consent'];

type Route = [string, (p: Record<string, string>, refresh: () => void) => preact.JSX.Element];
const ROUTES: Route[] = [
  ['/', () => <MapScreen />],
  ['/tasks', () => <TasksScreen />],
  ['/tasks/:id', (p) => <TaskScreen key={p.id} id={p.id!} />],
  ['/projects', () => <ProjectsScreen />],
  ['/projects/:id', (p) => <ProjectScreen key={p.id} id={p.id!} />],
  ['/documents/:id', (p) => <DocumentScreen key={p.id} id={p.id!} />],
  ['/roles', () => <RolesScreen />],
  ['/roles/:id', (p) => <RoleScreen key={p.id} id={p.id!} />],
  ['/rules', () => <RulesScreen />],
  ['/read', () => <ReadIndex />],
  ['/read/rules', () => <ReadItem type="rules" />],
  ['/read/rules/:id', (p) => <ReadItem key={`rules/${p.id}`} type="rules" id={p.id} />],
  ['/read/role/:id', (p) => <ReadItem key={`role/${p.id}`} type="role" id={p.id!} />],
  ['/read/project/:id', (p) => <ReadItem key={`project/${p.id}`} type="project" id={p.id!} />],
  ['/read/document/:id', (p) => <ReadItem key={`document/${p.id}`} type="document" id={p.id!} />],
  ['/history/rules', () => <HistoryScreen type="rules" />],
  ['/history/:type/:id', (p) => <HistoryScreen key={`${p.type}/${p.id}`} type={p.type as 'rules' | 'role' | 'project' | 'document'} id={p.id!} />],
  ['/changes', (_p, refresh) => <ChangesScreen onReviewed={refresh} />],
  ['/github', () => <GitHubScreen />],
  ['/log', () => <LogScreen key={location.search} />],
  ['/connections', () => <ConnectionsScreen />],
  ['/webhooks', () => <WebhooksScreen />],
  ['/data', () => <DataScreen />],
  ['/passkeys', () => <PasskeysScreen />],
  ['/more', () => <MoreScreen />],
];

const TABS: { href: string; label: string; icon: string; also?: string[] }[] = [
  { href: '/', label: 'Map', icon: 'M12 3a3 3 0 1 1 0 6 3 3 0 0 1 0-6Zm-6 12a3 3 0 1 1 0 6 3 3 0 0 1 0-6Zm12 0a3 3 0 1 1 0 6 3 3 0 0 1 0-6ZM11 9h2v3l4 3-1.2 1.6L12 13.8l-3.8 2.8L7 15l4-3V9Z', also: ['/roles', '/rules', '/read'] },
  { href: '/tasks', label: 'Tasks', icon: 'M4 5h3v3H4V5Zm5 .5h11v2H9v-2ZM4 10.5h3v3H4v-3Zm5 .5h11v2H9v-2Zm-5 5h3v3H4v-3Zm5 .5h11v2H9v-2Z' },
  { href: '/projects', label: 'Projects', icon: 'M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6Zm2 2v10h14V8H5Z', also: ['/documents', '/history'] },
  { href: '/changes', label: 'Changes', icon: 'M12 3a9 9 0 1 1-9 9h2a7 7 0 1 0 2.05-4.95L9 9H3V3l2.64 2.64A8.97 8.97 0 0 1 12 3Zm-1 4h2v5l3.5 2.1-1 1.7L11 13V7Z' },
  { href: '/more', label: 'More', icon: 'M5 10a2 2 0 1 1 0 4 2 2 0 0 1 0-4Zm7 0a2 2 0 1 1 0 4 2 2 0 0 1 0-4Zm7 0a2 2 0 1 1 0 4 2 2 0 0 1 0-4Z', also: ['/github', '/log', '/connections', '/webhooks', '/data', '/passkeys'] },
];
const SIDE_EXTRA = [
  ['/roles', 'Roles'],
  ['/rules', 'Working rules'],
  ['/read', 'Reading'],
  ['/github', 'GitHub issues'],
  ['/connections', 'Connections'],
  ['/webhooks', 'Webhooks'],
  ['/log', 'Log'],
  ['/data', 'Export and backups'],
  ['/passkeys', 'Passkeys'],
];

function isActive(path: string, t: (typeof TABS)[number]) {
  if (t.href === '/') return path === '/' || !!t.also?.some((a) => path.startsWith(a));
  return path === t.href || path.startsWith(`${t.href}/`) || !!t.also?.some((a) => path.startsWith(a));
}

function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <path d={d} fill="currentColor" />
    </svg>
  );
}

function Shell({ path }: { path: string }) {
  const [authed, setAuthed] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [pending, setPending] = useState(0);
  const refresh = () =>
    api<{ items: unknown[]; has_more: boolean }>('/changes')
      .then((r) => setPending(r.has_more ? 100 : r.items.length))
      .catch(() => undefined);

  useEffect(() => {
    setBootError(null);
    api('/me')
      .then(() => {
        setAuthed(true);
        void post('/visit').catch(() => undefined);
        void refresh();
      })
      .catch((e: unknown) => {
        // A 401 already sends the owner to the sign-in page. Anything else (the server restarting, a proxy
        // error, no network) is shown with a way to try again instead of an endless "Loading…".
        if (e instanceof ApiError && e.status === 401) return;
        setBootError(e instanceof ApiError ? e.message : 'Could not reach the server.');
      });
  }, [attempt]);
  useEffect(() => {
    if (authed) void refresh();
  }, [path, authed]);

  if (!authed && bootError)
    return (
      <div class="boot">
        <Alert>The workspace could not be loaded: {bootError}</Alert>
        <Button kind="primary" onClick={() => setAttempt((n) => n + 1)}>
          Try again
        </Button>
      </div>
    );
  if (!authed) return <p class="muted loading boot">Loading…</p>;

  let screen: preact.JSX.Element | null = null;
  for (const [pattern, view] of ROUTES) {
    const p = match(pattern, path);
    if (p) {
      screen = view(p, refresh);
      break;
    }
  }
  return (
    <div class="shell">
      <a class="skip" href="#main">
        Skip to content
      </a>
      <nav class="sidebar" aria-label="Main">
        <a class="side-brand" href="/">
          <img src="/favicon.svg" alt="" width="28" height="28" /> Workspace
        </a>
        {TABS.filter((t) => t.href !== '/more').map((t) => (
          <a key={t.href} href={t.href} class={isActive(path, t) && !SIDE_EXTRA.some(([h]) => path.startsWith(h)) ? 'on' : ''} aria-current={path === t.href ? 'page' : undefined}>
            <Icon d={t.icon} /> {t.label}
            {t.href === '/changes' && pending > 0 && <span class="count">{pending > 99 ? '99+' : pending}</span>}
          </a>
        ))}
        <div class="side-sep" />
        {SIDE_EXTRA.map(([href, label]) => (
          <a key={href} href={href} class={path.startsWith(href!) ? 'on' : ''}>
            {label}
          </a>
        ))}
        <a href="/more" class={path === '/more' ? 'on' : ''}>
          More
        </a>
      </nav>
      <main id="main" class="main">
        {screen ?? (
          <section class="page">
            <h1>Not found</h1>
            <p>
              This page does not exist. <a href="/">Go to the map</a>
            </p>
          </section>
        )}
      </main>
      <nav class="tabbar" aria-label="Main">
        {TABS.map((t) => (
          <a key={t.href} href={t.href} class={isActive(path, t) ? 'on' : ''} aria-current={path === t.href ? 'page' : undefined}>
            <Icon d={t.icon} />
            <span>{t.label}</span>
            {t.href === '/changes' && pending > 0 && <span class="count">{pending > 99 ? '99+' : pending}</span>}
          </a>
        ))}
      </nav>
    </div>
  );
}

function App() {
  const { path } = useLocation();
  useEffect(() => {
    setUnauthorizedHandler(() => {
      if (!STANDALONE.includes(location.pathname)) navigate(`/login?next=${encodeURIComponent(location.pathname + location.search)}`, true);
    });
  }, []);
  if (path === '/setup') return <SetupScreen />;
  if (path === '/login') return <LoginScreen key={location.search} />;
  if (path === '/consent') return <ConsentScreen />;
  return <Shell key="shell" path={path} />;
}

document.addEventListener('click', onLinkClick);
render(<App />, document.getElementById('app')!);
