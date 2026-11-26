import { all, get, now, run, tx, type DB } from '../db/db.ts';
import {
  addVersion,
  checkLen,
  checkRev,
  currentBody,
  DomainError,
  idempotent,
  indexEntity,
  invalid,
  LIMITS,
  newId,
  notFound,
  recordEvent,
  slugify,
  unindexEntity,
  type Actor,
} from './core.ts';

// ---------- members ----------

export interface Member {
  id: string;
  user_id: string | null;
  name: string;
  is_owner: number;
  last_review_event_id: number;
  last_visit_at: string | null;
}

export function ownerMember(db: DB): Member | undefined {
  return get<Member>(db, 'SELECT * FROM member WHERE is_owner = 1 ORDER BY created_at LIMIT 1');
}

export function memberByUser(db: DB, userId: string): Member | undefined {
  return get<Member>(db, 'SELECT * FROM member WHERE user_id = ?', userId);
}

/** The owner member always exists so agents can fill the workspace before the passkey is registered. */
export function ensureOwnerMember(db: DB): Member {
  const m = ownerMember(db);
  if (m) return m;
  const id = newId('mem');
  run(db, 'INSERT INTO member (id, user_id, name, is_owner, created_at) VALUES (?,?,?,1,?)', id, null, 'Owner', now());
  run(db, 'INSERT INTO rules (member_id, current_version, rev, updated_at) VALUES (?, NULL, 1, ?)', id, now());
  return ownerMember(db)!;
}

// ---------- working rules ----------

export function getRules(db: DB, memberId: string) {
  const r = get<{ current_version: number | null; rev: number; updated_at: string }>(db, 'SELECT * FROM rules WHERE member_id = ?', memberId);
  if (!r) throw notFound('working rules', memberId);
  const v = r.current_version ? get<{ number: number }>(db, 'SELECT number FROM version WHERE id = ?', r.current_version) : undefined;
  return { text: currentBody(db, r.current_version), rev: r.rev, version: v?.number ?? 0, updated_at: r.updated_at };
}

export function updateRules(db: DB, actor: Actor, input: { text: string; rev?: number; note?: string }) {
  checkLen('text', input.text, LIMITS.instruction);
  return tx(db, () => {
    const r = getRules(db, actor.memberId);
    // The first text needs no rev (there is nothing to overwrite); every later change does.
    if (r.version > 0 || input.rev !== undefined) checkRev('working rules', 'rules', r.rev, input.rev);
    if (r.text === input.text) return { ...r, unchanged: true };
    const v = addVersion(db, actor, 'rules', actor.memberId, input.text, input.note);
    run(db, 'UPDATE rules SET rev = rev + 1, updated_at = ? WHERE member_id = ?', now(), actor.memberId);
    recordEvent(db, actor, 'rules', actor.memberId, 'rules.updated', `Working rules updated to version ${v.number}`, { version: v.number, note: input.note ?? null });
    return { ...getRules(db, actor.memberId), unchanged: false };
  });
}

// ---------- roles ----------

export interface RoleRow {
  id: string;
  member_id: string;
  slug: string;
  name: string;
  area: string;
  setup_notes: string;
  current_version: number | null;
  rev: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export function findRole(db: DB, memberId: string, ref: string, includeArchived = true): RoleRow | undefined {
  return get<RoleRow>(
    db,
    `SELECT * FROM role WHERE member_id = ? AND (id = ? OR slug = ?) ${includeArchived ? '' : 'AND archived_at IS NULL'}`,
    memberId,
    ref,
    ref,
  );
}

export function requireRole(db: DB, memberId: string, ref: string): RoleRow {
  const r = findRole(db, memberId, ref);
  if (!r) throw notFound('role', ref);
  return r;
}

export function roleLinks(db: DB, roleId: string) {
  return all<{ id: string; from_role_id: string; to_role_id: string; type: string; from_slug: string; to_slug: string }>(
    db,
    `SELECT l.id, l.from_role_id, l.to_role_id, l.type, f.slug AS from_slug, t.slug AS to_slug
     FROM role_link l JOIN role f ON f.id = l.from_role_id JOIN role t ON t.id = l.to_role_id
     WHERE l.from_role_id = ? OR l.to_role_id = ? ORDER BY l.created_at`,
    roleId,
    roleId,
  );
}

export function roleView(db: DB, r: RoleRow, withInstruction = true) {
  const v = r.current_version ? get<{ number: number }>(db, 'SELECT number FROM version WHERE id = ?', r.current_version) : undefined;
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    area: r.area,
    setup_notes: r.setup_notes,
    ...(withInstruction ? { instruction: currentBody(db, r.current_version) } : {}),
    instruction_version: v?.number ?? 0,
    links: roleLinks(db, r.id).map((l) => ({ id: l.id, from: l.from_slug, to: l.to_slug, type: l.type })),
    rev: r.rev,
    archived: !!r.archived_at,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export interface SaveRoleInput {
  id?: string;
  rev?: number;
  name?: string;
  slug?: string;
  area?: string;
  instruction?: string;
  setup_notes?: string;
  links?: { to: string; type: string }[];
  note?: string;
  idempotency_key?: string;
}

function setRoleLinks(db: DB, actor: Actor, role: RoleRow, links: { to: string; type: string }[]): void {
  if (links.length > 50) throw invalid('at most 50 links per role');
  run(db, 'DELETE FROM role_link WHERE from_role_id = ?', role.id);
  for (const l of links) {
    checkLen('link type', l.type, 100);
    if (!l.type.trim()) throw invalid('link type must not be empty');
    const target = requireRole(db, actor.memberId, l.to);
    if (target.id === role.id) throw invalid('a role cannot link to itself');
    run(
      db,
      'INSERT OR IGNORE INTO role_link (id, member_id, from_role_id, to_role_id, type, created_at) VALUES (?,?,?,?,?,?)',
      newId('link'),
      actor.memberId,
      role.id,
      target.id,
      l.type.trim(),
      now(),
    );
  }
}

export function indexRole(db: DB, r: RoleRow): void {
  indexEntity(db, r.member_id, 'role', r.id, r.name, `${r.slug}\n${r.area}\n${currentBody(db, r.current_version)}`);
}

export function saveRole(db: DB, actor: Actor, input: SaveRoleInput) {
  checkLen('name', input.name, LIMITS.title);
  checkLen('area', input.area, LIMITS.shortText);
  checkLen('instruction', input.instruction, LIMITS.instruction);
  checkLen('setup_notes', input.setup_notes, LIMITS.text);
  if (input.slug !== undefined && !/^[a-z0-9][a-z0-9-]{0,59}$/.test(input.slug)) throw invalid('slug must be lowercase letters, digits and dashes (max 60)');
  return tx(db, () => {
    if (!input.id) {
      return idempotent(db, actor.memberId, input.idempotency_key, 'save_role', () => {
        if (!input.name?.trim()) throw invalid('name is required to create a role');
        const slug = input.slug ?? slugify(input.name);
        if (findRole(db, actor.memberId, slug)) throw new DomainError('conflict', `a role with slug "${slug}" already exists`);
        const id = newId('role');
        const at = now();
        run(
          db,
          'INSERT INTO role (id, member_id, slug, name, area, setup_notes, rev, created_at, updated_at) VALUES (?,?,?,?,?,?,1,?,?)',
          id,
          actor.memberId,
          slug,
          input.name.trim(),
          input.area ?? '',
          input.setup_notes ?? '',
          at,
          at,
        );
        let role = requireRole(db, actor.memberId, id);
        if (input.instruction) addVersion(db, actor, 'role', id, input.instruction, input.note);
        if (input.links) setRoleLinks(db, actor, role, input.links);
        role = requireRole(db, actor.memberId, id);
        indexRole(db, role);
        recordEvent(db, actor, 'role', id, 'role.created', `Role "${role.name}" created`, { slug });
        return roleView(db, role);
      });
    }
    const role = requireRole(db, actor.memberId, input.id);
    checkRev('role', role.slug, role.rev, input.rev);
    const changed: string[] = [];
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const f of ['name', 'area', 'setup_notes', 'slug'] as const) {
      const v = input[f];
      if (v !== undefined && v !== role[f]) {
        if (f === 'slug') {
          const other = findRole(db, actor.memberId, v);
          if (other && other.id !== role.id) throw new DomainError('conflict', `a role with slug "${v}" already exists`);
        }
        if (f === 'name' && !v.trim()) throw invalid('name must not be empty');
        sets.push(`${f} = ?`);
        vals.push(v);
        changed.push(f);
      }
    }
    let instructionVersion: number | undefined;
    if (input.instruction !== undefined && input.instruction !== currentBody(db, role.current_version)) {
      instructionVersion = addVersion(db, actor, 'role', role.id, input.instruction, input.note).number;
      changed.push('instruction');
    }
    if (input.links) {
      const before = JSON.stringify(roleLinks(db, role.id).filter((l) => l.from_role_id === role.id).map((l) => [l.to_slug, l.type]));
      setRoleLinks(db, actor, role, input.links);
      const after = JSON.stringify(roleLinks(db, role.id).filter((l) => l.from_role_id === role.id).map((l) => [l.to_slug, l.type]));
      if (before !== after) changed.push('links');
    }
    if (changed.length === 0) return { ...roleView(db, role), unchanged: true };
    sets.push('rev = rev + 1', 'updated_at = ?');
    vals.push(now(), role.id);
    run(db, `UPDATE role SET ${sets.join(', ')} WHERE id = ?`, ...vals);
    const updated = requireRole(db, actor.memberId, role.id);
    indexRole(db, updated);
    if (instructionVersion) {
      recordEvent(db, actor, 'role', role.id, 'role.instruction_updated', `Instruction of role "${updated.name}" updated to version ${instructionVersion}`, {
        version: instructionVersion,
        changed,
        note: input.note ?? null,
      });
    } else {
      recordEvent(db, actor, 'role', role.id, 'role.updated', `Role "${updated.name}" updated: ${changed.join(', ')}`, { changed });
    }
    return roleView(db, updated);
  });
}

export function listRoles(db: DB, memberId: string, includeArchived = false) {
  return all<RoleRow>(db, `SELECT * FROM role WHERE member_id = ? ${includeArchived ? '' : 'AND archived_at IS NULL'} ORDER BY name`, memberId);
}

// ---------- projects ----------

export interface ProjectRow {
  id: string;
  member_id: string;
  slug: string;
  name: string;
  focus: string;
  state: string;
  repos: string;
  current_version: number | null;
  rev: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export function findProject(db: DB, memberId: string, ref: string): ProjectRow | undefined {
  return get<ProjectRow>(db, 'SELECT * FROM project WHERE member_id = ? AND (id = ? OR slug = ?)', memberId, ref, ref);
}
export function requireProject(db: DB, memberId: string, ref: string): ProjectRow {
  const p = findProject(db, memberId, ref);
  if (!p) throw notFound('project', ref);
  return p;
}

export function projectView(db: DB, p: ProjectRow, withDescription = true) {
  const v = p.current_version ? get<{ number: number }>(db, 'SELECT number FROM version WHERE id = ?', p.current_version) : undefined;
  return {
    id: p.id,
    slug: p.slug,
    name: p.name,
    focus: p.focus,
    state: p.state,
    repos: JSON.parse(p.repos) as string[],
    ...(withDescription ? { description: currentBody(db, p.current_version) } : {}),
    description_version: v?.number ?? 0,
    rev: p.rev,
    archived: !!p.archived_at,
    created_at: p.created_at,
    updated_at: p.updated_at,
  };
}

export interface SaveProjectInput {
  id?: string;
  rev?: number;
  name?: string;
  slug?: string;
  description?: string;
  focus?: string;
  state?: string;
  repos?: string[];
  note?: string;
  idempotency_key?: string;
}

export function indexProject(db: DB, p: ProjectRow): void {
  indexEntity(db, p.member_id, 'project', p.id, p.name, `${p.slug}\n${p.focus}\n${p.state}\n${currentBody(db, p.current_version)}`);
}

function validateRepos(repos: string[] | undefined): void {
  if (!repos) return;
  if (repos.length > 50) throw invalid('at most 50 repository links');
  for (const r of repos) {
    checkLen('repo', r, 500);
    if (!/^(https?:\/\/\S+|[\w.-]+\/[\w.-]+)$/.test(r)) throw invalid(`repository link must be a URL or owner/name: ${r}`);
  }
}

export function saveProject(db: DB, actor: Actor, input: SaveProjectInput) {
  checkLen('name', input.name, LIMITS.title);
  checkLen('focus', input.focus, LIMITS.shortText);
  checkLen('state', input.state, LIMITS.text);
  checkLen('description', input.description, LIMITS.document);
  validateRepos(input.repos);
  if (input.slug !== undefined && !/^[a-z0-9][a-z0-9-]{0,59}$/.test(input.slug)) throw invalid('slug must be lowercase letters, digits and dashes (max 60)');
  return tx(db, () => {
    if (!input.id) {
      return idempotent(db, actor.memberId, input.idempotency_key, 'save_project', () => {
        if (!input.name?.trim()) throw invalid('name is required to create a project');
        const slug = input.slug ?? slugify(input.name);
        if (findProject(db, actor.memberId, slug)) throw new DomainError('conflict', `a project with slug "${slug}" already exists`);
        const id = newId('proj');
        const at = now();
        run(
          db,
          'INSERT INTO project (id, member_id, slug, name, focus, state, repos, rev, created_at, updated_at) VALUES (?,?,?,?,?,?,?,1,?,?)',
          id,
          actor.memberId,
          slug,
          input.name.trim(),
          input.focus ?? '',
          input.state ?? '',
          JSON.stringify(input.repos ?? []),
          at,
          at,
        );
        if (input.description) addVersion(db, actor, 'project', id, input.description, input.note);
        const p = requireProject(db, actor.memberId, id);
        indexProject(db, p);
        recordEvent(db, actor, 'project', id, 'project.created', `Project "${p.name}" created`, { slug });
        return projectView(db, p);
      });
    }
    const p = requireProject(db, actor.memberId, input.id);
    checkRev('project', p.slug, p.rev, input.rev);
    const changed: string[] = [];
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const f of ['name', 'slug', 'focus', 'state'] as const) {
      const v = input[f];
      if (v !== undefined && v !== p[f]) {
        if (f === 'slug') {
          const other = findProject(db, actor.memberId, v);
          if (other && other.id !== p.id) throw new DomainError('conflict', `a project with slug "${v}" already exists`);
        }
        if (f === 'name' && !v.trim()) throw invalid('name must not be empty');
        sets.push(`${f} = ?`);
        vals.push(v);
        changed.push(f);
      }
    }
    if (input.repos !== undefined && JSON.stringify(input.repos) !== p.repos) {
      sets.push('repos = ?');
      vals.push(JSON.stringify(input.repos));
      changed.push('repos');
    }
    let ver: number | undefined;
    if (input.description !== undefined && input.description !== currentBody(db, p.current_version)) {
      ver = addVersion(db, actor, 'project', p.id, input.description, input.note).number;
      changed.push('description');
    }
    if (changed.length === 0) return { ...projectView(db, p), unchanged: true };
    sets.push('rev = rev + 1', 'updated_at = ?');
    vals.push(now(), p.id);
    run(db, `UPDATE project SET ${sets.join(', ')} WHERE id = ?`, ...vals);
    const updated = requireProject(db, actor.memberId, p.id);
    indexProject(db, updated);
    recordEvent(db, actor, 'project', p.id, 'project.updated', `Project "${updated.name}" updated: ${changed.join(', ')}`, {
      changed,
      ...(ver ? { version: ver } : {}),
      ...(input.focus !== undefined ? { focus: updated.focus } : {}),
    });
    return projectView(db, updated);
  });
}

export function listProjects(db: DB, memberId: string, includeArchived = false) {
  return all<ProjectRow>(db, `SELECT * FROM project WHERE member_id = ? ${includeArchived ? '' : 'AND archived_at IS NULL'} ORDER BY name`, memberId);
}

// ---------- documents ----------

export interface DocumentRow {
  id: string;
  member_id: string;
  title: string;
  kind: string;
  scope_type: 'workspace' | 'project' | 'role';
  scope_id: string | null;
  current_version: number | null;
  rev: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export function requireDocument(db: DB, memberId: string, id: string): DocumentRow {
  const d = get<DocumentRow>(db, 'SELECT * FROM document WHERE member_id = ? AND id = ?', memberId, id);
  if (!d) throw notFound('document', id);
  return d;
}

export function documentView(db: DB, d: DocumentRow, withBody = true) {
  const v = d.current_version ? get<{ number: number }>(db, 'SELECT number FROM version WHERE id = ?', d.current_version) : undefined;
  let scope: string | null = null;
  if (d.scope_type === 'project' && d.scope_id) scope = get<{ slug: string }>(db, 'SELECT slug FROM project WHERE id = ?', d.scope_id)?.slug ?? d.scope_id;
  if (d.scope_type === 'role' && d.scope_id) scope = get<{ slug: string }>(db, 'SELECT slug FROM role WHERE id = ?', d.scope_id)?.slug ?? d.scope_id;
  return {
    id: d.id,
    title: d.title,
    kind: d.kind,
    attached_to: d.scope_type === 'workspace' ? { type: 'workspace' } : { type: d.scope_type, id: d.scope_id, slug: scope },
    ...(withBody ? { body: currentBody(db, d.current_version) } : {}),
    version: v?.number ?? 0,
    rev: d.rev,
    archived: !!d.archived_at,
    created_at: d.created_at,
    updated_at: d.updated_at,
  };
}

export interface SaveDocumentInput {
  id?: string;
  rev?: number;
  title?: string;
  kind?: string;
  body?: string;
  attach_to?: { type: 'workspace' | 'project' | 'role'; id?: string };
  note?: string;
  idempotency_key?: string;
}

function resolveScope(db: DB, memberId: string, a?: SaveDocumentInput['attach_to']): { type: DocumentRow['scope_type']; id: string | null } {
  if (!a || a.type === 'workspace') return { type: 'workspace', id: null };
  if (!a.id) throw invalid(`attach_to.id is required for type ${a.type}`);
  if (a.type === 'project') return { type: 'project', id: requireProject(db, memberId, a.id).id };
  return { type: 'role', id: requireRole(db, memberId, a.id).id };
}

export function saveDocument(db: DB, actor: Actor, input: SaveDocumentInput) {
  checkLen('title', input.title, LIMITS.title);
  checkLen('kind', input.kind, 50);
  checkLen('body', input.body, LIMITS.document);
  return tx(db, () => {
    if (!input.id) {
      return idempotent(db, actor.memberId, input.idempotency_key, 'save_document', () => {
        if (!input.title?.trim()) throw invalid('title is required to create a document');
        const scope = resolveScope(db, actor.memberId, input.attach_to);
        const id = newId('doc');
        const at = now();
        run(
          db,
          'INSERT INTO document (id, member_id, title, kind, scope_type, scope_id, rev, created_at, updated_at) VALUES (?,?,?,?,?,?,1,?,?)',
          id,
          actor.memberId,
          input.title.trim(),
          (input.kind || 'note').trim(),
          scope.type,
          scope.id,
          at,
          at,
        );
        addVersion(db, actor, 'document', id, input.body ?? '', input.note);
        const d = requireDocument(db, actor.memberId, id);
        indexEntity(db, actor.memberId, 'document', id, d.title, input.body ?? '');
        recordEvent(db, actor, 'document', id, 'document.created', `Document "${d.title}" created`, { kind: d.kind, scope_type: d.scope_type, scope_id: d.scope_id });
        return documentView(db, d);
      });
    }
    const d = requireDocument(db, actor.memberId, input.id);
    checkRev('document', d.id, d.rev, input.rev);
    const changed: string[] = [];
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (input.title !== undefined && input.title !== d.title) {
      if (!input.title.trim()) throw invalid('title must not be empty');
      sets.push('title = ?');
      vals.push(input.title.trim());
      changed.push('title');
    }
    if (input.kind !== undefined && input.kind !== d.kind) {
      sets.push('kind = ?');
      vals.push(input.kind);
      changed.push('kind');
    }
    if (input.attach_to) {
      const s = resolveScope(db, actor.memberId, input.attach_to);
      if (s.type !== d.scope_type || s.id !== d.scope_id) {
        sets.push('scope_type = ?', 'scope_id = ?');
        vals.push(s.type, s.id);
        changed.push('attached_to');
      }
    }
    let ver: number | undefined;
    if (input.body !== undefined && input.body !== currentBody(db, d.current_version)) {
      ver = addVersion(db, actor, 'document', d.id, input.body, input.note).number;
      changed.push('body');
    }
    if (changed.length === 0) return { ...documentView(db, d), unchanged: true };
    sets.push('rev = rev + 1', 'updated_at = ?');
    vals.push(now(), d.id);
    run(db, `UPDATE document SET ${sets.join(', ')} WHERE id = ?`, ...vals);
    const updated = requireDocument(db, actor.memberId, d.id);
    indexEntity(db, actor.memberId, 'document', d.id, updated.title, currentBody(db, updated.current_version));
    recordEvent(db, actor, 'document', d.id, 'document.updated', `Document "${updated.title}" updated: ${changed.join(', ')}`, {
      changed,
      ...(ver ? { version: ver } : {}),
      scope_type: updated.scope_type,
      scope_id: updated.scope_id,
    });
    return documentView(db, updated);
  });
}

// ---------- archive / restore / purge ----------

export type ArchivableType = 'role' | 'project' | 'document' | 'task';
const archTable: Record<ArchivableType, string> = { role: 'role', project: 'project', document: 'document', task: 'task' };
const nameColumn: Record<ArchivableType, string> = { role: 'name', project: 'name', document: 'title', task: 'title' };

/** How the change log names an item, for example `Task "Fix login"`. */
export function logLabel(db: DB, type: ArchivableType, id: string): string {
  const row = get<{ label: string | null }>(db, `SELECT ${nameColumn[type]} AS label FROM ${archTable[type]} WHERE id = ?`, id);
  const kind = type.charAt(0).toUpperCase() + type.slice(1);
  return row?.label ? `${kind} "${row.label}"` : `${kind} ${id}`;
}

export function resolveEntityId(db: DB, memberId: string, type: ArchivableType, ref: string): string {
  if (type === 'role') return requireRole(db, memberId, ref).id;
  if (type === 'project') return requireProject(db, memberId, ref).id;
  const row = get<{ id: string }>(db, `SELECT id FROM ${archTable[type]} WHERE member_id = ? AND id = ?`, memberId, ref);
  if (!row) throw notFound(type, ref);
  return row.id;
}

export function setArchived(db: DB, actor: Actor, type: ArchivableType, ref: string, archived: boolean) {
  return tx(db, () => {
    const id = resolveEntityId(db, actor.memberId, type, ref);
    const row = get<{ archived_at: string | null }>(db, `SELECT archived_at FROM ${archTable[type]} WHERE id = ?`, id)!;
    if (!!row.archived_at === archived) return { type, id, archived, unchanged: true };
    run(db, `UPDATE ${archTable[type]} SET archived_at = ?, rev = rev + 1, updated_at = ? WHERE id = ?`, archived ? now() : null, now(), id);
    recordEvent(db, actor, type, id, archived ? `${type}.archived` : `${type}.restored`, `${logLabel(db, type, id)} ${archived ? 'archived' : 'restored'}`);
    return { type, id, archived, unchanged: false };
  });
}

/** Permanent deletion. Owner only (never exposed through MCP). Only archived items can be purged. */
export function purge(db: DB, actor: Actor, type: ArchivableType, ref: string) {
  if (actor.kind !== 'owner') throw new DomainError('forbidden', 'only the owner can delete permanently');
  return tx(db, () => {
    const id = resolveEntityId(db, actor.memberId, type, ref);
    const row = get<{ archived_at: string | null }>(db, `SELECT archived_at FROM ${archTable[type]} WHERE id = ?`, id)!;
    if (!row.archived_at) throw invalid('archive the item first; only archived items can be deleted permanently');
    const label = logLabel(db, type, id);
    run(db, 'INSERT OR IGNORE INTO purge_guard (id) VALUES (1)');
    try {
      if (type === 'task') {
        const children = get<{ n: number }>(db, 'SELECT count(*) AS n FROM task WHERE parent_id = ?', id)!;
        if (children.n > 0) throw invalid('the task has subtasks; delete or move them first');
        run(db, 'DELETE FROM task_dependency WHERE task_id = ? OR depends_on_id = ?', id, id);
        run(db, 'DELETE FROM task_comment WHERE task_id = ?', id);
        run(db, 'DELETE FROM task WHERE id = ?', id);
      } else if (type === 'document') {
        run(db, "DELETE FROM version WHERE entity_type = 'document' AND entity_id = ?", id);
        run(db, 'DELETE FROM document WHERE id = ?', id);
      } else if (type === 'project') {
        const used = get<{ n: number }>(
          db,
          "SELECT (SELECT count(*) FROM task WHERE project_id = ?) + (SELECT count(*) FROM document WHERE scope_type='project' AND scope_id = ?) AS n",
          id,
          id,
        )!;
        if (used.n > 0) throw invalid('the project still has tasks or documents; delete or move them first');
        run(db, 'UPDATE github_repo SET project_id = NULL WHERE project_id = ?', id);
        run(db, 'DELETE FROM checkpoint WHERE project_id = ?', id);
        run(db, "DELETE FROM version WHERE entity_type = 'project' AND entity_id = ?", id);
        run(db, 'DELETE FROM project WHERE id = ?', id);
      } else {
        const used = get<{ n: number }>(
          db,
          "SELECT (SELECT count(*) FROM task WHERE role_id = ?) + (SELECT count(*) FROM document WHERE scope_type='role' AND scope_id = ?) AS n",
          id,
          id,
        )!;
        if (used.n > 0) throw invalid('the role still has tasks or documents; delete or move them first');
        run(db, 'DELETE FROM role_link WHERE from_role_id = ? OR to_role_id = ?', id, id);
        run(db, 'DELETE FROM checkpoint WHERE role_id = ?', id);
        run(db, 'DELETE FROM webhook WHERE role_id = ?', id);
        run(db, 'UPDATE github_issue SET role_id = NULL WHERE role_id = ?', id);
        run(db, "DELETE FROM version WHERE entity_type = 'role' AND entity_id = ?", id);
        run(db, 'DELETE FROM role WHERE id = ?', id);
      }
    } finally {
      run(db, 'DELETE FROM purge_guard');
    }
    unindexEntity(db, type, id);
    recordEvent(db, actor, type, id, `${type}.deleted`, `${label} deleted permanently`);
    return { type, id, deleted: true };
  });
}
