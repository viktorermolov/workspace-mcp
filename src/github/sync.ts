import type { Config } from '../config.ts';
import { all, get, now, run, tx, type DB } from '../db/db.ts';
import { DomainError, indexEntity, recordEvent, unindexEntity, type Actor } from '../domain/core.ts';
import { ownerMember, requireProject, requireRole } from '../domain/entities.ts';
import { decryptSecret, encryptSecret } from '../util/crypto.ts';
import { errMessage, log } from '../util/log.ts';

/**
 * Read-only, one-way mirror of GitHub issues. The service only ever sends GET requests to the
 * GitHub REST API; it writes nothing to GitHub. The only local addition to an issue is a role label.
 */

const MAX_PAGES = 20; // 100 items per page
const MAX_BODY = 20_000;

interface GhIssue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  html_url: string;
  user?: { login?: string } | null;
  labels?: (string | { name?: string })[];
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  pull_request?: unknown;
}

export class GithubError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export class GithubSync {
  private db: DB;
  private config: Config;
  private fetchImpl: typeof fetch;
  private running: Promise<unknown> | null = null;

  constructor(db: DB, config: Config, opts: { fetchImpl?: typeof fetch } = {}) {
    this.db = db;
    this.config = config;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async api<T>(token: string, pathAndQuery: string): Promise<{ data: T; next: string | null }> {
    const url = pathAndQuery.startsWith('http') ? pathAndQuery : `${this.config.githubApiUrl}${pathAndQuery}`;
    if (!url.startsWith(this.config.githubApiUrl + '/')) throw new GithubError('Refusing to follow a link outside the GitHub API', 0);
    const res = await this.fetchImpl(url, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'workspace-mcp',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      let msg = `GitHub answered HTTP ${res.status}`;
      try {
        const j = (await res.json()) as { message?: string };
        if (j.message) msg += `: ${j.message.slice(0, 200)}`;
      } catch {
        /* no body */
      }
      if (res.status === 401) msg = 'GitHub rejected the token (401). Replace the token on the GitHub screen.';
      throw new GithubError(msg, res.status);
    }
    const link = res.headers.get('link') ?? '';
    const next = /<([^>]+)>;\s*rel="next"/.exec(link)?.[1] ?? null;
    return { data: (await res.json()) as T, next };
  }

  private token(memberId: string): string | null {
    const c = get<{ token_enc: string }>(this.db, 'SELECT token_enc FROM github_config WHERE member_id = ?', memberId);
    return c ? decryptSecret(this.config.encryptionKey, c.token_enc) : null;
  }

  status(memberId: string) {
    const c = get<Record<string, unknown>>(this.db, 'SELECT login, connected_at, last_sync_at, last_sync_ok, last_sync_message, last_sync_count FROM github_config WHERE member_id = ?', memberId);
    const repos = all<Record<string, unknown>>(
      this.db,
      `SELECT r.id, r.full_name, r.created_at, r.last_synced_at, p.slug AS project, p.name AS project_name,
              (SELECT count(*) FROM github_issue i WHERE i.repo_id = r.id) AS issues,
              (SELECT count(*) FROM github_issue i WHERE i.repo_id = r.id AND i.state = 'open') AS open_issues
       FROM github_repo r LEFT JOIN project p ON p.id = r.project_id WHERE r.member_id = ? ORDER BY r.full_name`,
      memberId,
    );
    return {
      connected: !!c,
      login: c?.login ?? null,
      connected_at: c?.connected_at ?? null,
      last_sync: c?.last_sync_at ? { at: c.last_sync_at, ok: !!c.last_sync_ok, message: c.last_sync_message, issues: c.last_sync_count } : null,
      sync_interval_minutes: this.config.githubSyncIntervalMinutes,
      repos,
    };
  }

  /** Validates the token with GET /user and stores it encrypted. Replaces an existing token. */
  async connect(actor: Actor, token: string) {
    const t = token.trim();
    if (!t || t.length > 500 || /\s/.test(t)) throw new DomainError('invalid', 'Paste the token as a single line');
    let login: string;
    try {
      const { data } = await this.api<{ login: string }>(t, '/user');
      login = data.login;
    } catch (e) {
      throw new DomainError('invalid', `The token could not be validated: ${errMessage(e)}`);
    }
    tx(this.db, () => {
      run(
        this.db,
        `INSERT INTO github_config (member_id, token_enc, login, connected_at) VALUES (?,?,?,?)
         ON CONFLICT (member_id) DO UPDATE SET token_enc = excluded.token_enc, login = excluded.login, connected_at = excluded.connected_at`,
        actor.memberId,
        encryptSecret(this.config.encryptionKey, t),
        login,
        now(),
      );
      recordEvent(this.db, actor, 'github', null, 'github.connected', `GitHub connected as ${login}`);
    });
    return this.status(actor.memberId);
  }

  /** Removes the token, the selected repositories and every mirrored issue. */
  disconnect(actor: Actor): void {
    tx(this.db, () => {
      for (const i of all<{ id: string }>(this.db, 'SELECT id FROM github_issue WHERE member_id = ?', actor.memberId)) unindexEntity(this.db, 'issue', i.id);
      run(this.db, 'DELETE FROM github_issue WHERE member_id = ?', actor.memberId);
      run(this.db, 'DELETE FROM github_repo WHERE member_id = ?', actor.memberId);
      run(this.db, 'DELETE FROM github_config WHERE member_id = ?', actor.memberId);
      recordEvent(this.db, actor, 'github', null, 'github.disconnected', 'GitHub disconnected; mirrored issues removed');
    });
  }

  /** Repositories the token can read, for the picker. */
  async availableRepos(memberId: string) {
    const token = this.token(memberId);
    if (!token) throw new DomainError('invalid', 'GitHub is not connected');
    const out: { full_name: string; private: boolean; has_issues: boolean }[] = [];
    let next: string | null = '/user/repos?per_page=100&sort=full_name&affiliation=owner,collaborator,organization_member';
    for (let page = 0; next && page < MAX_PAGES; page++) {
      const r: { data: { full_name: string; private: boolean; has_issues: boolean }[]; next: string | null } = await this.api(token, next);
      out.push(...r.data.map((x) => ({ full_name: x.full_name, private: x.private, has_issues: x.has_issues })));
      next = r.next;
    }
    const selected = new Set(all<{ full_name: string }>(this.db, 'SELECT full_name FROM github_repo WHERE member_id = ?', memberId).map((r) => r.full_name.toLowerCase()));
    return out.map((r) => ({ ...r, selected: selected.has(r.full_name.toLowerCase()) }));
  }

  addRepo(actor: Actor, fullName: string, project?: string | null) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fullName)) throw new DomainError('invalid', 'Repository must look like owner/name');
    if (!this.token(actor.memberId)) throw new DomainError('invalid', 'GitHub is not connected');
    return tx(this.db, () => {
      const projectId = project ? requireProject(this.db, actor.memberId, project).id : null;
      const existing = get<{ id: number }>(this.db, 'SELECT id FROM github_repo WHERE member_id = ? AND lower(full_name) = lower(?)', actor.memberId, fullName);
      if (existing) {
        run(this.db, 'UPDATE github_repo SET project_id = ? WHERE id = ?', projectId, existing.id);
        recordEvent(this.db, actor, 'github', String(existing.id), 'github.repo_mapped', `Repository ${fullName} mapped to ${project ?? 'no project'}`);
        return existing.id;
      }
      const r = run(this.db, 'INSERT INTO github_repo (member_id, full_name, project_id, created_at) VALUES (?,?,?,?)', actor.memberId, fullName, projectId, now());
      recordEvent(this.db, actor, 'github', String(r.lastInsertRowid), 'github.repo_added', `Repository ${fullName} added${project ? ` for project ${project}` : ''}`);
      return Number(r.lastInsertRowid);
    });
  }

  removeRepo(actor: Actor, repoId: number): void {
    tx(this.db, () => {
      const r = get<{ full_name: string }>(this.db, 'SELECT full_name FROM github_repo WHERE id = ? AND member_id = ?', repoId, actor.memberId);
      if (!r) throw new DomainError('not_found', `repository not found: ${repoId}`);
      for (const i of all<{ id: string }>(this.db, 'SELECT id FROM github_issue WHERE repo_id = ?', repoId)) unindexEntity(this.db, 'issue', i.id);
      run(this.db, 'DELETE FROM github_issue WHERE repo_id = ?', repoId);
      run(this.db, 'DELETE FROM github_repo WHERE id = ?', repoId);
      recordEvent(this.db, actor, 'github', String(repoId), 'github.repo_removed', `Repository ${r.full_name} removed; its mirrored issues deleted`);
    });
  }

  /** The only local addition to a mirrored issue. */
  setIssueRole(actor: Actor, issueId: string, role: string | null): void {
    tx(this.db, () => {
      const i = get<{ id: string; number: number; title: string }>(this.db, 'SELECT id, number, title FROM github_issue WHERE id = ? AND member_id = ?', issueId, actor.memberId);
      if (!i) throw new DomainError('not_found', `issue not found: ${issueId}`);
      const r = role ? requireRole(this.db, actor.memberId, role) : null;
      run(this.db, 'UPDATE github_issue SET role_id = ? WHERE id = ?', r?.id ?? null, i.id);
      recordEvent(this.db, actor, 'issue', i.id, 'issue.role_set', `Issue #${i.number} labelled for ${r ? r.slug : 'no role'}`, { role_id: r?.id ?? null });
    });
  }

  /** Background entry point: syncs the owner's repositories if GitHub is connected. */
  async syncIfConnected(): Promise<void> {
    const owner = ownerMember(this.db);
    if (!owner || !this.token(owner.id)) return;
    await this.sync(owner.id).catch(() => undefined);
  }

  /** Full or incremental sync (issues updated since the repository's last sync). One run at a time. */
  sync(memberId: string): Promise<{ ok: boolean; message: string; issues: number }> {
    if (this.running) return this.running as Promise<{ ok: boolean; message: string; issues: number }>;
    const p = this.doSync(memberId).finally(() => (this.running = null));
    this.running = p;
    return p;
  }

  private async doSync(memberId: string): Promise<{ ok: boolean; message: string; issues: number }> {
    const token = this.token(memberId);
    if (!token) return { ok: false, message: 'GitHub is not connected', issues: 0 };
    const repos = all<{ id: number; full_name: string; last_synced_at: string | null }>(this.db, 'SELECT id, full_name, last_synced_at FROM github_repo WHERE member_id = ?', memberId);
    let count = 0;
    const errors: string[] = [];
    for (const repo of repos) {
      const started = now();
      try {
        const since = repo.last_synced_at ? `&since=${encodeURIComponent(new Date(Date.parse(repo.last_synced_at) - 60_000).toISOString())}` : '';
        let next: string | null = `/repos/${repo.full_name}/issues?state=all&per_page=100&sort=updated&direction=asc${since}`;
        const batch: GhIssue[] = [];
        for (let page = 0; next && page < MAX_PAGES; page++) {
          const r: { data: GhIssue[]; next: string | null } = await this.api<GhIssue[]>(token, next);
          batch.push(...r.data.filter((i) => !i.pull_request));
          next = r.next;
        }
        tx(this.db, () => {
          if (!get(this.db, 'SELECT 1 FROM github_repo WHERE id = ?', repo.id)) return; // removed meanwhile
          for (const i of batch) this.upsertIssue(memberId, repo.id, repo.full_name, i);
          run(this.db, 'UPDATE github_repo SET last_synced_at = ? WHERE id = ?', started, repo.id);
        });
        count += batch.length;
      } catch (e) {
        errors.push(`${repo.full_name}: ${errMessage(e)}`);
      }
    }
    const ok = errors.length === 0;
    const message = ok ? `Synced ${repos.length} repositories, ${count} issues changed` : errors.join('; ').slice(0, 1000);
    run(
      this.db,
      'UPDATE github_config SET last_sync_at = ?, last_sync_ok = ?, last_sync_message = ?, last_sync_count = ? WHERE member_id = ?',
      now(),
      ok ? 1 : 0,
      message,
      count,
      memberId,
    );
    if (ok) log.info('github sync', { repos: repos.length, issues: count });
    else log.warn('github sync failed', { message });
    return { ok, message, issues: count };
  }

  private upsertIssue(memberId: string, repoId: number, fullName: string, i: GhIssue): void {
    const id = `gh_${repoId}_${i.number}`;
    const labels = (i.labels ?? []).map((l) => (typeof l === 'string' ? l : (l.name ?? ''))).filter(Boolean);
    const body = (i.body ?? '').slice(0, MAX_BODY);
    const state = i.state === 'closed' ? 'closed' : 'open';
    run(
      this.db,
      `INSERT INTO github_issue (id, member_id, repo_id, number, title, body, state, labels, url, author, created_at, updated_at, closed_at, synced_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT (repo_id, number) DO UPDATE SET title = excluded.title, body = excluded.body, state = excluded.state, labels = excluded.labels,
         url = excluded.url, author = excluded.author, updated_at = excluded.updated_at, closed_at = excluded.closed_at, synced_at = excluded.synced_at`,
      id,
      memberId,
      repoId,
      i.number,
      i.title.slice(0, 500),
      body,
      state,
      JSON.stringify(labels),
      i.html_url,
      i.user?.login ?? null,
      i.created_at,
      i.updated_at,
      i.closed_at,
      now(),
    );
    indexEntity(this.db, memberId, 'issue', id, `${fullName}#${i.number} ${i.title}`, body);
  }
}
