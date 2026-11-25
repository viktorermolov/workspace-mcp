import type { Config } from '../config.ts';
import { all, get, now, run, tx, type DB } from '../db/db.ts';
import { DomainError, newId, onEvent, recordEvent, type Actor, type EventRecord } from '../domain/core.ts';
import { requireRole } from '../domain/entities.ts';
import { decryptSecret, encryptSecret, hmacSha256Hex, randomToken } from '../util/crypto.ts';
import { errMessage, log } from '../util/log.ts';
import { postJson, validateWebhookUrl, type PostResult } from './transport.ts';

/**
 * Wake-up webhooks per role. A request carries only a signal (event ids and types, role id, time);
 * the agent fetches the content through MCP. Deliveries are queued in the same transaction as the
 * change, coalesced for a short window, signed, retried with backoff and logged.
 */
export const WEBHOOK_EVENTS = ['task.assigned', 'task.updated', 'task.commented', 'task.unblocked', 'role.updated'] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export const COALESCE_MS = 10_000;
export const TIMEOUT_MS = 10_000;
/** Delay before attempt n+1 (attempt 1 is the first try). */
export const BACKOFF_MS = [30_000, 120_000, 600_000, 1_800_000, 7_200_000];
export const MAX_ATTEMPTS = BACKOFF_MS.length + 1;

export interface WebhookRow {
  id: string;
  member_id: string;
  role_id: string;
  url: string;
  auth_enc: string | null;
  signing_secret_enc: string;
  events: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

type Sender = (url: string, headers: Record<string, string>, body: string) => Promise<PostResult>;

/** Maps a log event to (role id, webhook event type), or null when it wakes nobody. */
function classify(db: DB, e: EventRecord): { roleId: string; type: WebhookEvent } | null {
  const d = e.data as { role_id?: string | null };
  switch (e.action) {
    case 'task.assigned':
    case 'task.commented':
    case 'task.unblocked':
      return d.role_id ? { roleId: d.role_id, type: e.action } : null;
    case 'task.updated':
    case 'task.claimed': {
      const t = get<{ role_id: string | null }>(db, 'SELECT role_id FROM task WHERE id = ?', e.entity_id);
      return t?.role_id ? { roleId: t.role_id, type: 'task.updated' } : null;
    }
    case 'role.updated':
    case 'role.instruction_updated':
      return e.entity_id ? { roleId: e.entity_id, type: 'role.updated' } : null;
    default:
      return null;
  }
}

export class WebhookDispatcher {
  private db: DB;
  private config: Config;
  private timer: NodeJS.Timeout | undefined;
  private inflight = new Set<Promise<void>>();
  private busy = false;
  /** Deliveries whose request is in flight; new events never join them. */
  private sending = new Set<string>();
  send: Sender;

  constructor(db: DB, config: Config, opts: { fetchImpl?: typeof fetch; send?: Sender } = {}) {
    this.db = db;
    this.config = config;
    this.send = opts.send ?? ((url, headers, body) => postJson(url, headers, body, { timeoutMs: TIMEOUT_MS, allowPrivate: config.webhookAllowPrivate }));
  }

  /** Registers the log hook that enqueues deliveries inside the change's transaction. */
  attach(): void {
    onEvent((db, e) => this.enqueue(db, e));
  }

  private enqueue(db: DB, e: EventRecord): void {
    const c = classify(db, e);
    if (!c) return;
    const role = get<{ slug: string }>(db, 'SELECT slug FROM role WHERE id = ?', c.roleId);
    // Changes made by the same role do not wake it.
    if (role && e.claimed_role && (e.claimed_role === role.slug || e.claimed_role === c.roleId)) return;
    const hooks = all<WebhookRow>(db, 'SELECT * FROM webhook WHERE role_id = ? AND enabled = 1', c.roleId);
    for (const h of hooks) {
      if (!(JSON.parse(h.events) as string[]).includes(c.type)) continue;
      const signal = { id: e.id, type: c.type, at: e.at };
      // Coalesce only into a delivery that is not on the wire: appending to one being sent would
      // mark events as delivered that the receiver never got.
      const pending = get<{ id: string; events: string }>(
        db,
        "SELECT id, events FROM webhook_delivery WHERE webhook_id = ? AND status = 'pending' AND attempts = 0 ORDER BY created_at DESC LIMIT 1",
        h.id,
      );
      const evs = pending && !this.sending.has(pending.id) ? (JSON.parse(pending.events) as unknown[]) : null;
      if (pending && evs && evs.length < 100) {
        evs.push(signal);
        run(db, 'UPDATE webhook_delivery SET events = ? WHERE id = ?', JSON.stringify(evs), pending.id);
      } else {
        run(
          db,
          "INSERT INTO webhook_delivery (id, webhook_id, member_id, status, events, attempts, next_attempt_at, created_at) VALUES (?,?,?,'pending',?,0,?,?)",
          newId('dlv'),
          h.id,
          h.member_id,
          JSON.stringify([signal]),
          new Date(Date.now() + COALESCE_MS).toISOString(),
          now(),
        );
      }
    }
  }

  start(intervalMs = 2000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.inflight]);
  }

  /** Sends every due delivery once. Exposed for tests. */
  async tick(at = new Date()): Promise<number> {
    if (this.busy) return 0;
    this.busy = true;
    try {
      const due = all<{ id: string }>(this.db, "SELECT id FROM webhook_delivery WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT 20", at.toISOString());
      await Promise.all(due.map((d) => this.track(this.deliver(d.id))));
      return due.length;
    } finally {
      this.busy = false;
    }
  }

  private track(p: Promise<void>): Promise<void> {
    this.inflight.add(p);
    return p.finally(() => this.inflight.delete(p));
  }

  private async deliver(deliveryId: string): Promise<void> {
    const d = get<{ id: string; webhook_id: string; events: string; attempts: number }>(this.db, "SELECT * FROM webhook_delivery WHERE id = ? AND status = 'pending'", deliveryId);
    if (!d) return;
    const h = get<WebhookRow>(this.db, 'SELECT * FROM webhook WHERE id = ?', d.webhook_id);
    if (!h || !h.enabled) {
      run(this.db, "UPDATE webhook_delivery SET status = 'failed', last_error = ? WHERE id = ?", 'subscription disabled', d.id);
      return;
    }
    const events = JSON.parse(d.events) as { id: number; type: string; at: string }[];
    const last = events[events.length - 1]!;
    const role = get<{ slug: string }>(this.db, 'SELECT slug FROM role WHERE id = ?', h.role_id);
    const payload = {
      delivery_id: d.id,
      type: last.type,
      event_id: last.id,
      role_id: h.role_id,
      role: role?.slug ?? null,
      at: last.at,
      events: events.map((e) => ({ id: e.id, type: e.type, at: e.at })),
      sent_at: now(),
    };
    const bodyText = JSON.stringify(payload);
    const ts = Math.floor(Date.now() / 1000).toString();
    const secret = decryptSecret(this.config.encryptionKey, h.signing_secret_enc);
    const headers: Record<string, string> = {
      'x-workspace-delivery': d.id,
      'x-workspace-event': last.type,
      'x-workspace-timestamp': ts,
      'x-workspace-signature': `sha256=${hmacSha256Hex(secret, `${ts}.${bodyText}`)}`,
    };
    if (h.auth_enc) headers.authorization = decryptSecret(this.config.encryptionKey, h.auth_enc);
    const attempt = d.attempts + 1;
    let status: number | null = null;
    let error: string | null = null;
    this.sending.add(d.id);
    try {
      const r = await this.send(h.url, headers, bodyText);
      status = r.status;
      if (r.status < 200 || r.status >= 300) error = `HTTP ${r.status}${r.snippet ? `: ${r.snippet.replace(/\s+/g, ' ').slice(0, 120)}` : ''}`;
    } catch (e) {
      error = errMessage(e).slice(0, 300);
    } finally {
      this.sending.delete(d.id);
    }
    if (!error) {
      run(this.db, "UPDATE webhook_delivery SET status = 'delivered', attempts = ?, last_status = ?, last_error = NULL, delivered_at = ? WHERE id = ?", attempt, status, now(), d.id);
      log.info('webhook delivered', { delivery: d.id, webhook: h.id, attempt });
      return;
    }
    const permanent = attempt >= MAX_ATTEMPTS;
    const next = permanent ? now() : new Date(Date.now() + BACKOFF_MS[attempt - 1]!).toISOString();
    run(
      this.db,
      'UPDATE webhook_delivery SET status = ?, attempts = ?, last_status = ?, last_error = ?, next_attempt_at = ? WHERE id = ?',
      permanent ? 'failed' : 'pending',
      attempt,
      status,
      error,
      next,
      d.id,
    );
    log.warn('webhook delivery failed', { delivery: d.id, webhook: h.id, attempt, final: permanent, status });
  }

  // ---------- owner management (web interface only, never MCP) ----------

  list(memberId: string) {
    return all<WebhookRow>(this.db, 'SELECT * FROM webhook WHERE member_id = ? ORDER BY created_at', memberId).map((h) => this.view(h));
  }

  private view(h: WebhookRow) {
    const role = get<{ slug: string; name: string }>(this.db, 'SELECT slug, name FROM role WHERE id = ?', h.role_id);
    const stats = get<{ delivered: number; failed: number; pending: number; last_at: string | null }>(
      this.db,
      "SELECT sum(status='delivered') AS delivered, sum(status='failed') AS failed, sum(status='pending') AS pending, max(created_at) AS last_at FROM webhook_delivery WHERE webhook_id = ?",
      h.id,
    )!;
    return {
      id: h.id,
      role_id: h.role_id,
      role: role?.slug ?? null,
      role_name: role?.name ?? null,
      url: h.url,
      has_authorization: !!h.auth_enc,
      events: JSON.parse(h.events) as string[],
      enabled: !!h.enabled,
      created_at: h.created_at,
      updated_at: h.updated_at,
      deliveries: { delivered: stats.delivered ?? 0, failed: stats.failed ?? 0, pending: stats.pending ?? 0, last_at: stats.last_at },
    };
  }

  save(actor: Actor, input: { id?: string; role?: string; url?: string; authorization?: string | null; events?: string[]; enabled?: boolean }) {
    const memberId = actor.memberId;
    const events = input.events?.filter((e): e is WebhookEvent => (WEBHOOK_EVENTS as readonly string[]).includes(e));
    if (input.events && (!events || !events.length)) throw new DomainError('invalid', `Choose at least one event: ${WEBHOOK_EVENTS.join(', ')}`);
    if (input.url !== undefined) {
      if (input.url.length > 2000) throw new DomainError('invalid', 'URL too long');
      try {
        validateWebhookUrl(input.url, this.config.webhookAllowPrivate);
      } catch (e) {
        throw new DomainError('invalid', errMessage(e));
      }
    }
    if (input.authorization && input.authorization.length > 4000) throw new DomainError('invalid', 'Authorization value too long');
    if (input.authorization && /[\r\n]/.test(input.authorization)) throw new DomainError('invalid', 'Authorization value must be one line');
    return tx(this.db, () => {
      const t = now();
      if (!input.id) {
        if (!input.role || !input.url || !events) throw new DomainError('invalid', 'role, url and events are required');
        const role = requireRole(this.db, memberId, input.role);
        const id = newId('whk');
        run(
          this.db,
          'INSERT INTO webhook (id, member_id, role_id, url, auth_enc, signing_secret_enc, events, enabled, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
          id,
          memberId,
          role.id,
          input.url,
          input.authorization ? encryptSecret(this.config.encryptionKey, input.authorization) : null,
          encryptSecret(this.config.encryptionKey, randomToken(32)),
          JSON.stringify(events),
          input.enabled === false ? 0 : 1,
          t,
          t,
        );
        recordEvent(this.db, actor, 'webhook', id, 'webhook.created', `Webhook for role ${role.slug} created`);
        return this.view(get<WebhookRow>(this.db, 'SELECT * FROM webhook WHERE id = ?', id)!);
      }
      const h = get<WebhookRow>(this.db, 'SELECT * FROM webhook WHERE id = ? AND member_id = ?', input.id, memberId);
      if (!h) throw new DomainError('not_found', `webhook not found: ${input.id}`);
      const roleId = input.role ? requireRole(this.db, memberId, input.role).id : h.role_id;
      const auth = input.authorization === undefined ? h.auth_enc : input.authorization ? encryptSecret(this.config.encryptionKey, input.authorization) : null;
      run(
        this.db,
        'UPDATE webhook SET role_id = ?, url = ?, auth_enc = ?, events = ?, enabled = ?, updated_at = ? WHERE id = ?',
        roleId,
        input.url ?? h.url,
        auth,
        events ? JSON.stringify(events) : h.events,
        input.enabled === undefined ? h.enabled : input.enabled ? 1 : 0,
        t,
        h.id,
      );
      if (input.enabled === false) run(this.db, "UPDATE webhook_delivery SET status = 'failed', last_error = 'subscription disabled' WHERE webhook_id = ? AND status = 'pending'", h.id);
      recordEvent(this.db, actor, 'webhook', h.id, 'webhook.updated', `Webhook ${h.id} updated`);
      return this.view(get<WebhookRow>(this.db, 'SELECT * FROM webhook WHERE id = ?', h.id)!);
    });
  }

  remove(actor: Actor, id: string): void {
    tx(this.db, () => {
      const h = get<WebhookRow>(this.db, 'SELECT * FROM webhook WHERE id = ? AND member_id = ?', id, actor.memberId);
      if (!h) throw new DomainError('not_found', `webhook not found: ${id}`);
      run(this.db, 'DELETE FROM webhook WHERE id = ?', id);
      recordEvent(this.db, actor, 'webhook', id, 'webhook.deleted', `Webhook ${id} deleted`);
    });
  }

  /** The signing secret is shown to the owner so the receiver can verify signatures. */
  signingSecret(memberId: string, id: string): string {
    const h = get<WebhookRow>(this.db, 'SELECT * FROM webhook WHERE id = ? AND member_id = ?', id, memberId);
    if (!h) throw new DomainError('not_found', `webhook not found: ${id}`);
    return decryptSecret(this.config.encryptionKey, h.signing_secret_enc);
  }

  /** Queues an immediate test delivery. */
  test(memberId: string, id: string): string {
    const h = get<WebhookRow>(this.db, 'SELECT * FROM webhook WHERE id = ? AND member_id = ?', id, memberId);
    if (!h) throw new DomainError('not_found', `webhook not found: ${id}`);
    const did = newId('dlv');
    run(
      this.db,
      "INSERT INTO webhook_delivery (id, webhook_id, member_id, status, events, attempts, next_attempt_at, created_at) VALUES (?,?,?,'pending',?,0,?,?)",
      did,
      h.id,
      memberId,
      JSON.stringify([{ id: 0, type: 'test', at: now() }]),
      now(),
      now(),
    );
    void this.tick();
    return did;
  }

  deliveries(memberId: string, webhookId: string, limit = 50) {
    return all(
      this.db,
      'SELECT id, status, events, attempts, last_status, last_error, next_attempt_at, created_at, delivered_at FROM webhook_delivery WHERE webhook_id = ? AND member_id = ? ORDER BY created_at DESC LIMIT ?',
      webhookId,
      memberId,
      Math.min(limit, 200),
    ).map((r) => ({ ...r, events: JSON.parse(String(r.events)) }));
  }
}
