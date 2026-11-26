import type { Config } from '../config.ts';
import { all, get, now, run, tx, type DB } from '../db/db.ts';
import { assertCanSetIssueRole } from '../domain/access.ts';
import { DomainError, indexEntity, invalid, notFound, recordEvent, unindexEntity, type Actor } from '../domain/core.ts';
import { findRole, ownerMember, requireProject } from '../domain/entities.ts';
import { issueView } from '../domain/views.ts';
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

/** An existing, non-archived role. Used for issue labels, default roles and assigners. */
export function requireActiveRole(db: DB, memberId: string, ref: string) {
  const r = findRole(db, memberId, ref, false);
  if (r) return r;
  const archived = findRole(db, memberId, ref, true);
  if (archived?.archived_at) throw invalid(`role "${archived.slug}" is archived and cannot be assigned to an issue`);
  throw notFound('role', ref);
}

function roleRef(db: DB, memberId: string, ref: string | null | undefined) {
  if (ref === undefined) return undefined;
  if (ref === null || String(ref).trim() === '') return null;
  return requireActiveRole(db, memberId, String(ref).trim());
}

function assignersOf(db: DB, repoId: number) {
  return all<{ id: string; slug: string; name: string }>(
    db,
    `SELECT r.id, r.slug, r.name FROM github_repo_assigner a JOIN role r ON r.id = a.role_id
     WHERE a.repo_id = ? ORDER BY r.name`,
    repoId,
  );
}

function setAssigners(db: DB, memberId: string, repoId: number, refs: string[]) {
  const roles = refs.map((ref) => requireActiveRole(db, memberId, ref));
  run(db, 'DELETE FROM github_repo_assigner WHERE repo_id = ?', repoId);
  const seen = new Set<string>();
  for (const r of roles) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    run(db, 'INSERT INTO github_repo_assigner (repo_id, role_id) VALUES (?,?)', repoId, r.id);
  }
  return roles.filter((r, i, arr) => arr.findIndex((x) => x.id === r.id) === i);
}

/** Resolves a mirrored issue: either `id`, or `repo` (owner/name) plus `number`. Not both. */
export function resolveIssueId(db: DB, memberId: string, input: { id?: string; repo?: string; number?: number }): string {
  const hasId = !!(input.id && String(input.id).trim());
  const hasRepo = !!(input.repo && String(input.repo).trim());
  const hasNumber = input.number !== undefined && input.number !== null;
  if (hasId && (hasRepo || hasNumber)) throw invalid('pass either id or repo and number, not both');
  if (hasId) return String(input.id).trim();
  if (hasRepo && hasNumber) {
    if (!Number.isInteger(input.number) || (input.number as number) < 1) throw invalid('number must be a positive integer');
    const row = get<{ id: string }>(
      db,
      'SELECT i.id FROM github_issue i JOIN github_repo r ON r.id = i.repo_id WHERE i.member_id = ? AND lower(r.full_name) = lower(?) AND i.number = ?',
      memberId,
      String(input.repo).trim(),
      input.number,
    );
    if (!row) throw notFound('issue', `${String(input.repo).trim()}#${input.number}`);
    return row.id;
  }
  if (hasRepo || hasNumber) throw invalid('repo and number must be passed together');
  throw invalid('pass an issue id, or repo and number');
}

/**
 * Sets or clears the local role label on a mirrored issue. Writes nothing to GitHub.
 * Owner always may; agents follow assertCanSetIssueRole. An unchanged value succeeds with no new event.
 */
export function setMirroredIssueRole(
  db: DB,
  actor: Actor,
  input: { id?: string; repo?: string; number?: number; role?: string | null },
) {
  return tx(db, () => {
    const issueId = resolveIssueId(db, actor.memberId, input);
    const i = get<{ id: string; number: number; repo_id: number; role_id: string | null }>(
      db,
      'SELECT id, number, repo_id, role_id FROM github_issue WHERE id = ? AND member_id = ?',
      issueId,
      actor.memberId,
    );
    if (!i) throw notFound('issue', issueId);
    assertCanSetIssueRole(db, actor, i.repo_id);
    const next = input.role === undefined || input.role === null || String(input.role).trim() === '' ? null : requireActiveRole(db, actor.memberId, String(input.role).trim());
    const nextId = next?.id ?? null;
    if (nextId === i.role_id) return issueView(db, actor.memberId, i.id);
    const prev = i.role_id ? get<{ id: string; slug: string }>(db, 'SELECT id, slug FROM role WHERE id = ?', i.role_id) : undefined;
    run(db, 'UPDATE github_issue SET role_id = ? WHERE id = ?', nextId, i.id);
    recordEvent(db, actor, 'issue', i.id, 'issue.role_set', `Issue #${i.number} labelled for ${next ? next.slug : 'no role'}`, {
      old_role: prev?.slug ?? null,
      new_role: next?.slug ?? null,
      old_role_id: prev?.id ?? null,
      new_role_id: nextId,
    });
    return issueView(db, actor.memberId, i.id);
  });
}

export type RepoSettingsInput = { project?: string | null; default_role?: string | null; assigners?: string[] };

/** Owner-only: default role and assigner list for a mirrored repository. */
export function updateRepoSettings(db: DB, actor: Actor, repoId: number, input: RepoSettingsInput): void {
  if (actor.kind !== 'owner') throw new DomainError('forbidden', "only the owner can set a repository's default role or assigners");
  tx(db, () => {
    const repo = get<{ id: number; full_name: string; project_id: string | null; default_role_id: string | null }>(
      db,
      'SELECT id, full_name, project_id, default_role_id FROM github_repo WHERE id = ? AND member_id = ?',
      repoId,
      actor.memberId,
    );
    if (!repo) throw notFound('repository', String(repoId));
    if (input.project !== undefined) {
      const projectId = input.project ? requireProject(db, actor.memberId, input.project).id : null;
      if (projectId !== repo.project_id) {
        run(db, 'UPDATE github_repo SET project_id = ? WHERE id = ?', projectId, repo.id);
        recordEvent(db, actor, 'github', String(repo.id), 'github.repo_mapped', `Repository ${repo.full_name} mapped to ${input.project ?? 'no project'}`);
      }
    }
    if (input.default_role !== undefined) {
      const next = roleRef(db, actor.memberId, input.default_role);
      const nextId = next === undefined ? repo.default_role_id : next === null ? null : next.id;
      if (nextId !== repo.default_role_id) {
        const prev = repo.default_role_id ? get<{ id: string; slug: string }>(db, 'SELECT id, slug FROM role WHERE id = ?', repo.default_role_id) : undefined;
        run(db, 'UPDATE github_repo SET default_role_id = ? WHERE id = ?', nextId, repo.id);
        recordEvent(db, actor, 'github', String(repo.id), 'github.repo_default_role', `Default role for ${repo.full_name} set to ${next ? next.slug : 'none'}`, {
          old_role: prev?.slug ?? null,
          new_role: next ? next.slug : null,
          old_role_id: prev?.id ?? null,
          new_role_id: nextId,
        });
      }
    }
    if (input.assigners !== undefined) {
      if (!Array.isArray(input.assigners)) throw invalid('assigners must be an array of role slugs or ids');
      const before = assignersOf(db, repo.id);
      const after = setAssigners(db, actor.memberId, repo.id, input.assigners);
      const beforeIds = before.map((r) => r.id).sort().join(',');
      const afterIds = after.map((r) => r.id).sort().join(',');
      if (beforeIds !== afterIds) {
        recordEvent(db, actor, 'github', String(repo.id), 'github.repo_assigners', `Assigners for ${repo.full_name} updated`, {
          old_roles: before.map((r) => r.slug),
          new_roles: after.map((r) => r.slug),
          old_role_ids: before.map((r) => r.id),
          new_role_ids: after.map((r) => r.id),
        });
      }
    }
  });
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
    const repos = all<Record<string, unknown> & { id: number }>(
      this.db,
      `SELECT r.id, r.full_name, r.created_at, r.last_synced_at, p.slug AS project, p.name AS project_name,
              d.slug AS default_role,
              (SELECT count(*) FROM github_issue i WHERE i.repo_id = r.id) AS issues,
              (SELECT count(*) FROM github_issue i WHERE i.repo_id = r.id AND i.state = 'open') AS open_issues
       FROM github_repo r LEFT JOIN project p ON p.id = r.project_id
       LEFT JOIN role d ON d.id = r.default_role_id
       WHERE r.member_id = ? ORDER BY r.full_name`,
      memberId,
    );
    const assigners = all<{ repo_id: number; slug: string; name: string }>(
      this.db,
      `SELECT a.repo_id, ro.slug, ro.name FROM github_repo_assigner a
       JOIN role ro ON ro.id = a.role_id JOIN github_repo r ON r.id = a.repo_id
       WHERE r.member_id = ? ORDER BY ro.name`,
      memberId,
    );
    const byRepo = new Map<number, { slug: string; name: string }[]>();
    for (const a of assigners) {
      const list = byRepo.get(a.repo_id) ?? [];
      list.push({ slug: a.slug, name: a.name });
      byRepo.set(a.repo_id, list);
    }
    return {
      connected: !!c,
      login: c?.login ?? null,
      connected_at: c?.connected_at ?? null,
      last_sync: c?.last_sync_at ? { at: c.last_sync_at, ok: !!c.last_sync_ok, message: c.last_sync_message, issues: c.last_sync_count } : null,
      sync_interval_minutes: this.config.githubSyncIntervalMinutes,
      repos: repos.map((r) => ({ ...r, assigners: byRepo.get(r.id) ?? [] })),
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

  addRepo(actor: Actor, fullName: string, opts: { project?: string | null; default_role?: string | null; assigners?: string[] } = {}) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fullName)) throw new DomainError('invalid', 'Repository must look like owner/name');
    if (!this.token(actor.memberId)) throw new DomainError('invalid', 'GitHub is not connected');
    const project = opts.project ?? null;
    return tx(this.db, () => {
      const existing = get<{ id: number }>(this.db, 'SELECT id FROM github_repo WHERE member_id = ? AND lower(full_name) = lower(?)', actor.memberId, fullName);
      if (existing) {
        updateRepoSettings(this.db, actor, existing.id, opts);
        return existing.id;
      }
      if (actor.kind !== 'owner') throw new DomainError('forbidden', 'only the owner can add a repository');
      const projectId = project ? requireProject(this.db, actor.memberId, project).id : null;
      const defaultRole = roleRef(this.db, actor.memberId, opts.default_role);
      const defaultId = defaultRole ? defaultRole.id : null;
      const r = run(
        this.db,
        'INSERT INTO github_repo (member_id, full_name, project_id, default_role_id, created_at) VALUES (?,?,?,?,?)',
        actor.memberId,
        fullName,
        projectId,
        defaultId,
        now(),
      );
      const id = Number(r.lastInsertRowid);
      if (opts.assigners) setAssigners(this.db, actor.memberId, id, opts.assigners);
      recordEvent(this.db, actor, 'github', String(id), 'github.repo_added', `Repository ${fullName} added${project ? ` for project ${project}` : ''}`);
      if (defaultRole) {
        recordEvent(this.db, actor, 'github', String(id), 'github.repo_default_role', `Default role for ${fullName} set to ${defaultRole.slug}`, {
          old_role: null,
          new_role: defaultRole.slug,
          old_role_id: null,
          new_role_id: defaultRole.id,
        });
      }
      if (opts.assigners && opts.assigners.length) {
        const after = assignersOf(this.db, id);
        recordEvent(this.db, actor, 'github', String(id), 'github.repo_assigners', `Assigners for ${fullName} updated`, {
          old_roles: [],
          new_roles: after.map((x) => x.slug),
          old_role_ids: [],
          new_role_ids: after.map((x) => x.id),
        });
      }
      return id;
    });
  }

  updateRepo(actor: Actor, repoId: number, opts: RepoSettingsInput): void {
    updateRepoSettings(this.db, actor, repoId, opts);
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

  /** The only local addition to a mirrored issue. Same path for the owner UI and MCP. */
  setIssueRole(actor: Actor, issueId: string, role: string | null) {
    return setMirroredIssueRole(this.db, actor, { id: issueId, role });
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
    const repos = all<{ id: number; full_name: string; last_synced_at: string | null; sync_cursor: string | null }>(
      this.db,
      'SELECT id, full_name, last_synced_at, sync_cursor FROM github_repo WHERE member_id = ?',
      memberId,
    );
    let count = 0;
    const errors: string[] = [];
    const partial: string[] = [];
    for (const repo of repos) {
      const started = now();
      try {
        // A run cut short by the page cap continues exactly from GitHub's own update time. Otherwise the
        // last run's local start time is used, a minute earlier to absorb clock differences.
        const from = repo.sync_cursor ?? (repo.last_synced_at ? new Date(Date.parse(repo.last_synced_at) - 60_000).toISOString() : null);
        const since = from ? `&since=${encodeURIComponent(from)}` : '';
        let next: string | null = `/repos/${repo.full_name}/issues?state=all&per_page=100&sort=updated&direction=asc${since}`;
        const batch: GhIssue[] = [];
        let newest: string | null = null;
        for (let page = 0; next && page < MAX_PAGES; page++) {
          const r: { data: GhIssue[]; next: string | null } = await this.api<GhIssue[]>(token, next);
          batch.push(...r.data.filter((i) => !i.pull_request));
          for (const i of r.data) if (!newest || i.updated_at > newest) newest = i.updated_at;
          next = r.next;
        }
        // Issues come oldest update first. When the page cap stops a run early, the next run
        // continues from the newest update fetched (inclusive), so nothing is skipped.
        const capped = !!next && !!newest;
        // Every fetched issue has the update time we started from: the cursor cannot move. Step past
        // that second so later changes keep arriving, and say that some issues may be missing.
        const stuck = capped && repo.sync_cursor !== null && newest === repo.sync_cursor;
        const cursor = stuck ? new Date(Date.parse(newest!) + 1000).toISOString() : capped ? newest : null;
        tx(this.db, () => {
          if (!get(this.db, 'SELECT 1 FROM github_repo WHERE id = ?', repo.id)) return; // removed meanwhile
          let defaulted = 0;
          let defaultSlug: string | null = null;
          let defaultRoleId: string | null = null;
          for (const i of batch) {
            const applied = this.upsertIssue(memberId, repo.id, repo.full_name, i);
            if (applied) {
              defaulted++;
              defaultSlug = applied.slug;
              defaultRoleId = applied.id;
            }
          }
          if (defaulted > 0 && defaultSlug) {
            recordEvent(
              this.db,
              { kind: 'system', memberId },
              'github',
              String(repo.id),
              'github.issue_default_role',
              `${defaulted} new issue${defaulted === 1 ? '' : 's'} labelled for @${defaultSlug}`,
              { count: defaulted, role: defaultSlug, role_id: defaultRoleId, repo: repo.full_name },
            );
          }
          run(this.db, 'UPDATE github_repo SET last_synced_at = ?, sync_cursor = ? WHERE id = ?', started, cursor, repo.id);
        });
        if (stuck) throw new Error(`more than ${MAX_PAGES * 100} issues share the update time ${newest}; some of them may be missing, the next sync continues after it`);
        if (capped) partial.push(repo.full_name);
        count += batch.length;
      } catch (e) {
        errors.push(`${repo.full_name}: ${errMessage(e)}`);
      }
    }
    const ok = errors.length === 0;
    const message = ok
      ? `Synced ${repos.length} repositories, ${count} issues changed${partial.length ? `; not complete yet for ${partial.join(', ')}, the next sync continues` : ''}`
      : errors.join('; ').slice(0, 1000);
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

  /** Inserts a new issue, applying the repo default role only on INSERT, or updates a known one without touching role_id. */
  private upsertIssue(memberId: string, repoId: number, fullName: string, i: GhIssue): { id: string; slug: string } | null {
    const id = `gh_${repoId}_${i.number}`;
    const labels = (i.labels ?? []).map((l) => (typeof l === 'string' ? l : (l.name ?? ''))).filter(Boolean);
    const body = (i.body ?? '').slice(0, MAX_BODY);
    const state = i.state === 'closed' ? 'closed' : 'open';
    const existing = get<{ id: string }>(this.db, 'SELECT id FROM github_issue WHERE repo_id = ? AND number = ?', repoId, i.number);
    if (existing) {
      run(
        this.db,
        `UPDATE github_issue SET title = ?, body = ?, state = ?, labels = ?, url = ?, author = ?, updated_at = ?, closed_at = ?, synced_at = ? WHERE id = ?`,
        i.title.slice(0, 500),
        body,
        state,
        JSON.stringify(labels),
        i.html_url,
        i.user?.login ?? null,
        i.updated_at,
        i.closed_at,
        now(),
        existing.id,
      );
      indexEntity(this.db, memberId, 'issue', existing.id, `${fullName}#${i.number} ${i.title}`, body);
      return null;
    }
    const def = get<{ id: string; slug: string }>(
      this.db,
      `SELECT r.id, r.slug FROM github_repo g JOIN role r ON r.id = g.default_role_id
       WHERE g.id = ? AND r.archived_at IS NULL`,
      repoId,
    );
    run(
      this.db,
      `INSERT INTO github_issue (id, member_id, repo_id, number, title, body, state, labels, url, author, created_at, updated_at, closed_at, role_id, synced_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
      def?.id ?? null,
      now(),
    );
    indexEntity(this.db, memberId, 'issue', id, `${fullName}#${i.number} ${i.title}`, body);
    return def ?? null;
  }
}
