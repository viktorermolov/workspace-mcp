import { createHash, randomBytes } from 'node:crypto';
import { type BrowserContext, type CDPSession, expect, type Page, request, test } from '@playwright/test';
import { type RunningServer, startServer } from './server.ts';

// One owner, one browser profile with a virtual passkey authenticator, walking through the key flows in order.
test.describe.configure({ mode: 'serial' });

let server: RunningServer;
let context: BrowserContext;
let page: Page;
let cdp: CDPSession;
let authenticatorId = '';
const cspErrors: string[] = [];

test.beforeAll(async ({ browser, contextOptions }, info) => {
  server = await startServer();
  context = await browser.newContext({ ...contextOptions, ...info.project.use, baseURL: server.base });
  page = await context.newPage();
  page.on('console', (m) => {
    if (/Content Security Policy|Refused to/i.test(m.text())) cspErrors.push(m.text());
  });
  cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const added = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  authenticatorId = added.authenticatorId;
});

test.afterAll(async () => {
  await context?.close();
  await server?.stop();
});

const isPhone = () => (page.viewportSize()?.width ?? 1000) < 900;

async function go(name: string) {
  if (isPhone()) {
    const tab = page.locator('nav.tabbar').getByRole('link', { name });
    if (await tab.count()) return tab.click();
    await page.locator('nav.tabbar').getByRole('link', { name: 'More' }).click();
    return page.locator('main').getByRole('link', { name: new RegExp(`^${name}`) }).click();
  }
  return page.locator('nav.sidebar').getByRole('link', { name, exact: true }).click();
}

test('first-time setup registers the owner passkey', async () => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/setup$/);
  await expect(page.getByRole('heading', { name: 'Set up your workspace' })).toBeVisible();
  await page.getByLabel('Setup code').fill('WRONG-CODE-0000');
  await page.getByRole('button', { name: 'Create passkey' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await page.getByLabel('Setup code').fill(server.setupCode);
  await page.getByRole('button', { name: 'Create passkey' }).click();
  await expect(page.getByRole('heading', { name: 'Workspace is ready' })).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page).toHaveURL(/\/connections\?welcome=1/);
  await expect(page.getByText(`${server.base}/mcp`, { exact: true })).toBeVisible();
  const creds = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
  expect(creds.credentials).toHaveLength(1);
});

test('sign out and sign in again with the passkey', async () => {
  await go('More');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto('/tasks');
  await expect(page).toHaveURL(/\/login\?next=%2Ftasks/);
  await page.getByRole('button', { name: 'Sign in with passkey' }).click();
  await expect(page).toHaveURL(/\/tasks$/);
  await expect(page.getByRole('heading', { name: 'Tasks', exact: true })).toBeVisible();
});

test('the empty map explains how to start', async () => {
  await go('Map');
  await expect(page.getByText('No roles yet.')).toBeVisible();
});

test('owner creates roles, a project and a task', async () => {
  for (const name of ['Writer', 'Editor']) {
    await page.goto('/roles/new');
    await page.getByLabel('Name', { exact: true }).fill(name);
    await page.getByLabel('Area of responsibility').fill(`${name} work`);
    await page.getByLabel(/^Instruction/).fill(`You are the ${name.toLowerCase()}.`);
    await page.getByRole('button', { name: 'Create role' }).click();
    await expect(page.getByRole('heading', { name })).toBeVisible();
  }
  await page.getByRole('button', { name: 'Add a link' }).click();
  await page.getByLabel('Role', { exact: true }).selectOption({ label: 'Writer' });
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByLabel('Role', { exact: true })).toHaveValue('writer');

  await page.goto('/projects/new');
  await page.getByLabel('Name', { exact: true }).fill('Website');
  await page.getByLabel('Current focus').fill('Launch page');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('heading', { name: 'Website' })).toBeVisible();

  await page.getByRole('link', { name: 'New task' }).click();
  await page.getByLabel('Title').fill('Draft the intro');
  await page.getByLabel('Role').selectOption({ label: 'Writer' });
  await page.getByRole('button', { name: /^(Create|Save)/ }).click();
  await expect(page.getByRole('heading', { name: 'Draft the intro' })).toBeVisible();

  await go('Map');
  await expect(page.locator('svg.graph')).toBeVisible();
  await expect(page.locator('.card').filter({ hasText: 'Writer' }).getByText('1 open')).toBeVisible();
  await go('Tasks');
  await expect(page.getByText('Draft the intro')).toBeVisible();
});

test('the task list shows what a task waits for under any filter, and Back keeps the filter', async () => {
  await page.goto('/tasks/new');
  await page.getByLabel('Title').fill('Review the intro');
  await page.getByLabel('Role').selectOption({ label: 'Editor' });
  await page.getByRole('button', { name: /^(Create|Save)/ }).click();
  await expect(page.getByRole('heading', { name: 'Review the intro' })).toBeVisible();

  await go('Tasks');
  await page.getByRole('link', { name: /Draft the intro/ }).click();
  await page.getByLabel('Depends on').selectOption({ label: 'Review the intro' });
  const saved = page.waitForResponse((r) => r.url().endsWith('/api/owner/tasks') && r.request().method() === 'POST' && r.ok());
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await saved;

  await go('Tasks');
  const draft = page.locator('li.task').filter({ has: page.locator('.task-title', { hasText: 'Draft the intro' }) });
  await expect(draft.getByText('waits for: Review the intro')).toBeVisible();
  // The task it waits for belongs to another role, so it is outside this filter; the hint stays.
  await page.getByLabel('Role').selectOption({ label: 'Writer' });
  await expect(page).toHaveURL(/\/tasks\?role=writer$/);
  await expect(page.locator('li.task .task-title', { hasText: 'Review the intro' })).toHaveCount(0);
  await expect(draft.getByText('waits for: Review the intro')).toBeVisible();

  await draft.getByRole('link').click();
  await expect(page.getByRole('heading', { name: 'Draft the intro' })).toBeVisible();
  await page.getByRole('link', { name: 'Back', exact: true }).click();
  await expect(page).toHaveURL(/\/tasks\?role=writer$/);
  await expect(page.getByLabel('Role')).toHaveValue('writer');
  await expect(page.locator('li.task .task-title', { hasText: 'Review the intro' })).toHaveCount(0);
});

test('documents keep versions; compare and restore', async () => {
  await page.goto('/documents/new');
  await page.getByLabel('Title').fill('Style guide');
  await page.getByLabel(/^Text/).fill('Short sentences.\nNo jargon.');
  await page.getByRole('button', { name: 'Create document' }).click();
  await expect(page.getByRole('heading', { name: 'Style guide' })).toBeVisible();
  await page.getByRole('button', { name: 'Edit' }).click();
  await page.getByLabel(/^Text/).fill('Short sentences.\nPlain words.');
  await page.getByRole('button', { name: 'Save new version' }).click();
  await expect(page.getByText('Plain words.')).toBeVisible();

  await page.getByRole('link', { name: 'History' }).click();
  await expect(page.getByRole('heading', { name: 'History: Style guide' })).toBeVisible();
  const diff = page.locator('.diff');
  await expect(diff.locator('.diff-line.del')).toContainText('No jargon.');
  await expect(diff.locator('.diff-line.add')).toContainText('Plain words.');
  page.once('dialog', (d) => d.accept());
  await page.locator('.versions li').filter({ hasText: 'v1' }).getByRole('button', { name: 'Restore' }).click();
  await expect(page.locator('.versions li').filter({ hasText: 'v3' }).getByText('current')).toBeVisible();
  await page.getByRole('link', { name: 'Back', exact: true }).click();
  await expect(page.getByText('No jargon.')).toBeVisible();
});

test('working rules are edited and versioned', async () => {
  await page.goto('/rules');
  await page.getByLabel(/^Rules/).fill('Write in English on GitHub.');
  await page.getByRole('button', { name: 'Save new version' }).click();
  await expect(page.getByLabel(/^Rules · version 1/)).toBeVisible();
});

/** PKCE authorization request for a client registered through dynamic registration. */
async function newAuthorization(redirect: string) {
  // Discovery and registration come from the platform's server, without the owner's browser cookies.
  const platform = await request.newContext({ baseURL: server.base });
  const meta = await (await platform.get('/.well-known/oauth-authorization-server')).json();
  const reg = await platform.post(meta.registration_endpoint, {
    data: { client_name: 'Test Agent', redirect_uris: [redirect], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' },
  });
  expect(reg.ok(), `registration failed: ${reg.status()} ${await reg.text()}`).toBeTruthy();
  const client = await reg.json();
  await platform.dispose();
  const verifier = randomBytes(32).toString('base64url');
  const u = new URL(meta.authorization_endpoint);
  u.search = new URLSearchParams({
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: redirect,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    state: 'st-1',
    scope: 'openid offline_access',
    resource: `${server.base}/mcp`,
  }).toString();
  return { url: u.toString(), clientId: client.client_id as string };
}

async function approveAndCatchRedirect(name: string, redirect: string) {
  await expect(page.getByRole('heading', { name: 'Connect a platform' })).toBeVisible();
  await expect(page.getByText('Test Agent')).toBeVisible();
  await expect(page.locator('dl.facts')).toContainText('127.0.0.1:9');
  await page.getByLabel('Name this connection').fill(name);
  const back = page.waitForRequest((r) => r.url().startsWith(redirect));
  await page.route(`${redirect}**`, (r) => r.fulfill({ status: 200, body: 'ok' }));
  await page.getByRole('button', { name: 'Approve' }).click();
  const url = new URL((await back).url());
  // Wait until the browser has landed on the platform's callback, so the next test's navigation
  // cannot be interrupted by this redirect still finishing.
  await page.waitForURL((u) => u.href.startsWith(redirect));
  expect(url.searchParams.get('code')).toBeTruthy();
  expect(url.searchParams.get('state')).toBe('st-1');
}


async function connectReviewsAgent(name: string): Promise<{ token: string; clientId: string }> {
  const redirect = 'http://127.0.0.1:9/reviews-callback';
  const platform = await request.newContext({ baseURL: server.base });
  const meta = await (await platform.get('/.well-known/oauth-authorization-server')).json();
  const reg = await platform.post(meta.registration_endpoint, {
    data: { client_name: 'Reviews Agent', redirect_uris: [redirect], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' },
  });
  expect(reg.ok(), `registration failed: ${reg.status()} ${await reg.text()}`).toBeTruthy();
  const client = await reg.json();
  const verifier = randomBytes(32).toString('base64url');
  const u = new URL(meta.authorization_endpoint);
  u.search = new URLSearchParams({
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: redirect,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    state: 'st-reviews',
    scope: 'openid offline_access',
    resource: `${server.base}/mcp`,
  }).toString();
  await page.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => undefined);
  await page.goto(u.toString());
  await expect(page.getByRole('heading', { name: 'Connect a platform' })).toBeVisible();
  await page.getByLabel('Name this connection').fill(name);
  const back = page.waitForRequest((r) => r.url().startsWith(redirect));
  await page.route(`${redirect}**`, (r) => r.fulfill({ status: 200, body: 'ok' }));
  await page.getByRole('button', { name: 'Approve' }).click();
  const url = new URL((await back).url());
  await page.waitForURL((loc) => loc.href.startsWith(redirect), { timeout: 5_000 }).catch(() => undefined);
  const code = url.searchParams.get('code');
  expect(code).toBeTruthy();
  const tok = await platform.post(meta.token_endpoint, {
    form: {
      grant_type: 'authorization_code',
      code: code!,
      redirect_uri: redirect,
      client_id: client.client_id,
      code_verifier: verifier,
      resource: `${server.base}/mcp`,
    },
  });
  expect(tok.ok(), `token failed: ${tok.status()} ${await tok.text()}`).toBeTruthy();
  const tokens = await tok.json();
  await platform.dispose();
  return { token: tokens.access_token as string, clientId: client.client_id as string };
}

function parseMcpJson(raw: string): any {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) return JSON.parse(trimmed);
  const data = trimmed
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trim())
    .filter((l) => l && l !== '[DONE]')
    .pop();
  if (!data) throw new Error(`MCP response was not JSON: ${trimmed.slice(0, 400)}`);
  return JSON.parse(data);
}

async function mcpCall(token: string, name: string, args: Record<string, unknown>) {
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
    'mcp-protocol-version': '2025-06-18',
  };
  const readBody = async (res: Response) => {
    const ct = res.headers.get('content-type') ?? '';
    if (!ct.includes('event-stream') || !res.body) return res.text();
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const { done, value } = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((resolve) => setTimeout(() => resolve({ done: true, value: undefined }), Math.max(1, deadline - Date.now()))),
      ]);
      if (value) buf += dec.decode(value, { stream: !done });
      if (done || buf.includes('\n\n')) break;
    }
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
    return buf;
  };
  const rpc = async (id: number | null, method: string, params?: unknown) => {
    return fetch(`${server.base}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', ...(id != null ? { id } : {}), method, params }),
      signal: AbortSignal.timeout(10_000),
    });
  };
  const init = await rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e-agent', version: '1.0.0' } });
  const initText = await readBody(init);
  expect(init.ok, `MCP initialize failed: ${init.status} ${initText}`).toBeTruthy();
  const session = init.headers.get('mcp-session-id');
  if (session) headers['mcp-session-id'] = session;
  await rpc(null, 'notifications/initialized').catch(() => undefined);
  const call = await rpc(2, 'tools/call', { name, arguments: args });
  const raw = await readBody(call);
  expect(call.ok, `MCP tools/call failed: ${call.status} ${raw}`).toBeTruthy();
  const body = parseMcpJson(raw);
  const result = body.result ?? body;
  const text = (result.content as { type: string; text: string }[] | undefined)?.map((c) => c.text).join('') ?? JSON.stringify(result);
  if (result.isError) throw new Error(text);
  return JSON.parse(text);
}

test('an AI platform connects through the consent screen', async () => {
  const redirect = 'http://127.0.0.1:9/callback';
  const { url } = await newAuthorization(redirect);
  await page.goto(url);
  await approveAndCatchRedirect('Agent on my phone', redirect);
  await page.goto('/connections');
  await expect(page.locator('.list li').filter({ hasText: 'Agent on my phone' })).toBeVisible();
});

test('a connection name typed as soon as the consent screen shows is kept', async () => {
  const redirect = 'http://127.0.0.1:9/early';
  const { url } = await newAuthorization(redirect);
  // Hold the client details so the name field can be typed into in the very moment it appears,
  // before the screen has run anything after showing it.
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route('**/api/owner/consent/client**', async (r) => {
    await held;
    await r.continue();
  });
  await page.goto(url);
  await page.evaluate(() => {
    new MutationObserver((_, observer) => {
      const input = document.querySelector<HTMLInputElement>('input[placeholder="For example: Claude on my phone"]');
      if (!input) return;
      observer.disconnect();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Typed right away');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }).observe(document.body, { childList: true, subtree: true });
  });
  release();
  const field = page.getByLabel('Name this connection');
  await expect(field).toHaveValue('Typed right away');
  // Let every deferred update of the screen run, then check the typed name survived them.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 100))));
  await expect(field).toHaveValue('Typed right away');
  await page.unroute('**/api/owner/consent/client**');
  const back = page.waitForRequest((r) => r.url().startsWith(redirect));
  await page.route(`${redirect}**`, (r) => r.fulfill({ status: 200, body: 'ok' }));
  await page.getByRole('button', { name: 'Approve' }).click();
  await back;
  await page.waitForURL((u) => u.href.startsWith(redirect));
  await page.goto('/connections');
  await expect(page.locator('.list li').filter({ hasText: 'Typed right away' })).toBeVisible();
});

test('a signed-out authorization goes through sign-in to consent', async () => {
  await go('More');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login$/);
  const redirect = 'http://127.0.0.1:9/second';
  const { url } = await newAuthorization(redirect);
  await page.goto(url);
  await expect(page).toHaveURL(/\/login\?.*sig=/);
  await expect(page.getByText('An AI platform asks to connect')).toBeVisible();
  await page.getByRole('button', { name: 'Sign in with passkey' }).click();
  await expect(page).toHaveURL(/\/consent\?/);
  await approveAndCatchRedirect('Second agent', redirect);
});

test('connections can be revoked', async () => {
  await page.goto('/connections');
  const row = page.locator('.list li').filter({ hasText: 'Second agent' });
  page.once('dialog', (d) => d.accept());
  await row.getByRole('button', { name: 'Revoke' }).click();
  await expect(page.getByRole('heading', { name: 'Revoked' })).toBeVisible();
});

test('passkeys, backups and export screens work', async () => {
  await page.goto('/passkeys');
  await expect(page.locator('.list li')).toHaveCount(1);
  await page.getByRole('button', { name: 'Add on another device' }).click();
  await expect(page.getByText('One-time code')).toBeVisible();

  await page.goto('/data');
  await page.getByRole('button', { name: 'Back up now' }).click();
  await expect(page.getByText(/Backup .* created\./)).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'Download export' }).click()]);
  expect(download.suggestedFilename()).toMatch(/^workspace-export-\d{4}-\d{2}-\d{2}\.zip$/);
});

test('log shows owner actions and the theme can be switched', async () => {
  await page.goto('/log');
  await expect(page.locator('.log li').first()).toBeVisible();
  await expect(page.locator('.log')).toContainText('Style guide');
  await page.goto('/more');
  await page.getByRole('radio', { name: 'Dark' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('radio', { name: 'System' }).click();
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.+/);
});

test('a temporary server error while loading shows a message and a way to try again', async () => {
  await page.route('**/api/owner/me', (r) => r.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"unavailable","message":"Service is restarting"}' }));
  await page.goto('/tasks');
  await expect(page.getByRole('alert')).toContainText('Service is restarting');
  await page.unroute('**/api/owner/me');
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('heading', { name: 'Tasks' })).toBeVisible();
  await expect(page).toHaveURL(/\/tasks$/);
});

test('reading pages, history and compare work at 390×844', async () => {
  const previous = page.viewportSize();
  await page.setViewportSize({ width: 390, height: 844 });

  await page.goto('/documents/new');
  await page.getByLabel('Title').fill('Reading sample');
  await page.getByLabel(/^Text/).fill(
    [
      '# Sample heading',
      '',
      'See [Example](https://example.com/ok) and [bad](javascript:alert(1)).',
      '',
      'An image: ![Diagram](https://example.com/pic.png)',
      '',
      '| Col | Val |',
      '| --- | --- |',
      '| A | 1 |',
      '',
      '```',
      'const x = 1;',
      '```',
    ].join('\n'),
  );
  await page.getByRole('button', { name: 'Create document' }).click();
  await expect(page.getByRole('heading', { name: 'Reading sample' })).toBeVisible();
  await page.getByRole('link', { name: 'Read', exact: true }).click();
  await expect(page).toHaveURL(/\/read\/document\//);
  await expect(page.getByRole('heading', { name: 'Sample heading' })).toBeVisible();
  const good = page.getByRole('link', { name: 'Example' });
  await expect(good).toHaveAttribute('href', 'https://example.com/ok');
  await expect(good).toHaveAttribute('rel', 'noopener noreferrer nofollow');
  await expect(good).toHaveAttribute('target', '_blank');
  const md = page.locator('.md').first();
  await expect(md.getByRole('link', { name: 'bad' })).toHaveCount(0);
  await expect(md.getByText('bad')).toBeVisible();
  await expect(md.getByRole('img')).toHaveCount(0);
  await expect(md.getByRole('link', { name: 'Diagram' })).toBeVisible();
  await expect(md.locator('table')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Edit', exact: true })).toBeVisible();
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(await overflow()).toBeLessThanOrEqual(1);
  await expect(page.locator('.read-layout')).toHaveCSS('display', 'block');

  await page.goto('/read');
  await expect(page.getByRole('heading', { name: 'Reading', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: /Working rules/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /Reading sample/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /Style guide/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /Website/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /Writer/ })).toBeVisible();
  expect(await overflow()).toBeLessThanOrEqual(1);

  await page.getByRole('link', { name: /Style guide/ }).click();
  await expect(page).toHaveURL(/\/read\/document\//);
  await expect(page.locator('.md').getByText('No jargon.')).toBeVisible();
  const history = page.locator('#history');
  await expect(history.getByRole('heading', { name: 'History' })).toBeVisible();
  await expect(history.locator('.diff-line.del, .diff-line.add').first()).toBeVisible();
  await history.getByRole('link', { name: 'Open', exact: true }).first().click();
  await expect(page).toHaveURL(/[?&]v=/);
  await expect(page.getByText(/You are viewing version/)).toBeVisible();
  await page.getByRole('link', { name: 'Open the current version' }).click();
  await expect(page).not.toHaveURL(/[?&]v=/);
  await expect(page.locator('.md').getByText('No jargon.')).toBeVisible();
  expect(await overflow()).toBeLessThanOrEqual(1);

  await page.goto('/rules');
  await page.getByRole('link', { name: 'Read', exact: true }).click();
  await expect(page).toHaveURL(/\/read\/rules$/);
  await expect(page.locator('.md').getByText('Write in English on GitHub.')).toBeVisible();
  await page.getByRole('link', { name: 'Edit', exact: true }).click();
  await expect(page).toHaveURL(/\/rules$/);

  if (previous) await page.setViewportSize(previous);
});


test('review comments work at 390×844', async () => {
  test.setTimeout(90_000);
  const previous = page.viewportSize();
  await page.setViewportSize({ width: 390, height: 844 });

  await page.goto('/documents/new');
  await page.getByLabel('Title').fill('Comments sample');
  await page.getByLabel('Belongs to').selectOption({ label: 'role Writer' });
  await page.getByLabel(/^Text/).fill('Please greet the reader by name.\n\nKeep the closing short.');
  await page.getByRole('button', { name: 'Create document' }).click();
  await expect(page.getByRole('heading', { name: 'Comments sample' })).toBeVisible();
  await page.getByRole('link', { name: 'Read', exact: true }).click();
  await expect(page).toHaveURL(/\/read\/document\//);
  const block = page.locator('.md-commentable [data-lines]').filter({ hasText: 'Please greet the reader by name.' }).first();
  await expect(block).toBeVisible();
  await block.click();
  await page.getByLabel('Your comment').fill('Please use the reader\'s name in the greeting.');
  await page.getByRole('button', { name: 'Add comment' }).click();
  await expect(page.locator('.review-card .review-body').getByText('Please use the reader\'s name in the greeting.')).toBeVisible();
  await expect(page.locator('.review-card').getByText('open', { exact: true })).toBeVisible();

  const id = await page.locator('.review-card').first().getAttribute('id');
  expect(id).toBeTruthy();
  const readUrl = page.url();
  const { token } = await connectReviewsAgent('Comments bot');
  const replied = await mcpCall(token, 'reply_review_comment', { id, body: 'Done — the greeting now uses the name.', status: 'answered', claimed_role: 'writer' });
  expect(replied.status).toBe('answered');

  await page.goto(readUrl);
  await expect(page.locator('.review-card').getByText('answered', { exact: true })).toBeVisible();
  await expect(page.locator('.review-card').getByText('Done — the greeting now uses the name.')).toBeVisible();

  // Re-anchor runs on open and answered comments (resolved ones stay as they were).
  await page.getByRole('link', { name: 'Edit', exact: true }).click();
  await expect(page).toHaveURL(/\/documents\//);
  await page.getByRole('button', { name: 'Edit' }).click();
  await page.getByLabel(/^Text/).fill('A completely different document with no overlapping sentences.');
  await page.getByRole('button', { name: 'Save new version' }).click();
  await page.getByRole('link', { name: 'Read', exact: true }).click();
  await expect(page.locator('.review-card').getByText('outdated')).toBeVisible();
  await expect(page.locator('.review-card').getByText('answered', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'All' }).click();
  await page.locator('.review-card').getByRole('button', { name: 'Resolve' }).click();
  await expect(page.locator('.review-card').getByText('resolved', { exact: true })).toBeVisible();
  await expect(page.locator('.review-card').getByText('outdated')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);

  if (previous) await page.setViewportSize(previous);
});

test('navigation fits the screen and the page breaks no content security rule', async () => {
  await page.goto('/');
  if (isPhone()) {
    await expect(page.locator('nav.tabbar')).toBeVisible();
    await expect(page.locator('nav.sidebar')).toBeHidden();
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(await overflow()).toBeLessThanOrEqual(1);
    // The More screen shows long addresses (MCP endpoint, source code); they must wrap, not widen the page.
    await go('More');
    await expect(page.getByRole('link', { name: /github\.com/ })).toBeVisible();
    expect(await overflow()).toBeLessThanOrEqual(1);
  } else {
    await expect(page.locator('nav.sidebar')).toBeVisible();
    await expect(page.locator('nav.tabbar')).toBeHidden();
  }
  expect(cspErrors).toEqual([]);
});
