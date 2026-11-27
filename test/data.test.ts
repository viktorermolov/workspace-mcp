import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, mock } from 'node:test';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { createBackup, listBackups, pruneBackups, restoreBackup, verifyDatabaseFile } from '../src/backup/backup.ts';
import { buildExport, importExport, isWorkspaceEmpty, readExport } from '../src/backup/export.ts';
import { loadConfig } from '../src/config.ts';
import { all, DatabaseInUseError, get, NewerSchemaError, openDatabase, openOffline, run, runAppMigrations } from '../src/db/db.ts';
import { migrations } from '../src/db/schema.ts';
import { DomainError } from '../src/domain/core.ts';
import { ensureOwnerMember, getRules, saveRole, updateRules } from '../src/domain/entities.ts';
import { log } from '../src/util/log.ts';
import { Browser, call, connectAgent, registerOwner, signIn, startService } from './helpers/harness.ts';


function withTaskParents(zip: Uint8Array, parents: Record<string, string | null>): Uint8Array {
  const files = unzipSync(zip);
  const ws = JSON.parse(Buffer.from(files['workspace.json']!).toString()) as {
    tables: { task: { id: string; parent_id: string | null }[] };
  };
  for (const row of ws.tables.task) {
    if (row.id in parents) row.parent_id = parents[row.id]!;
  }
  const wsBytes = strToU8(JSON.stringify(ws));
  const manifest = JSON.parse(Buffer.from(files['manifest.json']!).toString()) as { files: Record<string, string> };
  manifest.files['workspace.json'] = createHash('sha256').update(wsBytes).digest('hex');
  return zipSync({ ...files, 'workspace.json': wsBytes, 'manifest.json': strToU8(JSON.stringify(manifest, null, 2)) });
}


function rewriteWorkspaceJson(zip: Uint8Array, mutate: (ws: any, files: Record<string, Uint8Array>) => void): Uint8Array {
  const files = unzipSync(zip);
  const ws = JSON.parse(Buffer.from(files['workspace.json']!).toString());
  mutate(ws, files);
  const wsBytes = strToU8(JSON.stringify(ws));
  const manifest = JSON.parse(Buffer.from(files['manifest.json']!).toString()) as { files: Record<string, string> };
  manifest.files['workspace.json'] = createHash('sha256').update(wsBytes).digest('hex');
  return zipSync({ ...files, 'workspace.json': wsBytes, 'manifest.json': strToU8(JSON.stringify(manifest, null, 2)) });
}

function withRoleParents(zip: Uint8Array, parents: Record<string, string | null>): Uint8Array {
  return rewriteWorkspaceJson(zip, (ws) => {
    for (const row of ws.tables.role as { id: string; parent_id: string | null }[]) {
      if (row.id in parents) row.parent_id = parents[row.id]!;
    }
  });
}

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

  it('restores the pre-migration backup to the state before a later app migration', async () => {
    const first = await startService();
    const owner = { kind: 'owner' as const, memberId: ensureOwnerMember(first.svc.db).id };
    saveRole(first.svc.db, owner, { name: 'Keeper', slug: 'keeper', instruction: 'Before the upgrade.' });
    const dataDir = first.dataDir;
    await first.close();
    let env: Awaited<ReturnType<typeof startService>> | undefined;

    const fixture = { id: Math.max(...migrations.map((m) => m.id)) + 1000, name: 'test fixture: notes table', sql: "CREATE TABLE fixture_note (body TEXT NOT NULL); INSERT INTO fixture_note (body) VALUES ('migrated');" };
    migrations.push(fixture);
    try {
      env = await startService({ dataDir });
      // A change made after the upgrade, which the restore must undo.
      saveRole(env.svc.db, owner, { name: 'Newcomer', slug: 'newcomer', instruction: 'After the upgrade.' });
      const pre = listBackups(env.config).filter((b) => b.reason === 'pre-migration');
      assert.equal(pre.length, 1);
      const config = env.config;
      await env.close();
      env = undefined;

      const { saved } = await restoreBackup(config, path.join(config.backupDir, pre[0]!.name));
      assert.ok(saved, 'the upgraded database is saved before the restore');
      const db = openOffline(config.dbPath);
      try {
        assert.equal(get<{ n: number }>(db, 'SELECT count(*) AS n FROM app_migration WHERE id = ?', fixture.id)!.n, 0);
        assert.equal(get<{ n: number }>(db, "SELECT count(*) AS n FROM sqlite_master WHERE name = 'fixture_note'")!.n, 0);
        const roles = db.prepare('SELECT slug FROM role ORDER BY slug').all().map((r) => (r as { slug: string }).slug);
        assert.ok(roles.includes('keeper'));
        assert.ok(!roles.includes('newcomer'));
      } finally {
        db.close();
      }
    } finally {
      migrations.splice(migrations.indexOf(fixture), 1);
      await env?.close();
    }

    // The release before the upgrade runs on the restored database with nothing to migrate.
    env = await startService({ dataDir });
    try {
      assert.equal(listBackups(env.config).filter((b) => b.reason === 'pre-migration').length, 1);
      assert.equal(get<{ instruction: string }>(env.svc.db, "SELECT v.body AS instruction FROM role r JOIN version v ON v.id = r.current_version WHERE r.slug = 'keeper'")!.instruction, 'Before the upgrade.');
    } finally {
      await env.close();
    }
  });

  it('leaves the database untouched when a later app migration fails', async () => {
    const first = await startService();
    const owner = { kind: 'owner' as const, memberId: ensureOwnerMember(first.svc.db).id };
    saveRole(first.svc.db, owner, { name: 'Keeper', slug: 'keeper', instruction: 'Survives a failed upgrade.' });
    const dataDir = first.dataDir;
    const config = first.config;
    await first.close();
    const count = (db: ReturnType<typeof openDatabase>, sql: string, ...p: unknown[]) => get<{ n: number }>(db, sql, ...p)!.n;

    // The first two statements succeed, the last of the three fails: the whole migration must be rolled back.
    const fixture = { id: Math.max(...migrations.map((m) => m.id)) + 1000, name: 'test fixture: broken', sql: "ALTER TABLE role ADD COLUMN fixture_note TEXT; CREATE TABLE fixture_partial (x TEXT); INSERT INTO no_such_table VALUES (1);" };
    migrations.push(fixture);
    try {
      await assert.rejects(startService({ dataDir }), /no_such_table/);
    } finally {
      migrations.splice(migrations.indexOf(fixture), 1);
    }

    const db = openOffline(config.dbPath);
    try {
      assert.equal(count(db, 'SELECT count(*) AS n FROM app_migration WHERE id = ?', fixture.id), 0);
      assert.equal(count(db, "SELECT count(*) AS n FROM sqlite_master WHERE name = 'fixture_partial'"), 0);
      assert.equal(count(db, "SELECT count(*) AS n FROM pragma_table_info('role') WHERE name = 'fixture_note'"), 0);
      assert.equal(count(db, "SELECT count(*) AS n FROM role WHERE slug = 'keeper'"), 1);
    } finally {
      db.close();
    }
    // The backup made before the attempt is there, and the release without the migration starts normally.
    assert.equal(listBackups(config).filter((b) => b.reason === 'pre-migration').length, 1);
    const env = await startService({ dataDir });
    try {
      assert.equal(count(env.svc.db, "SELECT count(*) AS n FROM role WHERE slug = 'keeper'"), 1);
    } finally {
      await env.close();
    }
  });

  it('makes a first backup at start when there is none yet, and not again on the next start', async () => {
    let env = await startService({ jobs: true });
    try {
      const first = listBackups(env.config);
      assert.equal(first.length, 1);
      assert.equal(first[0]!.reason, 'scheduled');
      assert.ok(verifyDatabaseFile(path.join(env.config.backupDir, first[0]!.name)).ok);
      await env.close();
      env = await startService({ dataDir: env.dataDir, jobs: true });
      assert.deepEqual(listBackups(env.config).map((b) => b.name), first.map((b) => b.name));
    } finally {
      await env.close();
    }
  });

  it('logs a failed backup at start and still starts', async () => {
    // The backup is written to a temporary file and then renamed into place: make that last step fail.
    const rename = mock.method(fs, 'renameSync', () => {
      throw new Error('disk full (test)');
    });
    const errors = mock.method(log, 'error', () => undefined);
    let env: Awaited<ReturnType<typeof startService>> | undefined;
    try {
      env = await startService({ jobs: true });
      rename.mock.restore();
      assert.ok(errors.mock.calls.some((c) => c.arguments[0] === 'background job failed' && c.arguments[1]?.job === 'backup' && /disk full \(test\)/.test(String(c.arguments[1]?.error))));
      assert.equal(listBackups(env.config).length, 0);
      assert.deepEqual(fs.readdirSync(env.config.backupDir), [], 'a failed backup leaves no partial file behind');
      const res = await fetch(`${env.base}/healthz`);
      assert.equal(res.status, 200);
    } finally {
      rename.mock.restore();
      errors.mock.restore();
      await env?.close();
    }
  });

  it('makes no extra backup at start when a pre-migration backup was just made', async () => {
    const first = await startService();
    const owner = { kind: 'owner' as const, memberId: ensureOwnerMember(first.svc.db).id };
    saveRole(first.svc.db, owner, { name: 'Keeper', slug: 'keeper', instruction: 'Before the upgrade.' });
    const dataDir = first.dataDir;
    await first.close();
    let env: Awaited<ReturnType<typeof startService>> | undefined;

    const fixture = { id: Math.max(...migrations.map((m) => m.id)) + 1000, name: 'test fixture: notes table', sql: 'CREATE TABLE fixture_note (body TEXT);' };
    migrations.push(fixture);
    try {
      // Scheduled backups on: the pre-migration backup counts as the first one.
      env = await startService({ dataDir, jobs: true });
      assert.deepEqual(listBackups(env.config).map((b) => b.reason), ['pre-migration']);
    } finally {
      migrations.splice(migrations.indexOf(fixture), 1);
      await env?.close();
    }
  });

  it('makes no backup at start when scheduled backups are off', async () => {
    const env = await startService({ jobs: true, env: { BACKUP_INTERVAL_HOURS: '0' } });
    try {
      assert.equal(listBackups(env.config).length, 0);
    } finally {
      await env.close();
    }
  });

  it('keeps the newest pre-migration, pre-restore and pre-import backups out of the rotation', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsmcp-prune-'));
    const config = loadConfig({ PUBLIC_URL: 'http://localhost:1', SECRET_KEY: Buffer.alloc(32, 3).toString('base64'), DATA_DIR: dir, LOG_LEVEL: 'error', BACKUP_KEEP: '1' });
    const db = openDatabase(config.dbPath);
    runAppMigrations(db);
    const made: Record<string, string[]> = {};
    try {
      for (const reason of ['pre-migration', 'pre-restore', 'pre-import', 'manual', 'scheduled'] as const) {
        for (let i = 0; i < 4; i++) (made[reason] ??= []).push(path.basename(await createBackup(db, config, reason)));
      }
    } finally {
      db.close();
    }
    pruneBackups(config);
    const left = listBackups(config);
    for (const reason of ['pre-migration', 'pre-restore', 'pre-import']) {
      // The newest three of each kind stay, whatever BACKUP_KEEP says.
      assert.deepEqual(left.filter((b) => b.reason === reason).map((b) => b.name), made[reason]!.slice(1).reverse(), reason);
    }
    // The rotation keeps BACKUP_KEEP scheduled and manual backups: here only the newest one.
    assert.deepEqual(left.filter((b) => b.reason === 'scheduled' || b.reason === 'manual').map((b) => b.name), [made.scheduled!.at(-1)]);
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
      const r1 = get<{ rev: number }>(env.svc.db, 'SELECT rev FROM rules WHERE is_default = 1')!.rev;
      updateRules(env.svc.db, owner, { text: 'Version two', rev: r1 });
      assert.throws(() => openOffline(env.config.dbPath), DatabaseInUseError);
      await assert.rejects(restoreBackup(env.config, file), DatabaseInUseError);
    } finally {
      await env.close();
    }

    const { saved } = await restoreBackup(env.config, file);
    assert.ok(saved && fs.existsSync(saved));
    const env2 = await startService({ dataDir: env.dataDir });
    const rules = get<{ body: string }>(env2.svc.db, 'SELECT v.body FROM rules r JOIN version v ON v.id = r.current_version WHERE r.is_default = 1')!;
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
    await call(client, 'save_routine', { name: 'Weekly draft', role: 'writer', schedule: '0 9 * * 1', timezone: 'UTC' });
    await call(client, 'save_project', { name: 'Blog', slug: 'blog' });
    await call(client, 'update_rules', { slug: 'blog-voice', title: 'Blog voice', project: 'blog', text: 'Write like a newsletter.' });
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
    for (const n of ['manifest.json', 'workspace.json', 'rules.md', 'rules/blog-voice.md', 'README.md', 'roles/writer.md', 'projects/blog.md', 'routines/weekly-draft.md']) assert.ok(names.includes(n), n);
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
    const withProject = await call(agent.client, 'start', { role: 'writer', project: 'blog' });
    assert.equal(withProject.instructions.working_rules, 'Be brief.');
    assert.equal(withProject.instructions.project_rules.length, 1);
    assert.equal(withProject.instructions.project_rules[0].slug, 'blog-voice');
    assert.equal(withProject.instructions.project_rules[0].text, 'Write like a newsletter.');
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
    assert.ok(s.data.role_routines.some((r: { name: string; schedule: string }) => r.name === 'Weekly draft' && r.schedule === '0 9 * * 1'));

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

  it('upgrades a single-row rules table to titled sets and remaps version and event ids', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsmcp-rules-mig-'));
    const db = openDatabase(path.join(dir, 'workspace.sqlite'));
    db.exec('CREATE TABLE IF NOT EXISTS app_migration (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
    for (const m of migrations.filter((mig) => mig.id <= 2)) {
      db.exec(m.sql!);
      run(db, 'INSERT INTO app_migration (id, name, applied_at) VALUES (?, ?, ?)', m.id, m.name, new Date().toISOString());
    }
    const at = '2026-01-01T00:00:00.000Z';
    run(db, "INSERT INTO member (id, user_id, name, is_owner, created_at) VALUES ('mem_legacy_49', NULL, 'Owner', 1, ?)", at);
    run(db, "INSERT INTO rules (member_id, current_version, rev, updated_at) VALUES ('mem_legacy_49', NULL, 1, ?)", at);
    run(
      db,
      "INSERT INTO version (member_id, entity_type, entity_id, number, body, actor_kind, created_at) VALUES ('mem_legacy_49', 'rules', 'mem_legacy_49', 1, 'Legacy working rules.', 'owner', ?)",
      at,
    );
    const versionId = get<{ id: number }>(db, 'SELECT id FROM version WHERE entity_type = ? AND entity_id = ?', 'rules', 'mem_legacy_49')!.id;
    run(db, 'UPDATE rules SET current_version = ? WHERE member_id = ?', versionId, 'mem_legacy_49');
    run(
      db,
      "INSERT INTO event (member_id, at, actor_kind, entity_type, entity_id, action, summary) VALUES ('mem_legacy_49', ?, 'owner', 'rules', 'mem_legacy_49', 'rules.updated', 'Working rules updated to version 1')",
      at,
    );

    const applied = runAppMigrations(db);
    // titled-rules-sets (3) plus later migrations that also sit after 2 (connection_roles is 4 … pending-client-bind is 16).
    assert.equal(applied, 14);
    const row = get<{ id: string; slug: string; title: string; is_default: number; project_id: string | null; member_id: string }>(
      db,
      'SELECT id, slug, title, is_default, project_id, member_id FROM rules WHERE member_id = ?',
      'mem_legacy_49',
    )!;
    assert.ok(row.id.startsWith('rul_'));
    assert.equal(row.slug, 'working-rules');
    assert.equal(row.title, 'Working rules');
    assert.equal(row.is_default, 1);
    assert.equal(row.project_id, null);
    assert.equal(get<{ n: number }>(db, 'SELECT count(*) AS n FROM rules')!.n, 1);
    assert.equal(get<{ entity_id: string }>(db, "SELECT entity_id FROM version WHERE entity_type = 'rules'")!.entity_id, row.id);
    assert.equal(get<{ entity_id: string }>(db, "SELECT entity_id FROM event WHERE entity_type = 'rules'")!.entity_id, row.id);
    // Triggers were recreated: updates to version and event still fail.
    assert.throws(() => run(db, "UPDATE version SET body = 'nope' WHERE id = ?", versionId), /versions are immutable/);
    const evId = get<{ id: number }>(db, "SELECT id FROM event WHERE entity_type = 'rules'")!.id;
    assert.throws(() => run(db, "UPDATE event SET summary = 'nope' WHERE id = ?", evId), /the log is append-only/);
    const view = getRules(db, 'mem_legacy_49');
    assert.equal(view.text, 'Legacy working rules.');
    assert.equal(view.version, 1);
    db.close();
  });

  it('imports a pre-titled-rules export onto the destination default rules id', async () => {
    const src = await startService();
    const m = ensureOwnerMember(src.svc.db);
    updateRules(src.svc.db, { kind: 'owner', memberId: m.id }, { text: 'Imported from an old export.' });
    const { zip } = buildExport(src.svc.db, m.id);
    await src.close();

    const files = unzipSync(zip);
    const ws = JSON.parse(Buffer.from(files['workspace.json']!).toString());
    ws.tables.rules = (ws.tables.rules as Record<string, unknown>[]).map((r) => {
      const { id: _id, slug: _slug, title: _title, project_id: _p, is_default: _d, created_at: _c, ...rest } = r;
      return rest;
    });
    for (const row of [...(ws.tables.version as { entity_type: string; entity_id: string }[]), ...(ws.tables.event as { entity_type: string; entity_id: string }[])]) {
      if (row.entity_type === 'rules') row.entity_id = 'mem_source_old';
    }
    const wsBytes = strToU8(JSON.stringify(ws));
    const manifest = JSON.parse(Buffer.from(files['manifest.json']!).toString());
    manifest.files['workspace.json'] = createHash('sha256').update(wsBytes).digest('hex');
    const oldZip = zipSync({ ...files, 'workspace.json': wsBytes, 'manifest.json': strToU8(JSON.stringify(manifest, null, 2)) });

    const dst = await startService();
    try {
      const owner = ensureOwnerMember(dst.svc.db);
      importExport(dst.svc.db, owner.id, oldZip);
      const view = getRules(dst.svc.db, owner.id);
      assert.equal(view.text, 'Imported from an old export.');
      assert.ok(view.id.startsWith('rul_'));
      const ver = get<{ entity_id: string }>(dst.svc.db, "SELECT entity_id FROM version WHERE entity_type = 'rules' LIMIT 1")!;
      assert.equal(ver.entity_id, view.id);
      assert.notEqual(ver.entity_id, owner.id);
      assert.equal(get<{ n: number }>(dst.svc.db, "SELECT count(*) AS n FROM version WHERE entity_type = 'rules'")!.n, 1);
      const ev = get<{ entity_id: string }>(dst.svc.db, "SELECT entity_id FROM event WHERE entity_type = 'rules' LIMIT 1")!;
      assert.equal(ev.entity_id, view.id);
    } finally {
      await dst.close();
    }
  });

  it('imports a task whose parent was created after it', async () => {
    const src = await startService();
    const { client } = await connectAgent(src, (await registerOwner(src)).browser, 'Parent import');
    const child = await call<{ id: string; rev: number }>(client, 'save_task', { title: 'Child first' });
    const parent = await call<{ id: string }>(client, 'save_task', { title: 'Parent later' });
    await call(client, 'save_task', { id: child.id, rev: child.rev, parent_id: parent.id });
    const { zip } = buildExport(src.svc.db, ensureOwnerMember(src.svc.db).id);
    await client.close();
    await src.close();

    const dst = await startService();
    try {
      const owner = ensureOwnerMember(dst.svc.db);
      importExport(dst.svc.db, owner.id, zip);
      const imported = get<{ parent_id: string | null; title: string }>(dst.svc.db, 'SELECT parent_id, title FROM task WHERE id = ?', child.id)!;
      assert.equal(imported.title, 'Child first');
      assert.equal(imported.parent_id, parent.id);
      assert.ok(get(dst.svc.db, 'SELECT 1 FROM task WHERE id = ?', parent.id));
    } finally {
      await dst.close();
    }
  });

  it('rejects an import when task parents form a cycle or point outside the import', async () => {
    const src = await startService();
    const memberId = ensureOwnerMember(src.svc.db).id;
    const { client } = await connectAgent(src, (await registerOwner(src)).browser, 'Cycle import');
    const a = await call<{ id: string; rev: number }>(client, 'save_task', { title: 'Task A' });
    const b = await call<{ id: string; rev: number }>(client, 'save_task', { title: 'Task B' });
    await call(client, 'save_task', { id: a.id, rev: a.rev, parent_id: b.id });
    const { zip } = buildExport(src.svc.db, memberId);
    await client.close();
    await src.close();

    const cycleZip = withTaskParents(zip, { [a.id]: b.id, [b.id]: a.id });
    const missingZip = withTaskParents(zip, { [a.id]: 'tsk_not_in_export' });

    const dst = await startService();
    try {
      const owner = ensureOwnerMember(dst.svc.db);
      assert.throws(() => importExport(dst.svc.db, owner.id, cycleZip), (e: unknown) => {
        assert.ok(e instanceof DomainError);
        assert.equal(e.code, 'invalid');
        assert.match(e.message, /cycle/i);
        return true;
      });
      assert.equal(isWorkspaceEmpty(dst.svc.db, owner.id), true, 'a failed import must roll back');

      assert.throws(() => importExport(dst.svc.db, owner.id, missingZip), (e: unknown) => {
        assert.ok(e instanceof DomainError);
        assert.equal(e.code, 'invalid');
        assert.match(e.message, /not in the import/i);
        return true;
      });
      assert.equal(isWorkspaceEmpty(dst.svc.db, owner.id), true);
    } finally {
      await dst.close();
    }
  });

  it('imports role parents from a backup regardless of row order', async () => {
    const src = await startService();
    const { browser } = await registerOwner(src);
    const child = await browser.json<{ id: string; rev: number }>('/api/owner/roles', { json: { name: 'Writer', slug: 'writer' } });
    const parent = await browser.json<{ id: string }>('/api/owner/roles', { json: { name: 'Manager', slug: 'manager' } });
    await browser.json('/api/owner/roles', { json: { id: child.id, rev: child.rev, parent: 'manager' } });
    const { zip } = buildExport(src.svc.db, ensureOwnerMember(src.svc.db).id);
    await src.close();

    const reversed = rewriteWorkspaceJson(zip, (ws) => {
      ws.tables.role = [...ws.tables.role].reverse();
    });

    const dst = await startService();
    try {
      const owner = ensureOwnerMember(dst.svc.db);
      importExport(dst.svc.db, owner.id, reversed);
      const imported = get<{ parent_id: string | null; slug: string }>(dst.svc.db, 'SELECT parent_id, slug FROM role WHERE id = ?', child.id)!;
      assert.equal(imported.slug, 'writer');
      assert.equal(imported.parent_id, parent.id);
      assert.ok(get(dst.svc.db, 'SELECT 1 FROM role WHERE id = ?', parent.id));
    } finally {
      await dst.close();
    }
  });

  it('rejects an import when role parents form a cycle, point outside the import or another workspace, or exceed depth 16', async () => {
    const src = await startService();
    const memberId = ensureOwnerMember(src.svc.db).id;
    const { browser } = await registerOwner(src);
    const a = await browser.json<{ id: string; rev: number }>('/api/owner/roles', { json: { name: 'Role A', slug: 'role-a' } });
    const b = await browser.json<{ id: string; rev: number }>('/api/owner/roles', { json: { name: 'Role B', slug: 'role-b' } });
    await browser.json('/api/owner/roles', { json: { id: a.id, rev: a.rev, parent: 'role-b' } });
    const { zip } = buildExport(src.svc.db, memberId);
    await src.close();

    const cycleZip = withRoleParents(zip, { [a.id]: b.id, [b.id]: a.id });
    const missingZip = withRoleParents(zip, { [a.id]: 'rol_not_in_export' });

    const dst = await startService();
    try {
      const owner = ensureOwnerMember(dst.svc.db);
      assert.throws(() => importExport(dst.svc.db, owner.id, cycleZip), (e: unknown) => {
        assert.ok(e instanceof DomainError);
        assert.equal(e.code, 'invalid');
        assert.match(e.message, /cycle/i);
        return true;
      });
      assert.equal(isWorkspaceEmpty(dst.svc.db, owner.id), true, 'a failed import must roll back');

      assert.throws(() => importExport(dst.svc.db, owner.id, missingZip), (e: unknown) => {
        assert.ok(e instanceof DomainError);
        assert.equal(e.code, 'invalid');
        assert.match(e.message, /not in the import/i);
        return true;
      });
      assert.equal(isWorkspaceEmpty(dst.svc.db, owner.id), true);

      const at = '2026-01-01T00:00:00.000Z';
      run(dst.svc.db, "INSERT INTO member (id, user_id, name, is_owner, created_at) VALUES ('mem_foreign', NULL, 'Other', 0, ?)", at);
      run(
        dst.svc.db,
        `INSERT INTO role (id, member_id, slug, name, area, setup_notes, rev, edit_any, created_at, updated_at)
         VALUES ('rol_foreign', 'mem_foreign', 'foreign', 'Foreign', '', '', 1, 0, ?, ?)`,
        at,
        at,
      );
      const foreignZip = withRoleParents(zip, { [a.id]: 'rol_foreign' });
      assert.throws(() => importExport(dst.svc.db, owner.id, foreignZip), (e: unknown) => {
        assert.ok(e instanceof DomainError);
        assert.equal(e.code, 'invalid');
        assert.match(e.message, /another workspace/);
        return true;
      });
      assert.equal(isWorkspaceEmpty(dst.svc.db, owner.id), true);
    } finally {
      await dst.close();
    }

    const deepSrc = await startService();
    const deepBrowser = (await registerOwner(deepSrc)).browser;
    const makeChain = async (prefix: string) => {
      let prev: string | null = null;
      let rootId = '';
      let leafId = '';
      for (let i = 0; i < 10; i++) {
        const slug = `${prefix}${String(i).padStart(2, '0')}`;
        const role = await deepBrowser.json<{ id: string }>('/api/owner/roles', { json: { name: `${prefix} ${i}`, slug, parent: prev } });
        if (i === 0) rootId = role.id;
        leafId = role.id;
        prev = slug;
      }
      return { rootId, leafId };
    };
    const chainA = await makeChain('a');
    const chainB = await makeChain('b');
    const deepZip = withRoleParents(buildExport(deepSrc.svc.db, ensureOwnerMember(deepSrc.svc.db).id).zip, {
      [chainA.rootId]: chainB.leafId,
    });
    await deepSrc.close();

    const deepDst = await startService();
    try {
      const owner = ensureOwnerMember(deepDst.svc.db);
      assert.throws(() => importExport(deepDst.svc.db, owner.id, deepZip), (e: unknown) => {
        assert.ok(e instanceof DomainError);
        assert.equal(e.code, 'invalid');
        assert.match(e.message, /deeper than 16/);
        return true;
      });
      assert.equal(isWorkspaceEmpty(deepDst.svc.db, owner.id), true);
    } finally {
      await deepDst.close();
    }
  });

  it('imports a 0.2.0-shaped backup whose roles have no parent field', async () => {
    const src = await startService();
    const { browser } = await registerOwner(src);
    await browser.json('/api/owner/roles', { json: { name: 'Writer', slug: 'writer' } });
    await browser.json('/api/owner/roles', { json: { name: 'Manager', slug: 'manager' } });
    const { zip } = buildExport(src.svc.db, ensureOwnerMember(src.svc.db).id);
    await src.close();

    const oldZip = rewriteWorkspaceJson(zip, (ws) => {
      for (const row of ws.tables.role as Record<string, unknown>[]) delete row.parent_id;
    });

    const dst = await startService();
    try {
      const owner = ensureOwnerMember(dst.svc.db);
      importExport(dst.svc.db, owner.id, oldZip);
      const rows = all<{ slug: string; parent_id: string | null }>(dst.svc.db, 'SELECT slug, parent_id FROM role ORDER BY slug');
      assert.deepEqual(
        rows.map((r) => [r.slug, r.parent_id]),
        [
          ['manager', null],
          ['writer', null],
        ],
      );
    } finally {
      await dst.close();
    }
  });
});
