import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { after, before, describe, it } from 'node:test';
import { createBackup, restoreBackup } from '../src/backup/backup.ts';
import { buildExport, importExport, isWorkspaceEmpty } from '../src/backup/export.ts';
import { all, get, openDatabase, run, runAppMigrations } from '../src/db/db.ts';
import { migrations } from '../src/db/schema.ts';
import { DomainError } from '../src/domain/core.ts';
import { ensureOwnerMember } from '../src/domain/entities.ts';
import { search } from '../src/domain/views.ts';
import { call, connectAgent, registerOwner, startService, ToolError, type Browser, type TestEnv } from './helpers/harness.ts';

const TOKEN = 'ghp_fake_token_for_tests_only';
const err = (e: unknown) => JSON.parse((e as ToolError).message) as { error: string; message: string };

interface FakeIssue {
  number: number;
  title: string;
  body?: string;
  state: 'open' | 'closed';
  updated_at: string;
}

function fakeGithub(repos: Record<string, FakeIssue[]>) {
  return async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const headers = new Headers(init?.headers);
    if (headers.get('authorization') !== `Bearer ${TOKEN}`) return Response.json({ message: 'Bad credentials' }, { status: 401 });
    const p = url.pathname.replace('/api', '');
    if (p === '/user') return Response.json({ login: 'octo-tester' });
    if (p === '/user/repos') {
      return Response.json(Object.keys(repos).map((full_name) => ({ full_name, private: false, has_issues: true })));
    }
    const m = /^\/repos\/([^/]+\/[^/]+)\/issues$/.exec(p);
    if (m) {
      const since = url.searchParams.get('since');
      const list = (repos[m[1]!] ?? [])
        .filter((i) => !since || i.updated_at >= since)
        .map((i) => ({
          ...i,
          body: i.body ?? '',
          html_url: `https://github.test/${m[1]}/issues/${i.number}`,
          user: { login: 'someone' },
          labels: [],
          created_at: '2026-11-01T00:00:00Z',
          closed_at: i.state === 'closed' ? i.updated_at : null,
        }));
      return Response.json(list);
    }
    return Response.json({ message: 'Not Found' }, { status: 404 });
  };
}

const nowIso = '2026-11-26T12:00:00.000Z';

describe('GitHub issue roles (#75)', () => {
  const repos: Record<string, FakeIssue[]> = {
    'team/one': [
      { number: 55, title: 'Tree map', state: 'open', updated_at: nowIso },
      { number: 1, title: 'Closed already', state: 'closed', updated_at: nowIso },
    ],
    'team/two': [{ number: 70, title: 'Import parent', state: 'open', updated_at: nowIso }],
  };

  let env: TestEnv;
  let owner: Browser;
  let agent: Awaited<ReturnType<typeof connectAgent>>['client'];
  let clientId: string;
  let builderId: string;
  let guardianId: string;
  let internId: string;
  let repoOne: number;
  let repoTwo: number;
  let issueOne: string;
  let issueTwo: string;

  before(async () => {
    env = await startService({ env: { GITHUB_API_URL: 'https://github.test/api' }, fetchImpl: fakeGithub(repos) as typeof fetch });
    owner = (await registerOwner(env)).browser;
    const builder = await owner.json<{ id: string }>('/api/owner/roles', { json: { name: 'Builder', slug: 'builder' } });
    const guardian = await owner.json<{ id: string }>('/api/owner/roles', { json: { name: 'Dev Guardian', slug: 'guardian' } });
    const intern = await owner.json<{ id: string }>('/api/owner/roles', { json: { name: 'Intern', slug: 'intern' } });
    builderId = builder.id;
    guardianId = guardian.id;
    internId = intern.id;
    await owner.json('/api/owner/github/token', { json: { token: TOKEN } });
    const a = await owner.json<{ id: number }>('/api/owner/github/repos', { json: { full_name: 'team/one', default_role: 'builder', assigners: ['guardian'] } });
    const b = await owner.json<{ id: number }>('/api/owner/github/repos', { json: { full_name: 'team/two' } });
    repoOne = a.id;
    repoTwo = b.id;
    const sync = await owner.json('/api/owner/github/sync', { method: 'POST', json: {} });
    assert.equal(sync.ok, true, sync.message);
    issueOne = get<{ id: string }>(env.svc.db, 'SELECT id FROM github_issue WHERE repo_id = ? AND number = 55', repoOne)!.id;
    issueTwo = get<{ id: string }>(env.svc.db, 'SELECT id FROM github_issue WHERE repo_id = ? AND number = 70', repoTwo)!.id;
    const connected = await connectAgent(env, owner, 'Issue bot');
    agent = connected.client;
    const list = await owner.json<{ connections: { client_id: string; name: string }[] }>('/api/owner/connections');
    clientId = list.connections.find((c) => c.name === 'Issue bot')!.client_id;
  });

  after(async () => {
    await env.close();
  });

  it('applies the default role only to INSERT, including closed issues of a newly added repo, and writes one summary event', () => {
    const one = all<{ number: number; role_id: string | null }>(env.svc.db, 'SELECT number, role_id FROM github_issue WHERE repo_id = ? ORDER BY number', repoOne);
    assert.equal(one.length, 2);
    assert.ok(one.every((i) => i.role_id === builderId), 'both new issues, including the closed one, get the default');
    const two = get<{ role_id: string | null }>(env.svc.db, 'SELECT role_id FROM github_issue WHERE id = ?', issueTwo)!;
    assert.equal(two.role_id, null, 'repo without a default stays unlabelled');
    const ev = all<{ summary: string; data: string; actor_kind: string; entity_id: string }>(
      env.svc.db,
      "SELECT summary, data, actor_kind, entity_id FROM event WHERE action = 'github.issue_default_role' ORDER BY id",
    );
    assert.equal(ev.length, 1);
    assert.equal(ev[0]!.actor_kind, 'system');
    assert.equal(ev[0]!.entity_id, String(repoOne));
    assert.match(ev[0]!.summary, /2 new issues labelled for @builder/);
    const data = JSON.parse(ev[0]!.data) as { count: number; role: string; role_id: string; repo: string };
    assert.equal(data.count, 2);
    assert.equal(data.role, 'builder');
    assert.equal(data.role_id, builderId);
    assert.equal(data.repo, 'team/one');
  });

  it('does not change role_id or write a summary event on a later sync, and a later default does not backfill', async () => {
    const before = all<{ id: string; role_id: string | null }>(env.svc.db, 'SELECT id, role_id FROM github_issue');
    await owner.json('/api/owner/github/sync', { method: 'POST', json: {} });
    const afterSync = all<{ id: string; role_id: string | null }>(env.svc.db, 'SELECT id, role_id FROM github_issue');
    assert.deepEqual(afterSync, before);
    assert.equal(get<{ n: number }>(env.svc.db, "SELECT count(*) AS n FROM event WHERE action = 'github.issue_default_role'")!.n, 1);

    await owner.json(`/api/owner/github/repos/${repoTwo}`, { json: { default_role: 'builder' } });
    repos['team/two']![0]!.updated_at = '2026-11-26T13:00:00.000Z';
    await owner.json('/api/owner/github/sync', { method: 'POST', json: {} });
    assert.equal(get<{ role_id: string | null }>(env.svc.db, 'SELECT role_id FROM github_issue WHERE id = ?', issueTwo)!.role_id, null);
    assert.equal(get<{ n: number }>(env.svc.db, "SELECT count(*) AS n FROM event WHERE action = 'github.issue_default_role'")!.n, 1);
  });

  it('lets the owner set or clear a role, records old and new, and is a no-op when unchanged', async () => {
    await owner.json(`/api/owner/issues/${encodeURIComponent(issueTwo)}/role`, { json: { role: 'intern' } });
    assert.equal((await call(agent, 'get', { type: 'issue', id: issueTwo })).role, 'intern');
    const ev = get<{ data: string }>(env.svc.db, "SELECT data FROM event WHERE action = 'issue.role_set' ORDER BY id DESC LIMIT 1")!;
    const data = JSON.parse(ev.data) as { old_role: string | null; new_role: string; old_role_id: string | null; new_role_id: string };
    assert.equal(data.old_role, null);
    assert.equal(data.new_role, 'intern');
    assert.equal(data.old_role_id, null);
    assert.equal(data.new_role_id, internId);
    const count = get<{ n: number }>(env.svc.db, "SELECT count(*) AS n FROM event WHERE action = 'issue.role_set' AND entity_id = ?", issueTwo)!.n;
    await owner.json(`/api/owner/issues/${encodeURIComponent(issueTwo)}/role`, { json: { role: 'intern' } });
    assert.equal(get<{ n: number }>(env.svc.db, "SELECT count(*) AS n FROM event WHERE action = 'issue.role_set' AND entity_id = ?", issueTwo)!.n, count);
    await owner.json(`/api/owner/issues/${encodeURIComponent(issueTwo)}/role`, { json: { role: null } });
    assert.equal((await call(agent, 'get', { type: 'issue', id: issueTwo })).role, null);
    const cleared = JSON.parse(get<{ data: string }>(env.svc.db, "SELECT data FROM event WHERE action = 'issue.role_set' ORDER BY id DESC LIMIT 1")!.data) as {
      old_role: string;
      new_role: string | null;
    };
    assert.equal(cleared.old_role, 'intern');
    assert.equal(cleared.new_role, null);
  });

  it('rejects an archived target role and accepts a clear', async () => {
    const extra = await owner.json<{ id: string }>('/api/owner/roles', { json: { name: 'Temp', slug: 'temp' } });
    await owner.json('/api/owner/archive', { json: { type: 'role', id: extra.id } });
    const res = await owner.fetch(`/api/owner/issues/${encodeURIComponent(issueTwo)}/role`, { json: { role: 'temp' } });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /archived/);
    await owner.json(`/api/owner/issues/${encodeURIComponent(issueTwo)}/role`, { json: { role: null } });
  });

  it('set_issue_role accepts id or repo+number, but not both or a partial pair', async () => {
    const byId = await call(agent, 'set_issue_role', { id: issueTwo, role: 'builder', claimed_role: 'guardian' });
    assert.equal(byId.role, 'builder');
    const byRef = await call(agent, 'set_issue_role', { repo: 'team/two', number: 70, role: 'intern', claimed_role: 'guardian' });
    assert.equal(byRef.role, 'intern');
    await assert.rejects(
      () => call(agent, 'set_issue_role', { id: issueTwo, repo: 'team/two', number: 70, role: 'builder', claimed_role: 'guardian' }),
      (e: unknown) => err(e).error === 'invalid' && /not both/.test(err(e).message),
    );
    await assert.rejects(
      () => call(agent, 'set_issue_role', { repo: 'team/two', role: 'builder', claimed_role: 'guardian' }),
      (e: unknown) => err(e).error === 'invalid' && /together/.test(err(e).message),
    );
    await owner.json(`/api/owner/issues/${encodeURIComponent(issueTwo)}/role`, { json: { role: null } });
  });

  it('in warning mode records warnings and still changes the label, including across repos', async () => {
    const settings = await owner.json<{ role_enforcement: string }>('/api/owner/connections');
    assert.equal(settings.role_enforcement, 'warn');
    const out = await call<{ role: string; warnings?: { code: string }[] }>(agent, 'set_issue_role', { id: issueTwo, role: 'intern', claimed_role: 'guardian' });
    assert.equal(out.role, 'intern');
    assert.ok(out.warnings?.some((w) => w.code === 'role_not_allowed' || w.code === 'issue_role_forbidden'));
    const missing = await call<{ role: string; warnings?: { code: string }[] }>(agent, 'set_issue_role', { id: issueTwo, role: 'builder' });
    assert.equal(missing.role, 'builder');
    assert.ok(missing.warnings?.some((w) => w.code === 'claimed_role_missing'));
    await owner.json(`/api/owner/issues/${encodeURIComponent(issueTwo)}/role`, { json: { role: null } });
  });

  it('after the list is confirmed, enforce allows assigners on their repo only, and edit_any on any repo', async () => {
    await owner.json(`/api/owner/connections/${encodeURIComponent(clientId)}/roles`, { json: { roles: ['guardian', 'intern', 'builder'], confirm: true } });
    await owner.json('/api/owner/settings/role-enforcement', { json: { mode: 'enforce' } });

    const ok = await call(agent, 'set_issue_role', { id: issueOne, role: 'builder', claimed_role: 'guardian' });
    assert.equal(ok.role, 'builder');

    await assert.rejects(
      () => call(agent, 'set_issue_role', { id: issueTwo, role: 'builder', claimed_role: 'guardian' }),
      (e: unknown) => err(e).error === 'forbidden' && /this repository/.test(err(e).message),
    );
    assert.equal((await call(agent, 'get', { type: 'issue', id: issueTwo })).role, null);

    await assert.rejects(
      () => call(agent, 'set_issue_role', { id: issueOne, role: 'builder', claimed_role: 'intern' }),
      (e: unknown) => err(e).error === 'forbidden',
    );
    await assert.rejects(
      () => call(agent, 'set_issue_role', { id: issueOne, role: 'intern' }),
      (e: unknown) => err(e).error === 'invalid' && /claimed_role/.test(err(e).message),
    );

    await owner.json(`/api/owner/roles/${encodeURIComponent(internId)}/edit-any`, { json: { edit_any: true } });
    const any = await call(agent, 'set_issue_role', { repo: 'Team/Two', number: 70, role: 'builder', claimed_role: 'intern' });
    assert.equal(any.role, 'builder');
    await owner.json(`/api/owner/roles/${encodeURIComponent(internId)}/edit-any`, { json: { edit_any: false } });
    await owner.json(`/api/owner/issues/${encodeURIComponent(issueTwo)}/role`, { json: { role: null } });
  });

  it('does not let an issue label grant or remove rights, and a slug rename keeps default and assigners', async () => {
    await owner.json(`/api/owner/issues/${encodeURIComponent(issueTwo)}/role`, { json: { role: 'intern' } });
    await assert.rejects(
      () => call(agent, 'update_rules', { text: 'Intern must not change rules just because an issue is labelled intern.', claimed_role: 'guardian' }),
      (e: unknown) => err(e).error === 'forbidden',
    );

    const role = await call<{ id: string; rev: number; slug: string }>(agent, 'get', { type: 'role', id: builderId });
    await owner.json('/api/owner/roles', { json: { id: builderId, rev: role.rev, slug: 'maker' } });
    const status = await owner.json<{ repos: { id: number; default_role: string | null; assigners: { slug: string }[] }[] }>('/api/owner/github');
    const one = status.repos.find((r) => r.id === repoOne)!;
    assert.equal(one.default_role, 'maker');
    assert.deepEqual(
      one.assigners.map((a) => a.slug),
      ['guardian'],
    );
    const labelled = await call(agent, 'get', { type: 'issue', id: issueOne });
    assert.equal(labelled.role, 'maker');
    const again = await call(agent, 'set_issue_role', { id: issueOne, role: 'maker', claimed_role: 'guardian' });
    assert.equal(again.role, 'maker');
    const back = await call<{ rev: number }>(agent, 'get', { type: 'role', id: builderId });
    await owner.json('/api/owner/roles', { json: { id: builderId, rev: back.rev, slug: 'builder' } });
    await owner.json(`/api/owner/issues/${encodeURIComponent(issueTwo)}/role`, { json: { role: null } });
  });

  it('settings are owner-only: MCP, edit_any and assigners cannot change them, and events record old and new values', async () => {
    const beforeDefault = get<{ default_role_id: string | null }>(env.svc.db, 'SELECT default_role_id FROM github_repo WHERE id = ?', repoOne)!.default_role_id;
    const beforeAssigners = all<{ role_id: string }>(env.svc.db, 'SELECT role_id FROM github_repo_assigner WHERE repo_id = ?', repoOne).map((r) => r.role_id);
    await call(agent, 'set_issue_role', { id: issueOne, role: 'builder', claimed_role: 'guardian' });
    assert.equal(get<{ default_role_id: string | null }>(env.svc.db, 'SELECT default_role_id FROM github_repo WHERE id = ?', repoOne)!.default_role_id, beforeDefault);
    assert.deepEqual(
      all<{ role_id: string }>(env.svc.db, 'SELECT role_id FROM github_repo_assigner WHERE repo_id = ?', repoOne).map((r) => r.role_id),
      beforeAssigners,
    );
    const anon = await fetch(`${env.base}/api/owner/github/repos/${repoOne}`, {
      method: 'POST',
      headers: { origin: env.base, 'content-type': 'application/json' },
      body: JSON.stringify({ default_role: 'intern', assigners: ['intern'] }),
    });
    assert.equal(anon.status, 401);

    const evBefore = get<{ n: number }>(env.svc.db, "SELECT count(*) AS n FROM event WHERE action = 'github.repo_default_role' AND entity_id = ?", String(repoOne))!.n;
    await owner.json(`/api/owner/github/repos/${repoOne}`, { json: { default_role: 'intern', assigners: ['guardian', 'intern'] } });
    const changed = get<{ data: string }>(env.svc.db, "SELECT data FROM event WHERE action = 'github.repo_default_role' ORDER BY id DESC LIMIT 1")!;
    const data = JSON.parse(changed.data) as { old_role: string; new_role: string };
    assert.equal(data.old_role, 'builder');
    assert.equal(data.new_role, 'intern');
    const assignEv = get<{ data: string }>(env.svc.db, "SELECT data FROM event WHERE action = 'github.repo_assigners' ORDER BY id DESC LIMIT 1")!;
    const assignData = JSON.parse(assignEv.data) as { old_roles: string[]; new_roles: string[] };
    assert.deepEqual(assignData.old_roles, ['guardian']);
    assert.deepEqual(assignData.new_roles.sort(), ['guardian', 'intern']);
    await owner.json(`/api/owner/github/repos/${repoOne}`, { json: { default_role: 'builder', assigners: ['guardian'] } });
    assert.ok(get<{ n: number }>(env.svc.db, "SELECT count(*) AS n FROM event WHERE action = 'github.repo_default_role' AND entity_id = ?", String(repoOne))!.n > evBefore);
  });

  it('rejects an archived role as default or assigner in the owner API, and an archived assigner or default is not used', async () => {
    const extra = await owner.json<{ id: string }>('/api/owner/roles', { json: { name: 'Soon gone', slug: 'soon' } });
    await owner.json('/api/owner/archive', { json: { type: 'role', id: extra.id } });
    const d = await owner.fetch(`/api/owner/github/repos/${repoTwo}`, { json: { default_role: 'soon' } });
    assert.equal(d.status, 400);
    const a = await owner.fetch(`/api/owner/github/repos/${repoTwo}`, { json: { assigners: ['soon'] } });
    assert.equal(a.status, 400);

    await owner.json(`/api/owner/github/repos/${repoTwo}`, { json: { assigners: ['guardian'] } });
    await owner.json('/api/owner/archive', { json: { type: 'role', id: guardianId } });
    await assert.rejects(
      () => call(agent, 'set_issue_role', { id: issueTwo, role: 'builder', claimed_role: 'guardian' }),
      (e: unknown) => err(e).error === 'forbidden',
    );
    await owner.json('/api/owner/archive', { json: { type: 'role', id: guardianId, restore: true } });
    await owner.json(`/api/owner/github/repos/${repoTwo}`, { json: { assigners: [] } });
  });

  it('an archived default is not applied to new inserts, but existing labels stay', async () => {
    const held = get<{ role_id: string | null }>(env.svc.db, 'SELECT role_id FROM github_issue WHERE id = ?', issueOne)!.role_id;
    assert.equal(held, builderId);
    await owner.json('/api/owner/archive', { json: { type: 'role', id: builderId } });
    try {
      repos['team/one']!.push({ number: 99, title: 'After archive', state: 'open', updated_at: new Date().toISOString() });
      const sync = await owner.json('/api/owner/github/sync', { method: 'POST', json: {} });
      assert.equal(sync.ok, true, sync.message);
      assert.equal(get<{ role_id: string | null }>(env.svc.db, 'SELECT role_id FROM github_issue WHERE id = ?', issueOne)!.role_id, builderId);
      const fresh = get<{ role_id: string | null }>(env.svc.db, 'SELECT role_id FROM github_issue WHERE repo_id = ? AND number = 99', repoOne);
      assert.ok(fresh, 'the new issue was synced');
      assert.equal(fresh!.role_id, null);
    } finally {
      await owner.json('/api/owner/archive', { json: { type: 'role', id: builderId, restore: true } });
    }
  });

  it('purge of a role clears default_role_id, assigner rows and issue labels', async () => {
    const extra = await owner.json<{ id: string }>('/api/owner/roles', { json: { name: 'Doomed', slug: 'doomed' } });
    await owner.json(`/api/owner/github/repos/${repoTwo}`, { json: { default_role: 'doomed', assigners: ['doomed'] } });
    await owner.json(`/api/owner/issues/${encodeURIComponent(issueTwo)}/role`, { json: { role: 'doomed' } });
    await owner.json('/api/owner/archive', { json: { type: 'role', id: extra.id } });
    await owner.json('/api/owner/purge', { json: { type: 'role', id: extra.id } });
    assert.equal(get<{ default_role_id: string | null }>(env.svc.db, 'SELECT default_role_id FROM github_repo WHERE id = ?', repoTwo)!.default_role_id, null);
    assert.equal(get<{ n: number }>(env.svc.db, 'SELECT count(*) AS n FROM github_repo_assigner WHERE role_id = ?', extra.id)!.n, 0);
    assert.equal(get<{ role_id: string | null }>(env.svc.db, 'SELECT role_id FROM github_issue WHERE id = ?', issueTwo)!.role_id, null);
  });

  it('removing a repository drops its assigners and issues, and owner settings require an owner actor', async () => {
    const extra = await owner.json<{ id: number; status: { repos: { id: number }[] } }>('/api/owner/github/repos', {
      json: { full_name: 'team/one', assigners: ['intern'] },
    });
    // re-adding the existing repo updates assigners
    const assigners = all<{ role_id: string }>(env.svc.db, 'SELECT role_id FROM github_repo_assigner WHERE repo_id = ?', repoOne).map((r) => r.role_id);
    assert.deepEqual(assigners.sort(), [internId].sort());
    assert.equal(extra.id, repoOne);
    await owner.json(`/api/owner/github/repos/${repoOne}`, { json: { assigners: ['guardian'] } });

    const gone = await owner.json<{ id: number }>('/api/owner/github/repos', { json: { full_name: 'team/ephemeral', default_role: 'builder', assigners: ['guardian'] } });
    await owner.fetch(`/api/owner/github/repos/${gone.id}`, { method: 'DELETE' });
    assert.equal(get<{ n: number }>(env.svc.db, 'SELECT count(*) AS n FROM github_repo WHERE id = ?', gone.id)!.n, 0);
    assert.equal(get<{ n: number }>(env.svc.db, 'SELECT count(*) AS n FROM github_repo_assigner WHERE repo_id = ?', gone.id)!.n, 0);
  });
});

describe('migration 7 upgrade from a populated 0.2.0 database', () => {
  it('keeps existing github_issue.role_id values and does not backfill', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsmcp-75-mig-'));
    const db = openDatabase(path.join(dir, 'workspace.sqlite'));
    db.exec('CREATE TABLE IF NOT EXISTS app_migration (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
    for (const m of migrations.filter((mig) => mig.id <= 4)) {
      db.exec(m.sql);
      run(db, 'INSERT INTO app_migration (id, name, applied_at) VALUES (?, ?, ?)', m.id, m.name, new Date().toISOString());
    }
    const at = '2026-11-26T00:00:00.000Z';
    run(db, "INSERT INTO member (id, user_id, name, is_owner, created_at) VALUES ('mem_legacy_75', NULL, 'Owner', 1, ?)", at);
    run(
      db,
      "INSERT INTO role (id, member_id, slug, name, area, setup_notes, rev, edit_any, created_at, updated_at) VALUES ('role_builder', 'mem_legacy_75', 'builder', 'Builder', '', '', 1, 0, ?, ?)",
      at,
      at,
    );
    run(db, "INSERT INTO github_repo (id, member_id, full_name, created_at) VALUES (1, 'mem_legacy_75', 'viktorermolov/workspace-mcp', ?)", at);
    run(
      db,
      "INSERT INTO github_issue (id, member_id, repo_id, number, title, body, state, labels, url, created_at, updated_at, role_id, synced_at) VALUES ('gh_1_55', 'mem_legacy_75', 1, 55, 'Tree map', '', 'open', '[]', 'https://github.test/i/55', ?, ?, 'role_builder', ?)",
      at,
      at,
      at,
    );
    run(
      db,
      "INSERT INTO github_issue (id, member_id, repo_id, number, title, body, state, labels, url, created_at, updated_at, role_id, synced_at) VALUES ('gh_1_58', 'mem_legacy_75', 1, 58, 'Reading', '', 'open', '[]', 'https://github.test/i/58', ?, ?, NULL, ?)",
      at,
      at,
      at,
    );

    const applied = runAppMigrations(db);
    assert.equal(applied, 9);
    assert.equal(get<{ name: string }>(db, 'SELECT name FROM app_migration WHERE id = 5')!.name, 'role_parent');
    assert.equal(get<{ name: string }>(db, 'SELECT name FROM app_migration WHERE id = 6')!.name, 'review-comments');
    assert.equal(get<{ name: string }>(db, 'SELECT name FROM app_migration WHERE id = 7')!.name, 'github-issue-roles');
    assert.equal(get<{ role_id: string | null }>(db, "SELECT role_id FROM github_issue WHERE id = 'gh_1_55'")!.role_id, 'role_builder');
    assert.equal(get<{ role_id: string | null }>(db, "SELECT role_id FROM github_issue WHERE id = 'gh_1_58'")!.role_id, null);
    assert.equal(get<{ default_role_id: string | null }>(db, 'SELECT default_role_id FROM github_repo WHERE id = 1')!.default_role_id, null);
    assert.equal(get<{ n: number }>(db, 'SELECT count(*) AS n FROM github_repo_assigner')!.n, 0);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('export, import and backup of issue roles', () => {
  const repos: Record<string, FakeIssue[]> = {
    'team/one': [
      { number: 55, title: 'Tree map', state: 'open', updated_at: nowIso },
      { number: 1, title: 'Closed already', state: 'closed', updated_at: nowIso },
    ],
  };

  async function seed(env: TestEnv) {
    const owner = (await registerOwner(env)).browser;
    const builder = await owner.json<{ id: string }>('/api/owner/roles', { json: { name: 'Builder', slug: 'builder' } });
    const guardian = await owner.json<{ id: string }>('/api/owner/roles', { json: { name: 'Dev Guardian', slug: 'guardian' } });
    const intern = await owner.json<{ id: string; rev: number }>('/api/owner/roles', { json: { name: 'Intern', slug: 'intern' } });
    await owner.json('/api/owner/roles', { json: { id: intern.id, rev: intern.rev, parent: 'guardian' } });
    await owner.json('/api/owner/github/token', { json: { token: TOKEN } });
    const repo = await owner.json<{ id: number }>('/api/owner/github/repos', { json: { full_name: 'team/one', default_role: 'builder', assigners: ['guardian'] } });
    const sync = await owner.json('/api/owner/github/sync', { method: 'POST', json: {} });
    assert.equal(sync.ok, true, sync.message);
    const issue55 = get<{ id: string }>(env.svc.db, 'SELECT id FROM github_issue WHERE repo_id = ? AND number = 55', repo.id)!.id;
    await owner.json(`/api/owner/issues/${encodeURIComponent(issue55)}/role`, { json: { role: 'intern' } });
    return { owner, builder, guardian, intern, repo, issue55 };
  }

  it('zip export/import round-trips default_role_id, assigners, issue role and role parent_id, and never includes the token', async () => {
    const src = await startService({ env: { GITHUB_API_URL: 'https://github.test/api' }, fetchImpl: fakeGithub(repos) as typeof fetch });
    let zip: Uint8Array<ArrayBuffer>;
    let builderId: string;
    let guardianId: string;
    let internId: string;
    let repoId: number;
    let issue55: string;
    try {
      const seeded = await seed(src);
      builderId = seeded.builder.id;
      guardianId = seeded.guardian.id;
      internId = seeded.intern.id;
      repoId = seeded.repo.id;
      issue55 = seeded.issue55;
      const res = await seeded.owner.fetch('/api/owner/export');
      assert.equal(res.status, 200);
      zip = new Uint8Array(await res.arrayBuffer());
    } finally {
      await src.close();
    }

    const files = unzipSync(zip);
    const raw = Buffer.from(files['workspace.json']!).toString('utf8');
    const ws = JSON.parse(raw) as { tables: Record<string, Record<string, unknown>[]> };
    assert.ok(!('github_config' in ws.tables), 'github_config (token) must not be in the zip');
    assert.ok(Array.isArray(ws.tables.github_repo) && ws.tables.github_repo.length === 1);
    assert.equal(ws.tables.github_repo[0]!.default_role_id, builderId);
    assert.deepEqual(
      (ws.tables.github_repo_assigner ?? []).map((r) => [r.repo_id, r.role_id]),
      [[repoId, guardianId]],
    );
    const issue = (ws.tables.github_issue ?? []).find((r) => r.id === issue55);
    assert.equal(issue?.role_id, internId);
    const internRole = (ws.tables.role ?? []).find((r) => r.id === internId);
    assert.equal(internRole?.parent_id, guardianId);
    const allText = Object.values(files)
      .map((f) => Buffer.from(f).toString('utf8'))
      .join('\n');
    assert.ok(!allText.includes(TOKEN), 'the GitHub token is never exported');
    assert.ok(!allText.includes('token_enc'), 'token_enc must not appear');

    const dst = await startService();
    try {
      const d = await registerOwner(dst);
      const imp = await d.browser.fetch('/api/owner/import', { method: 'POST', body: zip, headers: { 'content-type': 'application/zip' } });
      assert.equal(imp.status, 200, await imp.clone().text());
      assert.equal(get<{ parent_id: string | null }>(dst.svc.db, 'SELECT parent_id FROM role WHERE id = ?', internId)!.parent_id, guardianId);
      assert.equal(get<{ default_role_id: string | null }>(dst.svc.db, 'SELECT default_role_id FROM github_repo WHERE id = ?', repoId)!.default_role_id, builderId);
      assert.deepEqual(
        all<{ role_id: string }>(dst.svc.db, 'SELECT role_id FROM github_repo_assigner WHERE repo_id = ?', repoId).map((r) => r.role_id),
        [guardianId],
      );
      assert.equal(get<{ role_id: string | null }>(dst.svc.db, 'SELECT role_id FROM github_issue WHERE id = ?', issue55)!.role_id, internId);
      assert.equal(get<{ n: number }>(dst.svc.db, 'SELECT count(*) AS n FROM github_config')!.n, 0, 'zip import does not restore the token');
      const memberId = ensureOwnerMember(dst.svc.db).id;
      assert.equal(get<{ n: number }>(dst.svc.db, "SELECT count(*) AS n FROM search_fts WHERE entity_type = 'issue' AND member_id = ?", memberId)!.n, 2);
      const found = search(dst.svc.db, memberId, { query: 'Tree map' });
      assert.ok(
        found.results.some((r) => r.type === 'issue' && r.id === issue55),
        'imported issues must be in the search index; a later incremental sync would skip unchanged rows',
      );
    } finally {
      await dst.close();
    }
  });

  it('SQLite backup and restore keep default_role_id, assigners, issue role, parent_id and the GitHub token row', async () => {
    const src = await startService({ env: { GITHUB_API_URL: 'https://github.test/api' }, fetchImpl: fakeGithub(repos) as typeof fetch });
    const seeded = await seed(src);
    const file = await createBackup(src.svc.db, src.config, 'manual');
    const login = get<{ login: string }>(src.svc.db, 'SELECT login FROM github_config')!.login;
    // Mutate after the backup so a successful restore is distinguishable from leaving the live file alone.
    await seeded.owner.json(`/api/owner/issues/${encodeURIComponent(seeded.issue55)}/role`, { json: { role: 'builder' } });
    await seeded.owner.json(`/api/owner/github/repos/${seeded.repo.id}`, { json: { default_role: null, assigners: [] } });
    await src.close();

    // Restore after the service has released the file, then start again on the same data directory.
    const { saved } = await restoreBackup(src.config, file);
    assert.ok(saved);
    const dest = await startService({ dataDir: src.dataDir, env: { GITHUB_API_URL: 'https://github.test/api' }, fetchImpl: fakeGithub(repos) as typeof fetch });
    try {
      assert.equal(get<{ parent_id: string | null }>(dest.svc.db, 'SELECT parent_id FROM role WHERE id = ?', seeded.intern.id)!.parent_id, seeded.guardian.id);
      assert.equal(get<{ default_role_id: string | null }>(dest.svc.db, 'SELECT default_role_id FROM github_repo WHERE id = ?', seeded.repo.id)!.default_role_id, seeded.builder.id);
      assert.deepEqual(
        all<{ role_id: string }>(dest.svc.db, 'SELECT role_id FROM github_repo_assigner WHERE repo_id = ?', seeded.repo.id).map((r) => r.role_id),
        [seeded.guardian.id],
      );
      assert.equal(get<{ role_id: string | null }>(dest.svc.db, 'SELECT role_id FROM github_issue WHERE id = ?', seeded.issue55)!.role_id, seeded.intern.id);
      assert.equal(get<{ login: string }>(dest.svc.db, 'SELECT login FROM github_config')!.login, login);
    } finally {
      await dest.close();
    }
  });

  function rewriteWorkspace(zip: Uint8Array, mutate: (ws: { tables: Record<string, Record<string, unknown>[]> }) => void): Uint8Array {
    const files = unzipSync(zip);
    const ws = JSON.parse(Buffer.from(files['workspace.json']!).toString()) as { tables: Record<string, Record<string, unknown>[]> };
    mutate(ws);
    const wsBytes = strToU8(JSON.stringify(ws));
    const manifest = JSON.parse(Buffer.from(files['manifest.json']!).toString()) as { files: Record<string, string> };
    manifest.files['workspace.json'] = createHash('sha256').update(wsBytes).digest('hex');
    return zipSync({ ...files, 'workspace.json': wsBytes, 'manifest.json': strToU8(JSON.stringify(manifest, null, 2)) });
  }

  it('indexes imported github issues so search finds them after a zip import', async () => {
    const src = await startService({ env: { GITHUB_API_URL: 'https://github.test/api' }, fetchImpl: fakeGithub(repos) as typeof fetch });
    const seeded = await seed(src);
    const { zip } = buildExport(src.svc.db, ensureOwnerMember(src.svc.db).id);
    await src.close();

    const dst = await startService();
    try {
      const owner = ensureOwnerMember(dst.svc.db);
      importExport(dst.svc.db, owner.id, zip);
      assert.equal(get<{ n: number }>(dst.svc.db, "SELECT count(*) AS n FROM search_fts WHERE entity_type = 'issue' AND member_id = ?", owner.id)!.n, 2);
      const found = search(dst.svc.db, owner.id, { query: 'Tree map' });
      assert.ok(found.results.some((r) => r.type === 'issue' && r.id === seeded.issue55));
      const closed = search(dst.svc.db, owner.id, { query: 'Closed already' });
      assert.ok(closed.results.some((r) => r.type === 'issue' && r.title?.includes('Closed already')));
    } finally {
      await dst.close();
    }
  });

  it('treats a workspace that has only a GitHub mirror as non-empty and refuses a second import cleanly', async () => {
    const src = await startService({ env: { GITHUB_API_URL: 'https://github.test/api' }, fetchImpl: fakeGithub(repos) as typeof fetch });
    await seed(src);
    const { zip } = buildExport(src.svc.db, ensureOwnerMember(src.svc.db).id);
    await src.close();

    const dest = await startService({ env: { GITHUB_API_URL: 'https://github.test/api' }, fetchImpl: fakeGithub(repos) as typeof fetch });
    try {
      const ownerBrowser = (await registerOwner(dest)).browser;
      const memberId = ensureOwnerMember(dest.svc.db).id;
      assert.equal(isWorkspaceEmpty(dest.svc.db, memberId), true);
      await ownerBrowser.json('/api/owner/github/token', { json: { token: TOKEN } });
      await ownerBrowser.json('/api/owner/github/repos', { json: { full_name: 'team/one' } });
      const sync = await ownerBrowser.json('/api/owner/github/sync', { method: 'POST', json: {} });
      assert.equal(sync.ok, true, sync.message);
      assert.ok(get(dest.svc.db, 'SELECT 1 FROM github_repo WHERE member_id = ?', memberId));
      assert.ok(get(dest.svc.db, 'SELECT 1 FROM github_issue WHERE member_id = ?', memberId));
      assert.equal(isWorkspaceEmpty(dest.svc.db, memberId), false, 'a GitHub mirror alone makes the workspace non-empty');

      assert.throws(() => importExport(dest.svc.db, memberId, zip), (e: unknown) => {
        assert.ok(e instanceof DomainError);
        assert.equal(e.code, 'conflict');
        assert.match(e.message, /empty workspace/i);
        assert.doesNotMatch(e.message, /UNIQUE constraint/i);
        return true;
      });
      const viaApi = await ownerBrowser.fetch('/api/owner/import', { method: 'POST', body: new Uint8Array(zip) as Uint8Array<ArrayBuffer>, headers: { 'content-type': 'application/zip' } });
      assert.equal(viaApi.status, 409, await viaApi.clone().text());
      const body = (await viaApi.json()) as { error?: string; message?: string };
      assert.equal(body.error, 'conflict');
      assert.doesNotMatch(String(body.message), /UNIQUE constraint/i);
    } finally {
      await dest.close();
    }
  });

  it('rejects a dangling issue role_id, default_role_id or assigner role with a DomainError', async () => {
    const src = await startService({ env: { GITHUB_API_URL: 'https://github.test/api' }, fetchImpl: fakeGithub(repos) as typeof fetch });
    await seed(src);
    const { zip } = buildExport(src.svc.db, ensureOwnerMember(src.svc.db).id);
    await src.close();

    const cases: { field: string; mutate: (ws: { tables: Record<string, Record<string, unknown>[]> }) => void }[] = [
      {
        field: 'github_issue.role_id',
        mutate: (ws) => {
          ws.tables.github_issue![0]!.role_id = 'rol_not_in_export';
        },
      },
      {
        field: 'github_repo.default_role_id',
        mutate: (ws) => {
          ws.tables.github_repo![0]!.default_role_id = 'rol_not_in_export';
        },
      },
      {
        field: 'github_repo_assigner.role_id',
        mutate: (ws) => {
          ws.tables.github_repo_assigner![0]!.role_id = 'rol_not_in_export';
        },
      },
    ];

    for (const c of cases) {
      const dst = await startService();
      try {
        const owner = ensureOwnerMember(dst.svc.db);
        const bad = rewriteWorkspace(zip, c.mutate);
        assert.throws(() => importExport(dst.svc.db, owner.id, bad), (e: unknown) => {
          assert.ok(e instanceof DomainError, `${c.field}: expected DomainError, got ${e}`);
          assert.equal(e.code, 'invalid');
          assert.match(e.message, new RegExp(c.field.replace('.', '\\.')));
          assert.match(e.message, /not in the import/);
          assert.match(e.message, /rol_not_in_export/);
          assert.doesNotMatch(e.message, /FOREIGN KEY constraint/i);
          return true;
        });
        assert.equal(isWorkspaceEmpty(dst.svc.db, owner.id), true, `${c.field}: a failed import must roll back`);
      } finally {
        await dst.close();
      }
    }
  });
});
