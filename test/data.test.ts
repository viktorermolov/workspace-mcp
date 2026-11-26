import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { createBackup, listBackups, restoreBackup, verifyDatabaseFile } from '../src/backup/backup.ts';
import { buildExport, readExport } from '../src/backup/export.ts';
import { loadConfig } from '../src/config.ts';
import { DatabaseInUseError, get, NewerSchemaError, openDatabase, openOffline, run, runAppMigrations } from '../src/db/db.ts';
import { migrations } from '../src/db/schema.ts';
import { ensureOwnerMember, saveRole, updateRules } from '../src/domain/entities.ts';
import { Browser, call, connectAgent, registerOwner, signIn, startService } from './helpers/harness.ts';

describe('data safety', () => {
  it('keeps all state across a restart, including connections and the passkey', async () => {
    let env = await startService();
    try {
      const { browser, authenticator } = await registerOwner(env);
      const { client, provider } = await connectAgent(env, browser, 'Restart agent');
      await call(client, 'save_role', { name: 'Ops', slug: 'ops', instruction: 'Keep it running.' });
      await client.close();
      const backupsBefore = listBackups(env.config).length;
      await env.close();
      // Let the client's connection pool see the old sockets close before reusing the address.
      await new Promise((r) => setTimeout(r, 200));

      // Same address after the restart: passkeys are bound to the origin.
      env = await startService({ dataDir: env.dataDir, port: Number(new URL(env.base).port) });
      assert.equal(listBackups(env.config).length, backupsBefore, 'no migration backup when nothing is pending');
      const again = await connectAgent(env, await signIn(env, authenticator), 'Restart agent', provider);
      const r = await call(again.client, 'get', { type: 'role', id: 'ops' });
      assert.equal(r.instruction, 'Keep it running.');
      await again.client.close();
    } finally {
      await env.close();
    }
  });

  it('backs up before migrating an existing database and keeps the data', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsmcp-mig-'));
    const config = loadConfig({ PUBLIC_URL: 'http://localhost:1', SECRET_KEY: Buffer.alloc(32, 3).toString('base64'), DATA_DIR: dir, LOG_LEVEL: 'error' });
    // An older database: app tables exist, the auth tables do not yet.
    const old = openDatabase(config.dbPath);
    runAppMigrations(old);
    const m = ensureOwnerMember(old);
    saveRole(old, { kind: 'owner', memberId: m.id }, { name: 'Legacy', slug: 'legacy', instruction: 'From before the upgrade.' });
    old.close();

    const env = await startService({ dataDir: dir });
    const pre = listBackups(env.config).filter((b) => b.reason === 'pre-migration');
    assert.equal(pre.length, 1);
    assert.equal(get<{ n: number }>(env.svc.db, "SELECT count(*) AS n FROM role WHERE slug = 'legacy'")!.n, 1);
    assert.ok(verifyDatabaseFile(path.join(env.config.backupDir, pre[0]!.name)).ok);
    await env.close();
  });

  it('upgrades a database that holds data through a later app migration, with a backup first', async () => {
    const first = await startService();
    const owner = { kind: 'owner' as const, memberId: ensureOwnerMember(first.svc.db).id };
    saveRole(first.svc.db, owner, { name: 'Keeper', slug: 'keeper', instruction: 'Survives the upgrade.' });
    const dataDir = first.dataDir;
    await first.close();
    let env: Awaited<ReturnType<typeof startService>> | undefined;

    // A later release: one more app migration on top of the current ones (test-only, never shipped).
    const fixture = { id: Math.max(...migrations.map((m) => m.id)) + 1000, name: 'test fixture: role note', sql: "ALTER TABLE role ADD COLUMN fixture_note TEXT; UPDATE role SET fixture_note = 'migrated';" };
    migrations.push(fixture);
    try {
      env = await startService({ dataDir });
      const pre = listBackups(env.config).filter((b) => b.reason === 'pre-migration');
      assert.equal(pre.length, 1);
      assert.equal(get<{ n: number }>(env.svc.db, 'SELECT count(*) AS n FROM app_migration WHERE id = ?', fixture.id)!.n, 1);
      const role = get<{ instruction: string; fixture_note: string }>(env.svc.db, "SELECT r.fixture_note, v.body AS instruction FROM role r JOIN version v ON v.id = r.current_version WHERE r.slug = 'keeper'")!;
      assert.deepEqual({ ...role }, { fixture_note: 'migrated', instruction: 'Survives the upgrade.' });

      // The backup holds the database as it was before the migration.
      const file = path.join(env.config.backupDir, pre[0]!.name);
      assert.ok(verifyDatabaseFile(file).ok);
      const before = openDatabase(file);
      try {
        assert.equal(get<{ n: number }>(before, 'SELECT count(*) AS n FROM app_migration WHERE id = ?', fixture.id)!.n, 0);
        assert.equal(get<{ n: number }>(before, "SELECT count(*) AS n FROM role WHERE slug = 'keeper'")!.n, 1);
      } finally {
        before.close();
      }
      await env.close();
      env = undefined;

      // Starting again applies nothing and makes no new pre-migration backup.
      env = await startService({ dataDir });
      assert.equal(listBackups(env.config).filter((b) => b.reason === 'pre-migration').length, 1);
      assert.equal(get<{ n: number }>(env.svc.db, 'SELECT count(*) AS n FROM app_migration WHERE id = ?', fixture.id)!.n, 1);
    } finally {
      migrations.splice(migrations.indexOf(fixture), 1);
      await env?.close();
    }
  });

  it('refuses to open a database upgraded by a newer release, so a rollback cannot damage it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsmcp-newer-'));
    const config = loadConfig({ PUBLIC_URL: 'http://localhost:1', SECRET_KEY: Buffer.alloc(32, 3).toString('base64'), DATA_DIR: dir, LOG_LEVEL: 'error' });
    const db = openDatabase(config.dbPath);
    runAppMigrations(db);
    run(db, 'INSERT INTO app_migration (id, name, applied_at) VALUES (?, ?, ?)', 9999, 'from the future', new Date().toISOString());
    db.close();
    await assert.rejects(() => startService({ dataDir: dir }), NewerSchemaError);
  });

  it('refuses offline tools while the service holds the database, then restores a backup', async () => {
    const env = await startService();
    let file: string;
    try {
      const owner = { kind: 'owner' as const, memberId: ensureOwnerMember(env.svc.db).id };
      updateRules(env.svc.db, owner, { text: 'Version one' });
      file = await createBackup(env.svc.db, env.config, 'manual');
      const r1 = get<{ rev: number }>(env.svc.db, 'SELECT rev FROM rules')!.rev;
      updateRules(env.svc.db, owner, { text: 'Version two', rev: r1 });
      assert.throws(() => openOffline(env.config.dbPath), DatabaseInUseError);
      await assert.rejects(restoreBackup(env.config, file), DatabaseInUseError);
    } finally {
      await env.close();
    }

    const { saved } = await restoreBackup(env.config, file);
    assert.ok(saved && fs.existsSync(saved));
    const env2 = await startService({ dataDir: env.dataDir });
    const rules = get<{ body: string }>(env2.svc.db, 'SELECT v.body FROM rules r JOIN version v ON v.id = r.current_version')!;
    assert.equal(rules.body, 'Version one');
    await env2.close();
  });

  it('rejects a damaged file as a restore source', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsmcp-bad-'));
    const f = path.join(dir, 'broken.sqlite');
    fs.writeFileSync(f, 'this is not a database');
    assert.equal(verifyDatabaseFile(f).ok, false);
    const config = loadConfig({ PUBLIC_URL: 'http://localhost:1', SECRET_KEY: Buffer.alloc(32, 3).toString('base64'), DATA_DIR: dir });
    await assert.rejects(restoreBackup(config, f), /Refusing to restore/);
  });

  it('exports to Markdown + JSON without secrets and imports into an empty workspace', async () => {
    const src = await startService();
    const { browser } = await registerOwner(src);
    const { client } = await connectAgent(src, browser, 'Export agent');
    await call(client, 'update_rules', { text: 'Be brief.' });
    const role = await call(client, 'save_role', { name: 'Writer', slug: 'writer', instruction: 'Draft posts.' });
    await call(client, 'save_role', { id: role.id, rev: role.rev, instruction: 'Draft and edit posts.' });
    await call(client, 'save_project', { name: 'Blog', slug: 'blog' });
    await call(client, 'save_document', { title: 'Style guide', body: '# Style\nShort sentences.', attach_to: { type: 'project', id: 'blog' } });
    const t1 = await call(client, 'save_task', { title: 'Outline', role: 'writer', project: 'blog' });
    await call(client, 'save_task', { title: 'Publish', role: 'writer', project: 'blog', depends_on: [t1.id] });
    await call(client, 'comment_task', { id: t1.id, body: 'Started.' });
    await browser.json('/api/owner/webhooks', { json: { role: 'writer', url: 'https://hooks.example.org/wake', authorization: 'Bearer hook-secret-value', events: ['task.assigned'] } });
    await client.close();

    const res = await browser.fetch('/api/owner/export');
    assert.equal(res.status, 200);
    const zip = new Uint8Array(await res.arrayBuffer());
    const files = unzipSync(zip);
    const names = Object.keys(files);
    for (const n of ['manifest.json', 'workspace.json', 'rules.md', 'README.md', 'roles/writer.md', 'projects/blog.md']) assert.ok(names.includes(n), n);
    assert.ok(names.some((n) => n.startsWith('documents/project-blog/')));
    assert.ok(names.some((n) => n.startsWith('tasks/outline-')));
    const all = Object.values(files).map((f) => Buffer.from(f).toString('utf8')).join('\n');
    assert.ok(!all.includes('hook-secret-value'), 'webhook secrets are never exported');
    assert.ok(!/oauth|access_token|refresh_token|passkey/i.test(Buffer.from(files['workspace.json']!).toString()), 'no auth data');
    assert.match(Buffer.from(files['roles/writer.md']!).toString(), /^---\ntype: "role"/);
    await src.close();

    const dst = await startService();
    const d = await registerOwner(dst);
    const imp = await d.browser.fetch('/api/owner/import', { method: 'POST', body: zip, headers: { 'content-type': 'application/zip' } });
    assert.equal(imp.status, 200, await imp.clone().text());
    const agent = await connectAgent(dst, d.browser, 'After import');
    const s = await call(agent.client, 'start', { role: 'writer' });
    assert.equal(s.instructions.working_rules, 'Be brief.');
    assert.equal(s.instructions.role_instruction, 'Draft and edit posts.');
    const versions = await call(agent.client, 'versions', { type: 'role', id: 'writer' });
    assert.equal(versions.versions.length, 2, 'history survives the move');
    const rulesHistory = await call(agent.client, 'versions', { type: 'rules' });
    assert.equal(rulesHistory.versions.length, 1, 'working rules history survives the move');
    const rulesUpdate = await call(agent.client, 'update_rules', { text: 'Be brief and kind.', rev: s.instructions.working_rules_rev });
    assert.equal(rulesUpdate.version, 2, 'the next rules version continues the history');
    const hit = await call(agent.client, 'search', { query: 'short sentences' });
    assert.ok(hit.results.length >= 1, 'search index rebuilt');
    const publish = s.data.open_tasks.find((t: any) => t.title === 'Publish');
    assert.ok(publish);

    // A second import into a non-empty workspace is refused.
    const again = await d.browser.fetch('/api/owner/import', { method: 'POST', body: zip, headers: { 'content-type': 'application/zip' } });
    assert.equal(again.status, 409);
    await agent.client.close();
    await dst.close();
  });

  it('detects a tampered export and a newer format', async () => {
    const env = await startService();
    const m = ensureOwnerMember(env.svc.db);
    updateRules(env.svc.db, { kind: 'owner', memberId: m.id }, { text: 'Original' });
    const { zip } = buildExport(env.svc.db, m.id);
    await env.close();
    const files = unzipSync(zip);
    const ws = JSON.parse(Buffer.from(files['workspace.json']!).toString());
    ws.tables.version[0].body = 'Tampered';
    const tampered = zipSync({ ...files, 'workspace.json': strToU8(JSON.stringify(ws)) });
    assert.throws(() => readExport(tampered), /Integrity check failed/);
    const manifest = JSON.parse(Buffer.from(files['manifest.json']!).toString());
    manifest.format_version = 99;
    const newer = zipSync({ ...files, 'manifest.json': strToU8(JSON.stringify(manifest)) });
    assert.throws(() => readExport(newer), /newer than this server supports/);
    assert.throws(() => readExport(strToU8('not a zip')), /Not a valid zip|Not a workspace export/);
  });

  it('lists and downloads backups from the web interface API', async () => {
    const env = await startService();
    const { browser } = await registerOwner(env);
    const made = await browser.json('/api/owner/backups', { method: 'POST', json: {} });
    const list = await browser.json('/api/owner/backups');
    assert.ok(list.backups.some((b: any) => b.name === made.name));
    const dl = await browser.fetch(`/api/owner/backups/${made.name}/download`);
    assert.equal(dl.status, 200);
    assert.equal(Buffer.from(await dl.arrayBuffer()).subarray(0, 15).toString(), 'SQLite format 3');
    assert.equal((await browser.fetch('/api/owner/backups/..%2Fworkspace.sqlite/download')).status, 404);
    const anon = new Browser(env.base);
    assert.equal((await anon.fetch(`/api/owner/backups/${made.name}/download`)).status, 401);
    await env.close();
  });
});
