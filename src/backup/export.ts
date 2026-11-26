import { createHash } from 'node:crypto';
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import { all, get, run, tx, type DB } from '../db/db.ts';
import { currentBody, DomainError, indexEntity, slugify } from '../domain/core.ts';
import { indexProject, indexRole, type DocumentRow, type ProjectRow, type RoleRow } from '../domain/entities.ts';
import { indexRoutine, type RoutineRow } from '../domain/routines.ts';
import { indexTask, type TaskRow } from '../domain/tasks.ts';
import { VERSION } from '../version.ts';

/**
 * Export format, version 1: a zip with
 *   manifest.json   format id and version, app version, time, sha256 of every other file, row counts
 *   workspace.json  every workspace table (structure, links, full version history, log)
 *   *.md            readable views (rules, roles, routines, projects, documents, tasks) with YAML front matter
 * Secrets, tokens, webhooks, connections and the GitHub mirror are never included.
 * Import reads workspace.json only; the Markdown files are views for people and other tools.
 */

export const EXPORT_FORMAT = 'workspace-mcp-export';
export const EXPORT_FORMAT_VERSION = 1;
const MAX_UNPACKED = 512 * 1024 * 1024;

/** Tables in insert order (parents before children). `member` marks tables with a member_id column. */
const TABLES: { name: string; member: boolean; order: string }[] = [
  { name: 'version', member: true, order: 'id' },
  { name: 'rules', member: true, order: 'member_id' },
  { name: 'role', member: true, order: 'created_at, id' },
  { name: 'role_link', member: true, order: 'created_at, id' },
  { name: 'routine', member: true, order: 'created_at, id' },
  { name: 'project', member: true, order: 'created_at, id' },
  { name: 'document', member: true, order: 'created_at, id' },
  { name: 'task', member: true, order: 'created_at, id' },
  { name: 'task_dependency', member: false, order: 'task_id, depends_on_id' },
  { name: 'task_comment', member: true, order: 'created_at, id' },
  { name: 'checkpoint', member: true, order: 'created_at, id' },
  { name: 'event', member: true, order: 'id' },
];

type Rows = Record<string, unknown>[];

export interface Manifest {
  format: string;
  format_version: number;
  app_version: string;
  exported_at: string;
  counts: Record<string, number>;
  files: Record<string, string>;
}

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

function frontMatter(meta: Record<string, unknown>): string {
  const lines = Object.entries(meta)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
  return `---\n${lines.join('\n')}\n---\n\n`;
}

function safeName(s: string, fallback: string): string {
  const n = slugify(s).slice(0, 60);
  return n || fallback;
}

function tableRows(db: DB, memberId: string, t: (typeof TABLES)[number]): Rows {
  if (t.name === 'task_dependency') {
    return all(db, 'SELECT d.task_id, d.depends_on_id FROM task_dependency d JOIN task t ON t.id = d.task_id WHERE t.member_id = ? ORDER BY d.task_id, d.depends_on_id', memberId);
  }
  return all(db, `SELECT * FROM ${t.name} WHERE member_id = ? ORDER BY ${t.order}`, memberId);
}

/** Builds the export zip for one member. */
export function buildExport(db: DB, memberId: string): { zip: Uint8Array; manifest: Manifest } {
  const tables: Record<string, Rows> = {};
  for (const t of TABLES) tables[t.name] = tableRows(db, memberId, t).map((r) => (t.member ? { ...r, member_id: undefined } : r));
  const member = get<{ last_review_event_id: number }>(db, 'SELECT last_review_event_id FROM member WHERE id = ?', memberId);
  const files: Record<string, Uint8Array> = {};
  files['workspace.json'] = strToU8(JSON.stringify({ member: { last_review_event_id: member?.last_review_event_id ?? 0 }, tables }, null, 1));

  const slugOf = new Map<string, string>();
  for (const r of tables.role as unknown as RoleRow[]) slugOf.set(r.id, r.slug);
  for (const p of tables.project as unknown as ProjectRow[]) slugOf.set(p.id, p.slug);

  const rules = get<{ current_version: number | null; updated_at: string }>(db, 'SELECT current_version, updated_at FROM rules WHERE member_id = ?', memberId);
  files['rules.md'] = strToU8(frontMatter({ type: 'rules', updated_at: rules?.updated_at }) + currentBody(db, rules?.current_version));

  const used = new Set<string>();
  const unique = (p: string) => {
    let out = p;
    for (let i = 2; used.has(out); i++) out = p.replace(/\.md$/, `-${i}.md`);
    used.add(out);
    return out;
  };
  for (const r of tables.role as unknown as RoleRow[]) {
    const links = (tables.role_link as { from_role_id: string; to_role_id: string; type: string }[]).filter((l) => l.from_role_id === r.id).map((l) => `${l.type}: ${slugOf.get(l.to_role_id) ?? l.to_role_id}`);
    files[unique(`roles/${safeName(r.slug, r.id)}.md`)] = strToU8(
      frontMatter({ type: 'role', id: r.id, slug: r.slug, name: r.name, area: r.area, links: links.length ? links : undefined, edit_any: r.edit_any === 1 || undefined, archived_at: r.archived_at, updated_at: r.updated_at }) +
        currentBody(db, r.current_version) +
        (r.setup_notes ? `\n\n## Setup notes\n\n${r.setup_notes}\n` : ''),
    );
  }
  for (const r of (tables.routine ?? []) as unknown as RoutineRow[]) {
    files[unique(`routines/${safeName(r.name, r.id)}.md`)] = strToU8(
      frontMatter({
        type: 'routine',
        id: r.id,
        name: r.name,
        role: slugOf.get(r.role_id) ?? r.role_id,
        schedule: r.schedule,
        timezone: r.timezone,
        status: r.status,
        external_id: r.external_id,
        last_run_at: r.last_run_at,
        archived_at: r.archived_at,
        updated_at: r.updated_at,
      }) + (r.last_run_result || ''),
    );
  }
  for (const p of tables.project as unknown as ProjectRow[]) {
    files[unique(`projects/${safeName(p.slug, p.id)}.md`)] = strToU8(
      frontMatter({ type: 'project', id: p.id, slug: p.slug, name: p.name, focus: p.focus, state: p.state, repos: JSON.parse(p.repos || '[]'), owner_role: p.owner_role_id ? (slugOf.get(p.owner_role_id) ?? p.owner_role_id) : null, archived_at: p.archived_at, updated_at: p.updated_at }) +
        currentBody(db, p.current_version),
    );
  }
  for (const d of tables.document as unknown as DocumentRow[]) {
    const scope = d.scope_type === 'workspace' ? 'workspace' : `${d.scope_type}-${safeName(slugOf.get(d.scope_id ?? '') ?? d.scope_id ?? '', 'unknown')}`;
    files[unique(`documents/${scope}/${safeName(d.title, d.id)}.md`)] = strToU8(
      frontMatter({ type: 'document', id: d.id, title: d.title, kind: d.kind, scope: d.scope_type, scope_ref: d.scope_id ? (slugOf.get(d.scope_id) ?? d.scope_id) : null, archived_at: d.archived_at, updated_at: d.updated_at }) +
        currentBody(db, d.current_version),
    );
  }
  const deps = tables.task_dependency as { task_id: string; depends_on_id: string }[];
  const comments = tables.task_comment as { task_id: string; body: string; created_at: string; claimed_role: string | null; actor_kind: string }[];
  for (const t of tables.task as unknown as TaskRow[]) {
    const tc = comments.filter((c) => c.task_id === t.id);
    const body = [
      t.description,
      t.result ? `## Result\n\n${t.result}` : '',
      t.blocking_reason ? `## Blocked\n\n${t.blocking_reason}` : '',
      tc.length ? `## Comments\n\n${tc.map((c) => `- ${c.created_at} (${c.claimed_role ?? c.actor_kind}): ${c.body.replace(/\n/g, '\n  ')}`).join('\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    files[unique(`tasks/${safeName(t.title, 'task')}-${t.id.slice(-6)}.md`)] = strToU8(
      frontMatter({
        type: 'task',
        id: t.id,
        title: t.title,
        status: t.status,
        priority: t.priority,
        role: t.role_id ? (slugOf.get(t.role_id) ?? t.role_id) : null,
        project: t.project_id ? (slugOf.get(t.project_id) ?? t.project_id) : null,
        parent: t.parent_id,
        depends_on: deps.filter((d) => d.task_id === t.id).map((d) => d.depends_on_id),
        due_date: t.due_date,
        archived_at: t.archived_at,
        created_at: t.created_at,
        updated_at: t.updated_at,
      }) + body,
    );
  }
  files['README.md'] = strToU8(
    `# Workspace export\n\nExported ${new Date().toISOString()} by workspace-mcp ${VERSION} (format ${EXPORT_FORMAT} v${EXPORT_FORMAT_VERSION}).\n\n` +
      'The Markdown files are readable views with YAML front matter. `workspace.json` holds the complete data, including every version and the log, and is what import reads. `manifest.json` lists a SHA-256 for every file.\n',
  );

  const manifest: Manifest = {
    format: EXPORT_FORMAT,
    format_version: EXPORT_FORMAT_VERSION,
    app_version: VERSION,
    exported_at: new Date().toISOString(),
    counts: Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.length])),
    files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, sha(v)])),
  };
  const zipFiles: Zippable = { 'manifest.json': strToU8(JSON.stringify(manifest, null, 2)) };
  for (const [k, v] of Object.entries(files)) zipFiles[k] = v;
  return { zip: zipSync(zipFiles, { level: 6, mtime: new Date() }), manifest };
}

/** Unpacks and verifies an export: format, version and every file's hash. */
export function readExport(zip: Uint8Array): { manifest: Manifest; data: { member?: { last_review_event_id?: number }; tables: Record<string, Rows> } } {
  let total = 0;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(zip, {
      filter: (f) => {
        total += f.originalSize;
        if (total > MAX_UNPACKED) throw new DomainError('invalid', 'Export is too large');
        return f.name === 'manifest.json' || f.name === 'workspace.json';
      },
    });
  } catch (e) {
    if (e instanceof DomainError) throw e;
    throw new DomainError('invalid', 'Not a valid zip file');
  }
  const m = files['manifest.json'];
  const w = files['workspace.json'];
  if (!m || !w) throw new DomainError('invalid', 'Not a workspace export: manifest.json or workspace.json is missing');
  let manifest: Manifest;
  try {
    manifest = JSON.parse(strFromU8(m)) as Manifest;
  } catch {
    throw new DomainError('invalid', 'manifest.json is not valid JSON');
  }
  if (manifest.format !== EXPORT_FORMAT) throw new DomainError('invalid', 'Not a workspace export');
  if (typeof manifest.format_version !== 'number' || manifest.format_version > EXPORT_FORMAT_VERSION) {
    throw new DomainError('invalid', `Export format version ${manifest.format_version} is newer than this server supports (${EXPORT_FORMAT_VERSION}); upgrade first`);
  }
  if (manifest.files?.['workspace.json'] !== sha(w)) throw new DomainError('invalid', 'Integrity check failed: workspace.json does not match its hash');
  const data = JSON.parse(strFromU8(w)) as { tables: Record<string, Rows> };
  if (!data || typeof data.tables !== 'object') throw new DomainError('invalid', 'workspace.json has no tables');
  return { manifest, data };
}

/** True when the member has no content (only the empty rules row created at first start). */
export function isWorkspaceEmpty(db: DB, memberId: string): boolean {
  for (const t of ['version', 'role', 'project', 'document', 'task', 'checkpoint', 'routine']) {
    if (get(db, `SELECT 1 FROM ${t} WHERE member_id = ? LIMIT 1`, memberId)) return false;
  }
  return true;
}

/** Imports into an empty workspace, keeping ids, versions and the log; rebuilds the search index. */
export function importExport(db: DB, memberId: string, zip: Uint8Array): { counts: Record<string, number>; format_version: number; exported_at: string } {
  const { manifest, data } = readExport(zip);
  return tx(db, () => {
    if (!isWorkspaceEmpty(db, memberId)) throw new DomainError('conflict', 'Import only goes into an empty workspace. Restore a backup or use a fresh data directory instead.');
    const counts: Record<string, number> = {};
    // Events already recorded here (for example connection approvals) keep their ids; imported log
    // entries are shifted after them so the append-only log stays ordered and ids never collide.
    const offset = get<{ m: number | null }>(db, 'SELECT max(id) AS m FROM event')!.m ?? 0;
    for (const t of TABLES) {
      const rows = data.tables[t.name] ?? [];
      if (!Array.isArray(rows)) throw new DomainError('invalid', `workspace.json: ${t.name} is not a list`);
      const cols = (all<{ name: string }>(db, `PRAGMA table_info(${t.name})`)).map((c) => c.name);
      if (t.name === 'rules') {
        const r = rows[0];
        if (r) run(db, 'UPDATE rules SET current_version = ?, rev = ?, updated_at = ? WHERE member_id = ?', r.current_version ?? null, r.rev ?? 1, r.updated_at ?? new Date().toISOString(), memberId);
        counts[t.name] = r ? 1 : 0;
        continue;
      }
      for (const row of rows) {
        const vals: Record<string, unknown> = { ...row };
        if (t.member) vals.member_id = memberId;
        // Working rules belong to the member, so their versions and log entries point at the
        // member id, which differs between instances.
        if ((t.name === 'version' || t.name === 'event') && vals.entity_type === 'rules') vals.entity_id = memberId;
        if (t.name === 'event') vals.id = Number(vals.id) + offset;
        const use = cols.filter((c) => c in vals);
        run(db, `INSERT INTO ${t.name} (${use.join(',')}) VALUES (${use.map(() => '?').join(',')})`, ...use.map((c) => (vals[c] === undefined ? null : vals[c])));
      }
      counts[t.name] = rows.length;
    }
    const lr = Number(data.member?.last_review_event_id ?? 0);
    if (lr > 0) run(db, 'UPDATE member SET last_review_event_id = ? WHERE id = ?', lr + offset, memberId);
    // Rebuild the search index from the imported current state.
    for (const r of all<RoleRow>(db, 'SELECT * FROM role WHERE member_id = ?', memberId)) indexRole(db, r);
    for (const p of all<ProjectRow>(db, 'SELECT * FROM project WHERE member_id = ?', memberId)) indexProject(db, p);
    for (const d of all<DocumentRow>(db, 'SELECT * FROM document WHERE member_id = ?', memberId)) indexEntity(db, memberId, 'document', d.id, d.title, currentBody(db, d.current_version));
    for (const t of all<TaskRow>(db, 'SELECT * FROM task WHERE member_id = ?', memberId)) indexTask(db, t);
    for (const r of all<RoutineRow>(db, 'SELECT * FROM routine WHERE member_id = ?', memberId)) indexRoutine(db, r);
    return { counts, format_version: manifest.format_version, exported_at: manifest.exported_at };
  });
}
