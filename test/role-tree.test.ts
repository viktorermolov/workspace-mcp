import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { unzipSync } from 'fflate';
import { all, get, openDatabase, run, runAppMigrations } from '../src/db/db.ts';
import { migrations } from '../src/db/schema.ts';
import { DomainError, type Actor } from '../src/domain/core.ts';
import { purge, saveRole, setArchived } from '../src/domain/entities.ts';
import { mapView, MAP_INTERACTION_EVENT_CAP } from '../src/web/owner-views.ts';
import { buildExport } from '../src/backup/export.ts';
import { call, connectAgent, registerOwner, startService, ToolError, type Browser, type TestEnv } from './helpers/harness.ts';

const err = (e: unknown) => JSON.parse((e as ToolError).message) as { error: string; message: string };

interface Warning {
  code: string;
  message: string;
}

describe('role reporting tree', () => {
  let env: TestEnv;
  let owner: Browser;
  let agent: Awaited<ReturnType<typeof connectAgent>>['client'];
  let clientId: string;
  let memberId: string;
  let leadId: string;
  let internId: string;
  const ownerActor = (): Actor => ({ kind: 'owner', memberId });

  async function roleOf(ref: string) {
    return owner.json<{ id: string; slug: string; rev: number; name: string; parent: { id: string; slug: string; name: string } | null; area: string }>(
      `/api/owner/entity/role/${ref}`,
    );
  }

  before(async () => {
    env = await startService();
    owner = (await registerOwner(env)).browser;
    const lead = await owner.json<{ id: string; slug: string }>('/api/owner/roles', { json: { name: 'Lead', slug: 'lead' } });
    const intern = await owner.json<{ id: string; slug: string }>('/api/owner/roles', { json: { name: 'Intern', slug: 'intern' } });
    leadId = lead.id;
    internId = intern.id;
    memberId = get<{ member_id: string }>(env.svc.db, 'SELECT member_id FROM role WHERE id = ?', leadId)!.member_id;
    const conn = await connectAgent(env, owner, 'Grok');
    agent = conn.client;
    const list = await owner.json<{ connections: { client_id: string; name: string }[] }>('/api/owner/connections');
    clientId = list.connections.find((c) => c.name === 'Grok')!.client_id;
    await owner.json(`/api/owner/connections/${encodeURIComponent(clientId)}/roles`, { json: { roles: ['lead', 'intern'], confirm: true } });
  });

  after(async () => {
    await env.close();
  });

  it('sets and clears parent by slug and by id; omitting parent leaves it unchanged', async () => {
    let intern = await roleOf('intern');
    await owner.json('/api/owner/roles', { json: { id: intern.id, rev: intern.rev, parent: 'lead' } });
    intern = await roleOf('intern');
    assert.equal(intern.parent?.slug, 'lead');
    assert.equal(intern.parent?.id, leadId);

    await owner.json('/api/owner/roles', { json: { id: intern.id, rev: intern.rev, name: 'Intern' } });
    intern = await roleOf('intern');
    assert.equal(intern.parent?.slug, 'lead');

    await owner.json('/api/owner/roles', { json: { id: intern.id, rev: intern.rev, parent: leadId } });
    intern = await roleOf('intern');
    assert.equal(intern.parent?.id, leadId);

    await owner.json('/api/owner/roles', { json: { id: intern.id, rev: intern.rev, parent: null } });
    intern = await roleOf('intern');
    assert.equal(intern.parent, null);
  });

  it('rejects self, missing, other-workspace, archived and cyclic parents', async () => {
    const intern = await roleOf('intern');
    const bad = async (parent: string | null, re: RegExp) => {
      const r = await owner.fetch('/api/owner/roles', { json: { id: intern.id, rev: intern.rev, parent } });
      assert.equal(r.status, 400);
      const body = (await r.json()) as { error: string; message: string };
      assert.equal(body.error, 'invalid');
      assert.match(body.message, re);
    };
    await bad('intern', /its own parent/);
    await bad('no-such-role', /not found/);

    const at = new Date().toISOString();
    run(env.svc.db, "INSERT INTO member (id, user_id, name, is_owner, created_at) VALUES ('mem_other_55', NULL, 'Other', 0, ?)", at);
    run(
      env.svc.db,
      "INSERT INTO role (id, member_id, slug, name, area, setup_notes, rev, created_at, updated_at, edit_any) VALUES ('rol_other_55', 'mem_other_55', 'outsider', 'Outsider', '', '', 1, ?, ?, 0)",
      at,
      at,
    );
    await bad('rol_other_55', /not found|this workspace/);

    await owner.json('/api/owner/roles', { json: { id: intern.id, rev: intern.rev, parent: 'lead' } });
    const lead = await roleOf('lead');
    const cycle = await owner.fetch('/api/owner/roles', { json: { id: lead.id, rev: lead.rev, parent: 'intern' } });
    assert.equal(cycle.status, 400);
    assert.match(((await cycle.json()) as { message: string }).message, /cycle/);

    const internClear = await roleOf('intern');
    await owner.json('/api/owner/roles', { json: { id: internClear.id, rev: internClear.rev, parent: null } });
    await owner.json('/api/owner/archive', { json: { type: 'role', id: leadId } });
    const intern2 = await roleOf('intern');
    const archived = await owner.fetch('/api/owner/roles', { json: { id: intern2.id, rev: intern2.rev, parent: 'lead' } });
    assert.equal(archived.status, 400);
    assert.match(((await archived.json()) as { message: string }).message, /archived/);
    await owner.json('/api/owner/archive', { json: { type: 'role', id: leadId, restore: true } });
  });

  it('lets a child under an archived parent save other fields, and keeps parent_id', async () => {
    const writer = await owner.json<{ id: string; rev: number }>('/api/owner/roles', { json: { name: 'Writer', slug: 'writer', parent: 'lead' } });
    await owner.json('/api/owner/archive', { json: { type: 'role', id: leadId } });
    const after = await owner.json<{ area: string; parent: { slug: string } | null }>('/api/owner/roles', {
      json: { id: writer.id, rev: writer.rev, area: 'Still reporting', parent: 'lead' },
    });
    assert.equal(after.area, 'Still reporting');
    assert.equal(after.parent?.slug, 'lead');
    await owner.json('/api/owner/archive', { json: { type: 'role', id: leadId, restore: true } });
    const w = await roleOf('writer');
    await owner.json('/api/owner/roles', { json: { id: w.id, rev: w.rev, parent: null } });
  });

  it('refuses to purge a role that still has reporting children, listing their slugs', async () => {
    const intern = await roleOf('intern');
    await owner.json('/api/owner/roles', { json: { id: intern.id, rev: intern.rev, parent: 'lead' } });
    await owner.json('/api/owner/archive', { json: { type: 'role', id: leadId } });
    const r = await owner.fetch('/api/owner/purge', { json: { type: 'role', id: leadId } });
    assert.equal(r.status, 400);
    const body = (await r.json()) as { error: string; message: string };
    assert.equal(body.error, 'invalid');
    assert.match(body.message, /reporting children/);
    assert.match(body.message, /intern/);
    const intern2 = await roleOf('intern');
    await owner.json('/api/owner/roles', { json: { id: intern2.id, rev: intern2.rev, parent: null } });
    await owner.json('/api/owner/archive', { json: { type: 'role', id: leadId, restore: true } });
  });

  it('rejects a parent chain deeper than 16 levels', async () => {
    const ids: string[] = [];
    let prev: string | null = null;
    for (let i = 0; i <= 16; i++) {
      const slug = `d${String(i).padStart(2, '0')}`;
      const created = await owner.json<{ id: string }>(
        '/api/owner/roles',
        { json: { name: `Depth ${i}`, slug, parent: prev } },
      );
      ids.push(created.id);
      prev = slug;
    }
    const tooDeep = await owner.fetch('/api/owner/roles', { json: { name: 'Too deep', slug: 'd17', parent: prev } });
    assert.equal(tooDeep.status, 400);
    assert.match(((await tooDeep.json()) as { message: string }).message, /deeper than 16/);
    for (const id of ids.reverse()) {
      const row = await roleOf(id);
      if (row.parent) await owner.json('/api/owner/roles', { json: { id: row.id, rev: row.rev, parent: null } });
      await owner.json('/api/owner/archive', { json: { type: 'role', id } });
      await owner.json('/api/owner/purge', { json: { type: 'role', id } });
    }
  });

  it('rejects hanging one 10-level chain under another when depth plus subtree height would exceed 16', async () => {
    const created: string[] = [];
    const makeChain = async (prefix: string) => {
      let prev: string | null = null;
      let root: { id: string; slug: string; rev: number } | undefined;
      let leafSlug: string | null = null;
      for (let i = 0; i < 10; i++) {
        const slug = `${prefix}${String(i).padStart(2, '0')}`;
        const role = await owner.json<{ id: string; slug: string; rev: number }>(
          '/api/owner/roles',
          { json: { name: `${prefix} ${i}`, slug, parent: prev } },
        );
        created.push(role.id);
        if (i === 0) root = role;
        prev = slug;
        leafSlug = slug;
      }
      return { root: root!, leafSlug: leafSlug! };
    };
    const a = await makeChain('a');
    const b = await makeChain('b');
    const hanging = await owner.fetch('/api/owner/roles', {
      json: { id: a.root.id, rev: a.root.rev, parent: b.leafSlug },
    });
    assert.equal(hanging.status, 400);
    assert.match(((await hanging.json()) as { message: string }).message, /deeper than 16/);
    const still = await roleOf(a.root.id);
    assert.equal(still.parent, null);
    for (const id of created.reverse()) {
      const row = await roleOf(id);
      if (row.parent) await owner.json('/api/owner/roles', { json: { id: row.id, rev: row.rev, parent: null } });
      await owner.json('/api/owner/archive', { json: { type: 'role', id } });
      await owner.json('/api/owner/purge', { json: { type: 'role', id } });
    }
  });

  it('in warn mode, a role without edit_any cannot re-parent itself or another role without a warning and an audit', async () => {
    const intern = await roleOf('intern');
    const own = await call<{ parent: { slug: string } | null; warnings?: Warning[] }>(agent, 'save_role', {
      id: intern.id,
      rev: intern.rev,
      parent: 'lead',
      claimed_role: 'intern',
    });
    assert.ok(own.warnings?.some((w) => w.code === 'edit_others' && /reporting line/.test(w.message)));
    assert.equal(own.parent?.slug, 'lead');
    const auditOwn = get<{ outcome: string; detail: string }>(
      env.svc.db,
      "SELECT outcome, detail FROM oauth_diag WHERE step = 'role_check' ORDER BY id DESC LIMIT 1",
    )!;
    assert.equal(auditOwn.outcome, 'warning');
    assert.equal(JSON.parse(auditOwn.detail).reason, 'edit_parent');

    const internClear = await roleOf('intern');
    await owner.json('/api/owner/roles', { json: { id: internClear.id, rev: internClear.rev, parent: null } });
    const lead = await roleOf('lead');
    const other = await call<{ parent: { slug: string } | null; warnings?: Warning[] }>(agent, 'save_role', {
      id: lead.id,
      rev: lead.rev,
      parent: 'intern',
      claimed_role: 'intern',
    });
    assert.ok(other.warnings?.some((w) => w.code === 'edit_others'));
    const lead2 = await roleOf('lead');
    if (lead2.parent) await owner.json('/api/owner/roles', { json: { id: lead2.id, rev: lead2.rev, parent: null } });
  });

  it('in enforce mode, a role without edit_any cannot set parent on itself or on another role', async () => {
    const intern0 = await roleOf('intern');
    if (intern0.parent) await owner.json('/api/owner/roles', { json: { id: intern0.id, rev: intern0.rev, parent: null } });
    const lead0 = await roleOf('lead');
    if (lead0.parent) await owner.json('/api/owner/roles', { json: { id: lead0.id, rev: lead0.rev, parent: null } });
    await owner.json('/api/owner/settings/role-enforcement', { json: { mode: 'enforce' } });
    const intern = await roleOf('intern');
    const settings = await owner.json<{ role_enforcement: string }>('/api/owner/connections');
    assert.equal(settings.role_enforcement, 'enforce', 'enforcement should be on');
    await assert.rejects(() => call(agent, 'save_role', { id: intern.id, rev: intern.rev, parent: 'lead', claimed_role: 'intern' }), (e: unknown) => {
      const b = err(e);
      assert.equal(b.error, 'forbidden', JSON.stringify(b));
      assert.match(b.message, /reporting line/);
      return true;
    });
    const audit = get<{ outcome: string; detail: string }>(
      env.svc.db,
      "SELECT outcome, detail FROM oauth_diag WHERE step = 'role_check' AND outcome = 'rejected' ORDER BY id DESC LIMIT 1",
    )!;
    assert.equal(JSON.parse(audit.detail).reason, 'edit_parent');

    const lead = await roleOf('lead');
    await assert.rejects(() => call(agent, 'save_role', { id: lead.id, rev: lead.rev, parent: 'intern', claimed_role: 'intern' }), (e: unknown) => {
      assert.equal(err(e).error, 'forbidden');
      return true;
    });
    await owner.json('/api/owner/settings/role-enforcement', { json: { mode: 'warn' } });
  });

  it('creating a role with parent null or omitted does not run the parent permission check (#81)', async () => {
    await owner.json('/api/owner/settings/role-enforcement', { json: { mode: 'enforce' } });
    const created = await call<{ id: string; slug: string; parent: { slug: string } | null; warnings?: Warning[] }>(
      agent,
      'save_role',
      { name: 'No parent on create', slug: 'no-parent-create', parent: null, claimed_role: 'intern' },
    );
    assert.equal(created.parent, null);
    assert.ok(!created.warnings?.some((w) => /reporting line/.test(w.message)));

    const omitted = await call<{ id: string; parent: { slug: string } | null; warnings?: Warning[] }>(
      agent,
      'save_role',
      { name: 'Omitted parent', slug: 'omitted-parent', claimed_role: 'intern' },
    );
    assert.equal(omitted.parent, null);

    const intern = await roleOf('intern');
    assert.equal(intern.parent, null);
    const unchanged = await call<{ parent: { slug: string } | null; warnings?: Warning[] }>(agent, 'save_role', {
      id: intern.id,
      rev: intern.rev,
      parent: null,
      claimed_role: 'intern',
    });
    assert.equal(unchanged.parent, null);
    assert.ok(!unchanged.warnings?.some((w) => /reporting line/.test(w.message)));
    await owner.json('/api/owner/settings/role-enforcement', { json: { mode: 'warn' } });

    for (const id of [created.id, omitted.id]) {
      await owner.json('/api/owner/archive', { json: { type: 'role', id } });
      await owner.json('/api/owner/purge', { json: { type: 'role', id } });
    }
  });

  it('an edit_any role and the owner can set parent, including at creation', async () => {
    await owner.json(`/api/owner/roles/${encodeURIComponent(leadId)}/edit-any`, { json: { edit_any: true } });
    const intern = await roleOf('intern');
    const asLead = await call<{ parent: { slug: string } | null; warnings?: Warning[] }>(agent, 'save_role', {
      id: intern.id,
      rev: intern.rev,
      parent: 'lead',
      claimed_role: 'lead',
    });
    assert.equal(asLead.parent?.slug, 'lead');
    assert.ok(!asLead.warnings?.some((w) => /reporting line/.test(w.message)));

    await owner.json('/api/owner/settings/role-enforcement', { json: { mode: 'enforce' } });
    const created = await call<{ id: string; slug: string; parent: { slug: string } | null }>(agent, 'save_role', {
      name: 'Reviewer',
      slug: 'reviewer',
      parent: 'lead',
      claimed_role: 'lead',
    });
    assert.equal(created.parent?.slug, 'lead');
    await owner.json('/api/owner/settings/role-enforcement', { json: { mode: 'warn' } });
    await owner.json(`/api/owner/roles/${encodeURIComponent(leadId)}/edit-any`, { json: { edit_any: false } });

    const intern2 = await roleOf('intern');
    await owner.json('/api/owner/roles', { json: { id: intern2.id, rev: intern2.rev, parent: null } });
    const rev = await roleOf('reviewer');
    await owner.json('/api/owner/roles', { json: { id: rev.id, rev: rev.rev, parent: null } });
  });

  it('save_role has no reports_to synonym for parent', async () => {
    const intern = await roleOf('intern');
    const out = await call<{ parent: { slug: string } | null }>(agent, 'save_role', {
      id: intern.id,
      rev: intern.rev,
      reports_to: 'lead',
      claimed_role: 'intern',
    });
    assert.equal(out.parent, intern.parent);
    const intern2 = await roleOf('intern');
    assert.equal(intern2.parent, null);
  });

  it('writes role.updated with parent_from/parent_to slugs and a reports-to summary, and shows the change in the review feed', async () => {
    const intern = await roleOf('intern');
    await call(agent, 'save_role', { id: intern.id, rev: intern.rev, parent: 'lead', claimed_role: 'intern' });
    const ev = get<{ action: string; summary: string; data: string; actor_kind: string }>(
      env.svc.db,
      "SELECT action, summary, data, actor_kind FROM event WHERE action = 'role.updated' AND entity_id = ? ORDER BY id DESC LIMIT 1",
      internId,
    )!;
    assert.equal(ev.actor_kind, 'agent');
    assert.match(ev.summary, /reports to lead/);
    const data = JSON.parse(ev.data) as { changed: string[]; parent_from: string | null; parent_to: string | null };
    assert.deepEqual(data.changed, ['parent']);
    assert.equal(data.parent_from, null);
    assert.equal(data.parent_to, 'lead');
    const feed = await owner.json<{ items: { action: string; summary: string; entity_id: string }[] }>('/api/owner/changes');
    assert.ok(feed.items.some((i) => i.action === 'role.updated' && i.entity_id === internId && /reports to lead/.test(i.summary)));
    const intern2 = await roleOf('intern');
    await owner.json('/api/owner/roles', { json: { id: intern2.id, rev: intern2.rev, parent: null } });
  });

  it('mapView draws tree edges, windows interactions, does not double-count created+assigned, and skips unknown or overlapping dashes', async () => {
    const intern0 = await roleOf('intern');
    if (intern0.parent) await owner.json('/api/owner/roles', { json: { id: intern0.id, rev: intern0.rev, parent: null, links: [] } });

    const byOwner = await owner.json<{ id: string }>('/api/owner/tasks', { json: { title: 'Lead work from owner', role: 'lead' } });
    const leadTask = await call<{ id: string }>(agent, 'save_task', { title: 'Lead owns this', role: 'lead', claimed_role: 'lead' });
    await call(agent, 'save_task', { title: 'Intern work', role: 'intern', claimed_role: 'intern' });
    await call(agent, 'comment_task', { id: leadTask.id, body: 'Intern comments.', claimed_role: 'intern' });
    await call(agent, 'claim_task', { id: leadTask.id, claimed_role: 'intern' });

    const selfTask = await call<{ id: string }>(agent, 'save_task', { title: 'Intern own claim', role: 'intern', claimed_role: 'intern' });
    await call(agent, 'claim_task', { id: selfTask.id, claimed_role: 'intern' });
    const unassigned = await call<{ id: string }>(agent, 'save_task', { title: 'Nobody yet', claimed_role: 'intern' });
    await call(agent, 'claim_task', { id: unassigned.id, claimed_role: 'intern' });

    const at = new Date().toISOString();
    run(
      env.svc.db,
      "INSERT INTO event (member_id, at, actor_kind, claimed_role, entity_type, entity_id, action, summary, data) VALUES (?, ?, 'agent', 'ghost', 'task', ?, 'task.assigned', 'Ghost assigned', ?)",
      memberId,
      at,
      byOwner.id,
      JSON.stringify({ role_id: leadId }),
    );
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    run(
      env.svc.db,
      "INSERT INTO event (member_id, at, actor_kind, claimed_role, entity_type, entity_id, action, summary, data) VALUES (?, ?, 'agent', 'intern', 'task', ?, 'task.commented', 'Old comment', ?)",
      memberId,
      old,
      leadTask.id,
      JSON.stringify({ role_id: leadId }),
    );

    const before = mapView(env.svc.db, memberId);
    assert.equal(before.interactions_truncated, false);
    const createdAssigned = before.interactions.filter((i) => i.from === 'owner' && i.to === 'lead' && i.kind === 'assigned');
    assert.equal(createdAssigned.length, 1);
    assert.equal(createdAssigned[0]!.count, 1, 'creating a task must not count created and assigned twice');
    assert.ok(before.interactions.some((i) => i.from === 'intern' && i.to === 'lead' && i.kind === 'commented'));
    assert.ok(before.interactions.some((i) => i.from === 'intern' && i.to === 'lead' && i.kind === 'claimed'));
    assert.ok(!before.interactions.some((i) => i.from === 'intern' && i.to === 'intern' && i.kind === 'claimed'));
    assert.ok(!before.interactions.some((i) => i.from === 'ghost'));
    assert.ok(!before.interactions.some((i) => i.kind === 'commented' && i.last_at === old));

    const intern = await roleOf('intern');
    await owner.json('/api/owner/roles', { json: { id: intern.id, rev: intern.rev, parent: 'lead', links: [{ to: 'lead', type: 'reports_to' }] } });
    const map = mapView(env.svc.db, memberId);
    const internNode = map.roles.find((r) => r.slug === 'intern')!;
    assert.equal(internNode.parent?.slug, 'lead');
    assert.equal(internNode.depth, 1);
    assert.ok(map.links.some((l) => l.from === 'intern' && l.to === 'lead' && l.type === 'reports_to'));
    assert.ok(!map.links.some((l) => l.from === 'intern' && l.to === 'lead' && l.type === 'parent'), 'no duplicate parent edge when reports_to already exists');
    assert.ok(!map.interactions.some((i) => i.from === 'intern' && i.to === 'lead'), 'no dashed edge where a solid line already exists');

    const intern2 = await roleOf('intern');
    await owner.json('/api/owner/roles', { json: { id: intern2.id, rev: intern2.rev, parent: null, links: [] } });
  });

  it('does not draw an agent that claimed the role "owner" in warn mode as the owner on the map', async () => {
    const settings = await owner.json<{ role_enforcement: string }>('/api/owner/connections');
    assert.equal(settings.role_enforcement, 'warn');
    const task = await owner.json<{ id: string }>('/api/owner/tasks', { json: { title: 'Lead work for fake owner', role: 'lead' } });
    const commented = await call<{ warnings?: Warning[] }>(agent, 'comment_task', {
      id: task.id,
      body: 'Agent posing as owner',
      claimed_role: 'owner',
    });
    assert.ok(commented.warnings?.some((w) => w.code === 'role_not_found'));
    const ev = get<{ actor_kind: string; claimed_role: string }>(
      env.svc.db,
      "SELECT actor_kind, claimed_role FROM event WHERE action = 'task.commented' AND entity_id = ? ORDER BY id DESC LIMIT 1",
      task.id,
    )!;
    assert.equal(ev.actor_kind, 'agent');
    assert.equal(ev.claimed_role, 'owner');
    const map = mapView(env.svc.db, memberId);
    assert.ok(
      !map.interactions.some((i) => i.from === 'owner' && i.to === 'lead' && i.kind === 'commented'),
      'an agent claiming "owner" must not be drawn as the owner',
    );
  });

  it('start and get expose parent but not interactions', async () => {
    const intern = await roleOf('intern');
    await owner.json('/api/owner/roles', { json: { id: intern.id, rev: intern.rev, parent: 'lead' } });
    const started = await call<{ data: { roles: { slug: string; parent: string | null }[]; role: { parent: { slug: string } | null; interactions?: unknown }; interactions?: unknown } }>(
      agent,
      'start',
      { role: 'intern' },
    );
    assert.equal(started.data.roles.find((r) => r.slug === 'intern')?.parent, 'lead');
    assert.equal(started.data.role.parent?.slug, 'lead');
    assert.equal('interactions' in started.data, false);
    assert.equal('interactions' in started.data.role, false);
    const got = await call<{ parent: { slug: string } | null; interactions?: unknown }>(agent, 'get', { type: 'role', id: 'intern' });
    assert.equal(got.parent?.slug, 'lead');
    assert.equal('interactions' in got, false);
    const intern2 = await roleOf('intern');
    await owner.json('/api/owner/roles', { json: { id: intern2.id, rev: intern2.rev, parent: null } });
  });

  it('export front matter includes the parent slug', async () => {
    const intern = await roleOf('intern');
    await owner.json('/api/owner/roles', { json: { id: intern.id, rev: intern.rev, parent: 'lead' } });
    const { zip } = buildExport(env.svc.db, memberId);
    const files = unzipSync(zip);
    const md = Buffer.from(files['roles/intern.md']!).toString();
    assert.match(md, /^parent:\s*"lead"\s*$/m);
    const intern2 = await roleOf('intern');
    await owner.json('/api/owner/roles', { json: { id: intern2.id, rev: intern2.rev, parent: null } });
  });
});

describe('role reporting tree: scale, cap and upgrade', () => {
  it('mapView handles ~200 roles and flags a 2000-event cap', async () => {
    const env = await startService();
    try {
      const { browser: owner } = await registerOwner(env);
      const memberId = get<{ id: string }>(env.svc.db, 'SELECT id FROM member WHERE is_owner = 1')!.id;
      const root = await owner.json<{ id: string }>('/api/owner/roles', { json: { name: 'Root', slug: 'root' } });
      for (let i = 0; i < 199; i++) {
        await owner.json('/api/owner/roles', { json: { name: `Role ${i}`, slug: `r${i}`, parent: 'root' } });
      }
      const at = new Date().toISOString();
      const payload = JSON.stringify({ role_id: root.id });
      run(env.svc.db, 'BEGIN IMMEDIATE');
      for (let i = 0; i < MAP_INTERACTION_EVENT_CAP; i++) {
        run(
          env.svc.db,
          "INSERT INTO event (member_id, at, actor_kind, claimed_role, entity_type, entity_id, action, summary, data) VALUES (?, ?, 'owner', NULL, 'task', ?, 'task.commented', 'bulk', ?)",
          memberId,
          at,
          `tsk_bulk_${i}`,
          payload,
        );
      }
      run(env.svc.db, 'COMMIT');
      const map = mapView(env.svc.db, memberId);
      assert.ok(map.roles.length >= 200);
      assert.equal(map.roles.find((r) => r.slug === 'root')?.depth, 0);
      assert.ok(map.roles.some((r) => r.slug === 'r0' && r.depth === 1 && r.parent?.slug === 'root'));
      assert.equal(map.interactions_truncated, true);
    } finally {
      await env.close();
    }
  });

  it('upgrades a populated 0.2.0 database: parent_id is NULL and existing reports_to links stay', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsmcp-role-parent-'));
    const db = openDatabase(path.join(dir, 'workspace.sqlite'));
    db.exec('CREATE TABLE IF NOT EXISTS app_migration (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
    for (const m of migrations.filter((mig) => mig.id <= 4)) {
      db.exec(m.sql);
      run(db, 'INSERT INTO app_migration (id, name, applied_at) VALUES (?, ?, ?)', m.id, m.name, new Date().toISOString());
    }
    const at = '2026-06-01T00:00:00.000Z';
    run(db, "INSERT INTO member (id, user_id, name, is_owner, created_at) VALUES ('mem_v020', NULL, 'Owner', 1, ?)", at);
    run(
      db,
      "INSERT INTO role (id, member_id, slug, name, area, setup_notes, rev, created_at, updated_at, edit_any) VALUES ('rol_mgr', 'mem_v020', 'manager', 'Manager', 'Run the team', '', 1, ?, ?, 0)",
      at,
      at,
    );
    run(
      db,
      "INSERT INTO role (id, member_id, slug, name, area, setup_notes, rev, created_at, updated_at, edit_any) VALUES ('rol_wri', 'mem_v020', 'writer', 'Writer', 'Write', '', 1, ?, ?, 0)",
      at,
      at,
    );
    run(
      db,
      "INSERT INTO role_link (id, member_id, from_role_id, to_role_id, type, created_at) VALUES ('rlk_v020', 'mem_v020', 'rol_wri', 'rol_mgr', 'reports_to', ?)",
      at,
    );
    const colsBefore = all<{ name: string }>(db, 'PRAGMA table_info(role)').map((c) => c.name);
    assert.ok(!colsBefore.includes('parent_id'));

    const applied = runAppMigrations(db);
    assert.equal(applied, 3);
    assert.equal(get<{ name: string }>(db, "SELECT name FROM app_migration WHERE id = 5")?.name, 'role_parent');
    assert.equal(get<{ name: string }>(db, "SELECT name FROM app_migration WHERE id = 6")?.name, 'review-comments');
    assert.equal(get<{ name: string }>(db, "SELECT name FROM app_migration WHERE id = 7")?.name, 'github-issue-roles');
    const cols = all<{ name: string }>(db, 'PRAGMA table_info(role)').map((c) => c.name);
    assert.ok(cols.includes('parent_id'));
    const parents = all<{ slug: string; parent_id: string | null }>(db, 'SELECT slug, parent_id FROM role ORDER BY slug');
    assert.deepEqual(
      parents.map((r) => [r.slug, r.parent_id]),
      [
        ['manager', null],
        ['writer', null],
      ],
    );
    const link = get<{ from_role_id: string; to_role_id: string; type: string }>(db, 'SELECT from_role_id, to_role_id, type FROM role_link WHERE id = ?', 'rlk_v020')!;
    assert.equal(link.from_role_id, 'rol_wri');
    assert.equal(link.to_role_id, 'rol_mgr');
    assert.equal(link.type, 'reports_to');
    const idx = all<{ name: string }>(db, "SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('role_parent', 'event_member_action')").map((i) => i.name).sort();
    assert.deepEqual(idx, ['event_member_action', 'role_parent']);
    db.close();
  });
});
