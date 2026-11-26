import { diffLines } from 'diff';
import { get, now, run, tx, type DB } from '../db/db.ts';
import { addVersion, DomainError, getVersion, indexEntity, listVersions, notFound, recordEvent, type Actor, type VersionedType } from './core.ts';
import { indexProject, indexRole, logLabel, requireDocument, requireProject, requireRole, type ProjectRow, type RoleRow } from './entities.ts';

export interface DiffLine {
  op: '+' | '-' | ' ';
  text: string;
}

/** Line-by-line comparison. Unchanged runs longer than 2*context are collapsed into a marker. */
export function lineDiff(a: string, b: string, context = 3): { lines: DiffLine[]; added: number; removed: number } {
  // Compare whole lines: a missing final newline must not make the last line look changed.
  const nl = (t: string) => (t === '' || t.endsWith('\n') ? t : t + '\n');
  const parts = diffLines(nl(a), nl(b));
  const lines: DiffLine[] = [];
  let added = 0;
  let removed = 0;
  for (const p of parts) {
    const ls = p.value.replace(/\n$/, '').split('\n');
    const op: DiffLine['op'] = p.added ? '+' : p.removed ? '-' : ' ';
    if (op === '+') added += ls.length;
    if (op === '-') removed += ls.length;
    for (const text of ls) lines.push({ op, text });
  }
  if (context < 0) return { lines, added, removed };
  const keep = new Array(lines.length).fill(false);
  lines.forEach((l, i) => {
    if (l.op !== ' ') for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j++) keep[j] = true;
  });
  const out: DiffLine[] = [];
  let skipped = 0;
  lines.forEach((l, i) => {
    if (keep[i]) {
      if (skipped) out.push({ op: ' ', text: `… ${skipped} unchanged line${skipped === 1 ? '' : 's'} …` });
      skipped = 0;
      out.push(l);
    } else skipped++;
  });
  if (skipped && out.length) out.push({ op: ' ', text: `… ${skipped} unchanged line${skipped === 1 ? '' : 's'} …` });
  return { lines: out, added, removed };
}

export function diffText(d: { lines: DiffLine[] }): string {
  return d.lines.map((l) => `${l.op} ${l.text}`).join('\n');
}

/** Resolves a versioned entity reference to its internal id. */
export function versionedId(db: DB, memberId: string, type: VersionedType, ref?: string): string {
  if (type === 'rules') return memberId;
  if (!ref) throw notFound(type, '(missing id)');
  if (type === 'role') return requireRole(db, memberId, ref).id;
  if (type === 'project') return requireProject(db, memberId, ref).id;
  return requireDocument(db, memberId, ref).id;
}

export function versionHistory(db: DB, memberId: string, type: VersionedType, ref: string | undefined, limit = 50, before?: number) {
  const id = versionedId(db, memberId, type, ref);
  return listVersions(db, type, id, limit, before).map((v) => ({
    number: v.number,
    author: v.actor_kind === 'owner' ? 'owner' : v.actor_kind === 'system' ? 'system' : { connection: v.connection_name, role: v.claimed_role },
    note: v.note,
    rollback_of: v.rollback_of,
    created_at: v.created_at,
  }));
}

export function compareVersions(db: DB, memberId: string, type: VersionedType, ref: string | undefined, from: number, to: number, context = 3) {
  const id = versionedId(db, memberId, type, ref);
  const a = from === 0 ? '' : getVersion(db, type, id, from).body;
  const b = getVersion(db, type, id, to).body;
  const d = lineDiff(a, b, context);
  return { type, id, from, to, added: d.added, removed: d.removed, diff: d.lines };
}

const entityTable: Record<Exclude<VersionedType, 'rules'>, string> = { role: 'role', project: 'project', document: 'document' };

/** Rollback = a new version with the text of an old one. Nothing is erased. */
export function rollback(db: DB, actor: Actor, type: VersionedType, ref: string | undefined, toNumber: number, rev: number | undefined, note?: string) {
  return tx(db, () => {
    const id = versionedId(db, actor.memberId, type, ref);
    const target = getVersion(db, type, id, toNumber);
    const current =
      type === 'rules'
        ? get<{ rev: number }>(db, 'SELECT rev FROM rules WHERE member_id = ?', id)!
        : get<{ rev: number }>(db, `SELECT rev FROM ${entityTable[type]} WHERE id = ?`, id)!;
    if (rev !== undefined && rev !== current.rev) {
      throw new DomainError('conflict', `${type} ${id} changed since you read it: your rev ${rev}, current rev ${current.rev}`, { current_rev: current.rev });
    }
    const v = addVersion(db, actor, type, id, target.body, note ?? `Rollback to version ${toNumber}`, target.id);
    if (type === 'rules') run(db, 'UPDATE rules SET rev = rev + 1, updated_at = ? WHERE member_id = ?', now(), id);
    else run(db, `UPDATE ${entityTable[type]} SET rev = rev + 1, updated_at = ? WHERE id = ?`, now(), id);
    if (type === 'document') {
      const d = requireDocument(db, actor.memberId, id);
      indexEntity(db, actor.memberId, 'document', id, d.title, target.body);
    } else if (type === 'role') {
      indexRole(db, get<RoleRow>(db, 'SELECT * FROM role WHERE id = ?', id)!);
    } else if (type === 'project') {
      indexProject(db, get<ProjectRow>(db, 'SELECT * FROM project WHERE id = ?', id)!);
    }
    const action = type === 'rules' ? 'rules.updated' : type === 'role' ? 'role.instruction_updated' : `${type}.updated`;
    const label = type === 'rules' ? 'Working rules' : logLabel(db, type, id);
    recordEvent(db, actor, type, id, action, `${label} rolled back to version ${toNumber} (new version ${v.number})`, {
      version: v.number,
      rollback_to: toNumber,
      changed: [type === 'role' ? 'instruction' : type === 'document' ? 'body' : type === 'project' ? 'description' : 'text'],
    });
    return { type, id, new_version: v.number, restored_from: toNumber };
  });
}
