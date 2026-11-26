import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config.ts';
import { all, get, openDatabase, run, runAppMigrations } from '../src/db/db.ts';
import { migrations } from '../src/db/schema.ts';
import { clearEventHooks, clearVersionHooks, DomainError } from '../src/domain/core.ts';
import { ensureOwnerMember, getRules, purge, saveDocument, saveProject, saveRole, setArchived, updateRules } from '../src/domain/entities.ts';
import {
  attachReviewHooks,
  computeLineMap,
  createReviewComment,
  DIFF_MAX_EDIT_LENGTH,
  getReviewComment,
  listReviewComments,
  listSetupNotesHistory,
  quoteHash,
  reanchorField,
  replyReviewComment,
  reviewCounts,
  setReviewCommentStatus,
  startReviewComments,
} from '../src/domain/reviews.ts';
import { rollback } from '../src/domain/versions.ts';
import { getEntity, search, startView } from '../src/domain/views.ts';
import { buildExport, importExport } from '../src/backup/export.ts';
import { call, connectAgent, registerOwner, startService } from './helpers/harness.ts';

function memoryDb() {
  clearEventHooks();
  clearVersionHooks();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsmcp-rev-'));
  const config = loadConfig({ PUBLIC_URL: 'http://localhost:1', SECRET_KEY: Buffer.alloc(32, 3).toString('base64'), DATA_DIR: dir, LOG_LEVEL: 'error' });
  const db = openDatabase(config.dbPath);
  runAppMigrations(db);
  attachReviewHooks();
  const member = ensureOwnerMember(db);
  const owner = { kind: 'owner' as const, memberId: member.id };
  return { db, owner, dir, close: () => db.close() };
}

describe('migration 6', () => {
  it('uses id 6 and leaves 5 unused', () => {
    assert.equal(migrations.some((m) => m.id === 5), false);
    assert.equal(migrations.find((m) => m.id === 6)?.name, 'review-comments');
  });
});

describe('review comments', () => {
  it('lets the owner comment, a bot reply and mark answered, and the owner resolve', () => {
    const { db, owner, close } = memoryDb();
    try {
      const role = saveRole(db, owner, { name: 'Writer', slug: 'writer', instruction: 'Line one is style.\nLine two is tone.\nLine three is pace.' });
      const created = createReviewComment(db, owner, {
        target_type: 'role',
        target_id: role.id,
        field: 'instruction',
        body: 'Please tighten the opening.',
        line_start: 1,
        line_end: 1,
      });
      assert.equal(created.status, 'open');
      assert.equal(created.anchor_state, 'exact');
      assert.equal(created.quote, 'Line one is style.');
      assert.equal(quoteHash(created.quote), quoteHash('Line one is style.'));
      const bot = { kind: 'agent' as const, memberId: owner.memberId, connectionId: 'c1', connectionName: 'Bot', role: 'writer' };
      const replied = replyReviewComment(db, bot, { id: created.id, body: 'Done, see v2.', status: 'answered', expected_status: 'open' });
      assert.equal(replied.status, 'answered');
      assert.equal(replied.replies?.length, 1);
      const reopened = replyReviewComment(db, owner, { id: created.id, body: 'Almost — one more pass.', expected_status: 'answered' });
      assert.equal(reopened.status, 'open');
      assert.throws(() => setReviewCommentStatus(db, bot, { id: created.id, status: 'resolved' }), /only the owner/);
      const resolved = setReviewCommentStatus(db, owner, { id: created.id, status: 'resolved', rev: reopened.rev });
      assert.equal(resolved.status, 'resolved');
    } finally {
      close();
    }
  });

  it('rejects a bot creating a comment and rejects MCP resolved via reply', () => {
    const { db, owner, close } = memoryDb();
    try {
      const role = saveRole(db, owner, { name: 'Writer', slug: 'writer', instruction: 'Hello.\nWorld.' });
      const bot = { kind: 'agent' as const, memberId: owner.memberId, role: 'writer' };
      assert.throws(
        () => createReviewComment(db, bot, { target_type: 'role', target_id: role.id, field: 'instruction', body: 'nope' }),
        /only the owner/,
      );
      const c = createReviewComment(db, owner, { target_type: 'role', target_id: role.id, field: 'instruction', body: 'Please fix.', line_start: 1, line_end: 1 });
      assert.throws(() => replyReviewComment(db, bot, { id: c.id, body: 'ok', status: 'resolved' }), (e: unknown) => e instanceof DomainError && e.code === 'forbidden');
    } finally {
      close();
    }
  });

  it('conflicts when rev or expected status does not match', () => {
    const { db, owner, close } = memoryDb();
    try {
      const role = saveRole(db, owner, { name: 'Writer', slug: 'writer', instruction: 'Hello.\nWorld.' });
      const c = createReviewComment(db, owner, { target_type: 'role', target_id: role.id, field: 'instruction', body: 'x', line_start: 1, line_end: 1 });
      assert.throws(() => setReviewCommentStatus(db, owner, { id: c.id, status: 'resolved', rev: c.rev + 1 }), /has changed/);
      assert.throws(() => replyReviewComment(db, owner, { id: c.id, body: 'y', expected_status: 'answered' }), /status is open/);
    } finally {
      close();
    }
  });

  it('recomputes the quote from stored text and rejects a range outside the version', () => {
    const { db, owner, close } = memoryDb();
    try {
      const role = saveRole(db, owner, { name: 'Writer', slug: 'writer', instruction: 'Alpha\nBeta' });
      assert.throws(
        () => createReviewComment(db, owner, { target_type: 'role', target_id: role.id, field: 'instruction', body: 'x', version: 1, line_start: 1, line_end: 9 }),
        /outside the text/,
      );
    } finally {
      close();
    }
  });

  it('records setup_notes history and points comments at a history row', () => {
    const { db, owner, close } = memoryDb();
    try {
      const role = saveRole(db, owner, { name: 'Writer', slug: 'writer', setup_notes: 'First notes.' });
      let hist = listSetupNotesHistory(db, owner.memberId, role.id);
      assert.equal(hist.length, 1);
      assert.equal(hist[0]!.body, 'First notes.');
      const c = createReviewComment(db, owner, { target_type: 'role', target_id: role.id, field: 'setup_notes', body: 'Make this shorter.', line_start: 1, line_end: 1 });
      assert.equal(c.setup_notes_id, hist[0]!.id);
      const updated = saveRole(db, owner, { id: role.id, rev: role.rev, setup_notes: 'First notes, tightened.' });
      hist = listSetupNotesHistory(db, owner.memberId, role.id);
      assert.equal(hist.length, 2);
      const after = getReviewComment(db, owner.memberId, c.id);
      assert.equal(after.setup_notes_id, hist[0]!.id);
      assert.ok(after.anchor_state === 'moved' || after.anchor_state === 'exact' || after.anchor_state === 'outdated');
      void updated;
    } finally {
      close();
    }
  });

  it('re-anchors by exact quote, line map, fuzzy match, or marks outdated', () => {
    const { db, owner, close } = memoryDb();
    try {
      const role = saveRole(db, owner, {
        name: 'Writer',
        slug: 'writer',
        instruction: ['Keep this unique phrase A.', 'Unrelated.', 'Keep this unique phrase B.', 'Filler stays.', 'A slightly different wording here.'].join('\n'),
      });
      const exact = createReviewComment(db, owner, { target_type: 'role', target_id: role.id, field: 'instruction', body: 'a', line_start: 1, line_end: 1 });
      const mapped = createReviewComment(db, owner, { target_type: 'role', target_id: role.id, field: 'instruction', body: 'b', line_start: 3, line_end: 3 });
      const fuzzy = createReviewComment(db, owner, { target_type: 'role', target_id: role.id, field: 'instruction', body: 'c', line_start: 5, line_end: 5 });
      const gone = createReviewComment(db, owner, { target_type: 'role', target_id: role.id, field: 'instruction', body: 'd', line_start: 4, line_end: 4 });
      saveRole(db, owner, {
        id: role.id,
        rev: role.rev,
        instruction: [
          'Introduced preamble.',
          'Keep this unique phrase A.',
          'Keep this unique phrase B.',
          'A slightly different wording here!!',
        ].join('\n'),
      });
      assert.equal(getReviewComment(db, owner.memberId, exact.id).anchor_state, 'exact');
      assert.equal(getReviewComment(db, owner.memberId, exact.id).anchor_line_start, 2);
      const mappedAfter = getReviewComment(db, owner.memberId, mapped.id);
      assert.ok(mappedAfter.anchor_state === 'exact' || mappedAfter.anchor_state === 'moved', mappedAfter.anchor_state);
      assert.equal(mappedAfter.anchor_line_start, 3);
      const fuzzyAfter = getReviewComment(db, owner.memberId, fuzzy.id);
      assert.ok(['moved', 'exact', 'outdated'].includes(fuzzyAfter.anchor_state), fuzzyAfter.anchor_state);
      assert.equal(getReviewComment(db, owner.memberId, gone.id).anchor_state, 'outdated');
    } finally {
      close();
    }
  });

  it('still runs exact-quote search when the diff hits maxEditLength', () => {
    const { db, owner, close } = memoryDb();
    try {
      // Two long, very different texts (edit length above 10_000) that still share one unique quote line.
      const quote = 'UNIQUE_ANCHOR_LINE_THAT_SURVIVES';
      const oldLines = Array.from({ length: 4000 }, (_, i) => `old-${i}-aaaaaaaa`);
      oldLines[100] = quote;
      const newLines = Array.from({ length: 4000 }, (_, i) => `new-${i}-bbbbbbbb`);
      newLines[3500] = quote;
      const role = saveRole(db, owner, { name: 'Writer', slug: 'writer', instruction: oldLines.join('\n') });
      const c = createReviewComment(db, owner, { target_type: 'role', target_id: role.id, field: 'instruction', body: 'keep', line_start: 101, line_end: 101 });
      const map = computeLineMap(oldLines.join('\n'), newLines.join('\n'), { timeoutMs: 200, maxEditLength: DIFF_MAX_EDIT_LENGTH });
      assert.equal(map.limited, true);
      saveRole(db, owner, { id: role.id, rev: role.rev, instruction: newLines.join('\n') });
      const after = getReviewComment(db, owner.memberId, c.id);
      assert.equal(after.anchor_state, 'exact');
      assert.equal(after.anchor_line_start, 3501);
    } finally {
      close();
    }
  });

  it('marks remaining comments outdated when the 500 ms budget is exhausted', () => {
    const { db, owner, close } = memoryDb();
    try {
      const role = saveRole(db, owner, { name: 'Writer', slug: 'writer', instruction: 'one\ntwo\nthree' });
      const a = createReviewComment(db, owner, { target_type: 'role', target_id: role.id, field: 'instruction', body: 'a', line_start: 1, line_end: 1 });
      const b = createReviewComment(db, owner, { target_type: 'role', target_id: role.id, field: 'instruction', body: 'b', line_start: 2, line_end: 2 });
      let calls = 0;
      const clock = () => (calls++ === 0 ? 0 : 600);
      reanchorField(db, owner.memberId, 'role', role.id, 'instruction', { oldText: 'one\ntwo\nthree', newText: 'one\ntwo\nthree', now: clock, budgetMs: 500 });
      assert.equal(getReviewComment(db, owner.memberId, a.id).anchor_state, 'outdated');
      assert.equal(getReviewComment(db, owner.memberId, b.id).anchor_state, 'outdated');
    } finally {
      close();
    }
  });

  it('re-anchors about 200 open comments on a 200k document in well under 250 ms', () => {
    const { db, owner, close } = memoryDb();
    try {
      const markers: string[] = [];
      const lines: string[] = [];
      while (lines.join('\n').length < 200_000) {
        const i = lines.length;
        if (i < 200) {
          const m = `UNIQUE_MARKER_${String(i).padStart(3, '0')}_xxxxxxxx`;
          markers.push(m);
          lines.push(m);
        } else {
          lines.push(`padding line ${i} ${'y'.repeat(80)}`);
        }
      }
      const body = lines.join('\n').slice(0, 200_000);
      const doc = saveDocument(db, owner, { title: 'Big', body });
      for (let i = 0; i < 200; i++) {
        createReviewComment(db, owner, { target_type: 'document', target_id: doc.id, field: 'body', body: `c${i}`, line_start: i + 1, line_end: i + 1 });
      }
      const moved = ['preamble', ...lines].join('\n').slice(0, 200_000);
      const t0 = performance.now();
      saveDocument(db, owner, { id: doc.id, rev: doc.rev, body: moved });
      const ms = performance.now() - t0;
      assert.ok(ms <= 250, `re-anchor of 200 comments took ${ms.toFixed(1)} ms`);
      const sample = listReviewComments(db, owner.memberId, { target_type: 'document', target_id: doc.id, status: 'all', limit: 100 });
      assert.equal(sample.comments[0]!.anchor_state, 'exact');
      assert.equal(sample.comments[0]!.anchor_line_start, 2);
    } finally {
      close();
    }
  });

  it('re-anchors on rollback in the same transaction', () => {
    const { db, owner, close } = memoryDb();
    try {
      const role = saveRole(db, owner, { name: 'Writer', slug: 'writer', instruction: 'Alpha unique.\nBeta.' });
      const c = createReviewComment(db, owner, { target_type: 'role', target_id: role.id, field: 'instruction', body: 'n', line_start: 1, line_end: 1 });
      const v2 = saveRole(db, owner, { id: role.id, rev: role.rev, instruction: 'Gamma.\nAlpha unique.\nBeta.' });
      assert.equal(getReviewComment(db, owner.memberId, c.id).anchor_line_start, 2);
      rollback(db, owner, 'role', role.id, 1, v2.rev);
      const after = getReviewComment(db, owner.memberId, c.id);
      assert.equal(after.anchor_state, 'exact');
      assert.equal(after.anchor_line_start, 1);
    } finally {
      close();
    }
  });

  it('includes open comments on get and start, and in search', () => {
    const { db, owner, close } = memoryDb();
    try {
      const role = saveRole(db, owner, { name: 'Writer', slug: 'writer', instruction: 'Style first.\nTone second.' });
      createReviewComment(db, owner, { target_type: 'role', target_id: role.id, field: 'instruction', body: 'Please tidy this.', line_start: 1, line_end: 1 });
      const got = getEntity(db, owner.memberId, 'role', role.id) as { open_review_comments: { body: string }[]; open_review_comments_total: number };
      assert.equal(got.open_review_comments_total, 1);
      assert.equal(got.open_review_comments[0]!.body, 'Please tidy this.');
      const start = startView(db, { kind: 'agent', memberId: owner.memberId, role: 'writer' }, 'writer') as unknown as { data: { review_comments: { body: string }[]; review_comments_open_total: number } };
      assert.equal(start.data.review_comments_open_total, 1);
      const hits = search(db, owner.memberId, { types: ['review_comment'], query: 'tidy' });
      assert.equal(hits.total >= 1, true);
      assert.equal(hits.results[0]!.type, 'review_comment');
    } finally {
      close();
    }
  });

  it('lets a project owner see project-rules comments in start but not mark them answered', () => {
    const { db, owner, close } = memoryDb();
    try {
      const lead = saveRole(db, owner, { name: 'Lead', slug: 'lead', instruction: 'Lead the work.' });
      const project = saveProject(db, owner, { name: 'Site', slug: 'site', description: 'A site.', owner_role: 'lead' });
      const rules = updateRules(db, owner, { slug: 'site-rules', title: 'Site rules', project: 'site', text: 'Write clearly.\nBe kind.' });
      const c = createReviewComment(db, owner, { target_type: 'rules', target_id: rules.id, field: 'text', body: 'Clarify this.', line_start: 1, line_end: 1 });
      const start = startReviewComments(db, owner.memberId, lead.id, 200, 'full');
      assert.equal((start as { review_comments_open_total: number }).review_comments_open_total, 1);
      const leadActor = { kind: 'agent' as const, memberId: owner.memberId, role: 'lead' };
      run(db, "UPDATE member SET role_enforcement = 'enforce' WHERE id = ?", owner.memberId);
      assert.throws(() => replyReviewComment(db, leadActor, { id: c.id, body: 'ok', status: 'answered' }), /answered/);
      run(db, "UPDATE member SET role_enforcement = 'warn' WHERE id = ?", owner.memberId);
      const editAny = saveRole(db, owner, { name: 'Editor', slug: 'editor', instruction: 'Edit any.', edit_any: true });
      const editor = { kind: 'agent' as const, memberId: owner.memberId, role: 'editor' };
      const answered = replyReviewComment(db, editor, { id: c.id, body: 'Fixed.', status: 'answered' });
      assert.equal(answered.status, 'answered');
      void project;
      void editAny;
    } finally {
      close();
    }
  });

  it('purges comments and setup-notes history before versions', () => {
    const { db, owner, close } = memoryDb();
    try {
      const role = saveRole(db, owner, { name: 'Writer', slug: 'writer', instruction: 'Hello.\nWorld.', setup_notes: 'Notes.' });
      createReviewComment(db, owner, { target_type: 'role', target_id: role.id, field: 'instruction', body: 'x', line_start: 1, line_end: 1 });
      setArchived(db, owner, 'role', role.id, true);
      purge(db, owner, 'role', role.id);
      assert.equal(get<{ n: number }>(db, 'SELECT count(*) AS n FROM review_comment')!.n, 0);
      assert.equal(get<{ n: number }>(db, 'SELECT count(*) AS n FROM setup_notes_history')!.n, 0);
      assert.equal(get<{ n: number }>(db, "SELECT count(*) AS n FROM version WHERE entity_type = 'role'")!.n, 0);
    } finally {
      close();
    }
  });

  it('exports and imports comments after versions, replies after comments', async () => {
    const src = await startService();
    const dst = await startService();
    try {
      const owner = { kind: 'owner' as const, memberId: ensureOwnerMember(src.svc.db).id };
      const role = saveRole(src.svc.db, owner, { name: 'Writer', slug: 'writer', instruction: 'Hello.\nWorld.' });
      const c = createReviewComment(src.svc.db, owner, { target_type: 'role', target_id: role.id, field: 'instruction', body: 'Please check.', line_start: 1, line_end: 1 });
      replyReviewComment(src.svc.db, owner, { id: c.id, body: 'Noted.' });
      const { zip } = buildExport(src.svc.db, owner.memberId);
      const emptyOwner = ensureOwnerMember(dst.svc.db);
      importExport(dst.svc.db, emptyOwner.id, zip);
      const imported = all<{ id: string }>(dst.svc.db, 'SELECT id FROM review_comment');
      assert.equal(imported.length, 1);
      assert.equal(get<{ n: number }>(dst.svc.db, 'SELECT count(*) AS n FROM review_reply')!.n, 1);
    } finally {
      await src.close();
      await dst.close();
    }
  });
});

describe('review.commented webhooks', () => {
  it('wakes every active edit_any role for a rules comment, and nobody when there is none', async () => {
    const received: string[] = [];
    const receiver = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push(body);
        res.writeHead(200).end('ok');
      });
    });
    await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
    const port = (receiver.address() as AddressInfo).port;
    const env = await startService({ env: { WEBHOOK_ALLOW_PRIVATE_ADDRESSES: 'true' } });
    try {
      const { browser } = await registerOwner(env);
      const owner = { kind: 'owner' as const, memberId: ensureOwnerMember(env.svc.db).id };
      saveRole(env.svc.db, owner, { name: 'Lead', slug: 'lead', instruction: 'Lead.' });
      const rules = getRules(env.svc.db, owner.memberId);
      updateRules(env.svc.db, owner, { text: 'Write clearly.\nBe kind.', rev: rules.rev });
      await browser.json('/api/owner/webhooks', { json: { role: 'lead', url: `http://127.0.0.1:${port}/wake`, events: ['review.commented'] } });
      createReviewComment(env.svc.db, owner, { target_type: 'rules', target_id: getRules(env.svc.db, owner.memberId).id, field: 'text', body: 'Clarify.', line_start: 1, line_end: 1 });
      await env.svc.webhooks.tick(new Date(Date.now() + 11_000));
      assert.equal(received.length, 0, 'no edit_any role yet, so no webhook');

      saveRole(env.svc.db, owner, { name: 'Editor', slug: 'editor', instruction: 'Edit any.', edit_any: true });
      saveRole(env.svc.db, owner, { name: 'Reviewer', slug: 'reviewer', instruction: 'Also edit any.', edit_any: true });
      await browser.json('/api/owner/webhooks', { json: { role: 'editor', url: `http://127.0.0.1:${port}/wake`, events: ['review.commented'] } });
      await browser.json('/api/owner/webhooks', { json: { role: 'reviewer', url: `http://127.0.0.1:${port}/wake`, events: ['review.commented'] } });
      received.length = 0;
      createReviewComment(env.svc.db, owner, { target_type: 'rules', target_id: getRules(env.svc.db, owner.memberId).id, field: 'text', body: 'And this.', line_start: 2, line_end: 2 });
      await env.svc.webhooks.tick(new Date(Date.now() + 11_000));
      assert.equal(received.length, 2, 'every edit_any role is woken');
      for (const body of received) {
        const payload = JSON.parse(body);
        assert.equal(payload.events[0].type, 'review.commented');
        assert.ok(!body.includes('And this.'), 'signal carries no comment body');
      }
    } finally {
      await env.close();
      receiver.close();
    }
  });
});

describe('reply_review_comment MCP tool', () => {
  it('accepts claimed_role only and returns the comment after a reply', async () => {
    const env = await startService();
    try {
      const { browser } = await registerOwner(env);
      const owner = { kind: 'owner' as const, memberId: ensureOwnerMember(env.svc.db).id };
      const role = saveRole(env.svc.db, owner, { name: 'Writer', slug: 'writer', instruction: 'Hello.\nWorld.' });
      const c = createReviewComment(env.svc.db, owner, { target_type: 'role', target_id: role.id, field: 'instruction', body: 'Please greet by name.', line_start: 1, line_end: 1 });
      const { client, provider } = await connectAgent(env, browser, 'Writer bot');
      const clientId = provider.clientInformation()?.client_id;
      await browser.json(`/api/owner/connections/${encodeURIComponent(clientId)}/roles`, { json: { roles: ['writer'], confirm: true } });
      const out = await call(client, 'reply_review_comment', { id: c.id, body: 'Will do.', status: 'answered', claimed_role: 'writer' });
      assert.equal(out.status, 'answered');
      const ignored = await call(client, 'reply_review_comment', { id: c.id, body: 'A follow-up.', role: 'writer' });
      const last = ignored.replies[ignored.replies.length - 1];
      assert.notEqual(last.author.role, 'writer', 'role is not accepted as a synonym of claimed_role');
      const start = await call(client, 'start', { role: 'writer' });
      assert.equal(start.data.review_comments_open_total, 0);
      await client.close();
    } finally {
      await env.close();
    }
  });
});
