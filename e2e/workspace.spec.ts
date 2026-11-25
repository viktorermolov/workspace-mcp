import { createHash, randomBytes } from 'node:crypto';
import { type BrowserContext, type CDPSession, expect, type Page, test } from '@playwright/test';
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
  await page.getByRole('link', { name: 'Back' }).click();
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
  const meta = await (await page.request.get('/.well-known/oauth-authorization-server')).json();
  const reg = await page.request.post(meta.registration_endpoint, {
    data: { client_name: 'Test Agent', redirect_uris: [redirect], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' },
  });
  expect(reg.ok()).toBeTruthy();
  const client = await reg.json();
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
  expect(url.searchParams.get('code')).toBeTruthy();
  expect(url.searchParams.get('state')).toBe('st-1');
}

test('an AI platform connects through the consent screen', async () => {
  const redirect = 'http://127.0.0.1:9/callback';
  const { url } = await newAuthorization(redirect);
  await page.goto(url);
  await approveAndCatchRedirect('Agent on my phone', redirect);
  await page.goto('/connections');
  await expect(page.locator('.list li').filter({ hasText: 'Agent on my phone' })).toBeVisible();
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

test('navigation fits the screen and the page breaks no content security rule', async () => {
  await page.goto('/');
  if (isPhone()) {
    await expect(page.locator('nav.tabbar')).toBeVisible();
    await expect(page.locator('nav.sidebar')).toBeHidden();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  } else {
    await expect(page.locator('nav.sidebar')).toBeVisible();
    await expect(page.locator('nav.tabbar')).toBeHidden();
  }
  expect(cspErrors).toEqual([]);
});
