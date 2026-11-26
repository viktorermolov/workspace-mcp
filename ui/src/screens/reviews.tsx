import { useMemo, useState } from 'preact/hooks';
import { api, enc, post } from '../api.ts';
import { navigate, useLocation } from '../router.ts';
import { Alert, Badge, Button, Empty, Field, Loading, Page, Time, useData } from '../ui.tsx';

export type ReviewStatus = 'open' | 'answered' | 'resolved';

function parseLines(raw: string): { start: number; end: number } | null {
  const m = raw.match(/^(\d+)(?:-(\d+))?$/);
  if (!m) return null;
  const start = Number(m[1]);
  const end = Number(m[2] ?? m[1]);
  if (!start || !end) return null;
  return { start, end };
}

function lineKey(start: number, end: number): string {
  return start === end ? String(start) : `${start}-${end}`;
}

export type AnchorState = 'none' | 'exact' | 'moved' | 'outdated';

export interface ReviewAuthor {
  kind: string;
  connection: string | null;
  role: string | null;
  owner?: boolean;
}

export interface ReviewReply {
  id: string;
  body: string;
  author: ReviewAuthor;
  created_at: string;
}

export interface ReviewComment {
  id: string;
  target_type: 'rules' | 'role' | 'project' | 'document';
  target_id: string;
  field: string;
  body: string;
  quote: string;
  status: ReviewStatus;
  anchor_state: AnchorState;
  line_start: number | null;
  line_end: number | null;
  version: number | null;
  anchor_version: number | null;
  anchor_line_start: number | null;
  anchor_line_end: number | null;
  setup_notes_id: number | null;
  responsible_role: string | null;
  rev: number;
  author: ReviewAuthor;
  created_at: string;
  updated_at: string;
  replies?: ReviewReply[];
}

function who(a: ReviewAuthor) {
  if (a.owner || a.kind === 'owner') return 'you';
  const role = a.role ? `@${a.role}` : '';
  return a.connection ? `${a.connection}${role ? ` as ${role}` : ''}` : role || a.kind;
}

export function readHref(type: ReviewComment['target_type'], id: string, version?: number | null): string {
  const base = type === 'rules' ? (id ? `/read/rules/${enc(id)}` : '/read/rules') : `/read/${type}/${enc(id)}`;
  return version ? `${base}?v=${version}` : base;
}

const statusTone: Record<ReviewStatus, 'accent' | 'warn' | 'ok'> = { open: 'accent', answered: 'warn', resolved: 'ok' };

export function CommentCard({
  c,
  onChanged,
}: {
  c: ReviewComment;
  onChanged: () => void;
}) {
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (status?: ReviewStatus) => {
    if (!body.trim() && !status) return;
    setBusy(true);
    setError(null);
    try {
      if (body.trim()) await post(`/reviews/${enc(c.id)}/reply`, { body, rev: c.rev, expected_status: c.status });
      else await post(`/reviews/${enc(c.id)}/status`, { status, rev: c.rev, expected_status: c.status });
      setBody('');
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const resolve = async (status: 'resolved' | 'open') => {
    setBusy(true);
    setError(null);
    try {
      await post(`/reviews/${enc(c.id)}/status`, { status, rev: c.rev, expected_status: c.status });
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const lines = c.anchor_line_start && c.anchor_line_end ? `${c.anchor_line_start}–${c.anchor_line_end}` : c.line_start && c.line_end ? `${c.line_start}–${c.line_end}` : null;
  const ver = c.version;
  return (
    <article class={`review-card status-${c.status}`} id={c.id}>
      <header>
        <Badge tone={statusTone[c.status]}>{c.status}</Badge>
        {c.anchor_state === 'outdated' && <Badge tone="danger">outdated</Badge>}
        {c.anchor_state === 'moved' && <Badge tone="warn">moved</Badge>}
        <span class="muted small">
          {who(c.author)} · <Time at={c.created_at} />
          {c.responsible_role ? ` · @${c.responsible_role}` : ''}
        </span>
      </header>
      {c.quote && <blockquote class="review-quote">{c.quote}</blockquote>}
      <p>
        {ver ? (
          <a href={readHref(c.target_type, c.target_id, ver)}>
            v{ver}
            {lines ? `, lines ${lines}` : ''}
          </a>
        ) : lines ? (
          <span class="muted small">lines {lines}</span>
        ) : c.setup_notes_id ? (
          <span class="muted small">setup notes history #{c.setup_notes_id}</span>
        ) : (
          <span class="muted small">whole {c.field}</span>
        )}
        {' · '}
        <a href={readHref(c.target_type, c.target_id, c.anchor_version && c.anchor_version !== ver ? c.anchor_version : undefined)}>
          Open {c.target_type}
        </a>
      </p>
      <p class="review-body">{c.body}</p>
      {c.replies?.map((r) => (
        <div key={r.id} class="review-reply">
          <span class="muted small">
            {who(r.author)} · <Time at={r.created_at} />
          </span>
          <p>{r.body}</p>
        </div>
      ))}
      {error && <Alert kind="error">{error}</Alert>}
      {c.status !== 'resolved' && (
        <form
          class="review-reply-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Field label="Reply">
            <textarea value={body} onInput={(e) => setBody((e.target as HTMLTextAreaElement).value)} rows={3} />
          </Field>
          <div class="row">
            <Button kind="primary" type="submit" busy={busy} disabled={!body.trim()}>
              Reply
            </Button>
            {c.status === 'answered' ? (
              <Button type="button" busy={busy} onClick={() => void resolve('open')}>
                Reopen
              </Button>
            ) : null}
            <Button type="button" kind="quiet" busy={busy} onClick={() => void resolve('resolved')}>
              Resolve
            </Button>
          </div>
        </form>
      )}
      {c.status === 'resolved' && (
        <Button type="button" kind="quiet" busy={busy} onClick={() => void resolve('open')}>
          Reopen
        </Button>
      )}
    </article>
  );
}

export function ReviewsScreen() {
  const { query } = useLocation();
  const filter = (query.get('status') || 'waiting') as 'waiting' | 'open' | 'answered' | 'resolved' | 'all';
  const statusParam = filter === 'waiting' ? 'open,answered' : filter;
  const list = useData(
    () => api<{ comments: ReviewComment[]; total: number }>(`/reviews?status=${enc(statusParam)}&limit=100`),
    [statusParam],
  );
  const setFilter = (s: string) => navigate(s === 'waiting' ? '/reviews' : `/reviews?status=${s}`);
  return (
    <Page title="Reviews">
      <div class="row wrap filters">
        {(['waiting', 'open', 'answered', 'resolved', 'all'] as const).map((s) => (
          <Button key={s} kind={filter === s ? 'primary' : 'quiet'} onClick={() => setFilter(s)}>
            {s === 'waiting' ? 'Open and answered' : s[0]!.toUpperCase() + s.slice(1)}
          </Button>
        ))}
      </div>
      <Loading error={list.error} loading={list.loading}>
        {list.data && !list.data.comments.length && <Empty>No review comments in this filter.</Empty>}
        <div class="review-list">
          {list.data?.comments.map((c) => (
            <CommentCard key={c.id} c={c} onChanged={() => list.reload()} />
          ))}
        </div>
      </Loading>
    </Page>
  );
}

export function CommentsPane({
  targetType,
  targetId,
  field,
  version,
  comments,
  selected,
  onSelect,
  onChanged,
}: {
  targetType: ReviewComment['target_type'];
  targetId: string;
  field: string;
  version?: number;
  comments: ReviewComment[];
  selected: { start: number; end: number } | null;
  onSelect: (r: { start: number; end: number } | null) => void;
  onChanged: () => void;
}) {
  const [filter, setFilter] = useState<'open' | 'answered' | 'resolved' | 'all'>('open');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shown = useMemo(() => {
    const base = filter === 'all' ? comments : filter === 'open' ? comments.filter((c) => c.status === 'open' || c.status === 'answered') : comments.filter((c) => c.status === filter);
    if (version) return base.filter((c) => c.version === version || c.anchor_version === version);
    return base;
  }, [comments, filter, version]);
  const postComment = async () => {
    if (!body.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await post('/reviews', {
        target_type: targetType,
        target_id: targetId,
        field,
        body,
        version: version || undefined,
        line_start: selected?.start ?? undefined,
        line_end: selected?.end ?? undefined,
      });
      setBody('');
      onSelect(null);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <aside class="review-pane" aria-label="Review comments">
      <h2>Comments</h2>
      <div class="row wrap filters">
        {(['open', 'answered', 'resolved', 'all'] as const).map((s) => (
          <Button key={s} kind={filter === s ? 'primary' : 'quiet'} onClick={() => setFilter(s)}>
            {s[0]!.toUpperCase() + s.slice(1)}
          </Button>
        ))}
      </div>
      {selected && (
        <form
          class="review-new"
          onSubmit={(e) => {
            e.preventDefault();
            void postComment();
          }}
        >
          <p class="muted small">
            Comment on lines {selected.start}–{selected.end}
            {' · '}
            <button type="button" class="linkish" onClick={() => onSelect(null)}>
              Cancel
            </button>
          </p>
          {error && <Alert kind="error">{error}</Alert>}
          <Field label="Your comment">
            <textarea value={body} onInput={(e) => setBody((e.target as HTMLTextAreaElement).value)} rows={4} />
          </Field>
          <Button kind="primary" type="submit" busy={busy} disabled={!body.trim()}>
            Add comment
          </Button>
        </form>
      )}
      {!shown.length && !selected && <Empty>Tap a paragraph to comment.</Empty>}
      {shown.map((c) => (
        <CommentCard key={c.id} c={c} onChanged={onChanged} />
      ))}
    </aside>
  );
}

export function CommentableMarkdown({
  comments,
  selected,
  onSelect,
  children,
}: {
  text: string;
  comments: ReviewComment[];
  selected: { start: number; end: number } | null;
  onSelect: (r: { start: number; end: number } | null) => void;
  children: preact.ComponentChildren;
}) {
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of comments) {
      if (c.status === 'resolved') continue;
      const a = c.anchor_line_start ?? c.line_start;
      const b = c.anchor_line_end ?? c.line_end;
      if (a && b) m.set(lineKey(a, b), (m.get(lineKey(a, b)) ?? 0) + 1);
    }
    return m;
  }, [comments]);
  return (
    <div
      class="md-commentable"
      onClick={(e) => {
        const el = (e.target as HTMLElement).closest('[data-lines]') as HTMLElement | null;
        if (!el || (e.target as HTMLElement).closest('a, button')) return;
        const range = parseLines(el.getAttribute('data-lines') || '');
        if (range) onSelect(selected && selected.start === range.start && selected.end === range.end ? null : range);
      }}
      ref={(node) => {
        if (!node) return;
        for (const el of node.querySelectorAll('[data-lines]')) {
          const key = el.getAttribute('data-lines') || '';
          const n = counts.get(key) ?? 0;
          el.classList.toggle('has-comments', n > 0);
          const range = parseLines(key);
          el.classList.toggle('is-selected', !!(selected && range && range.start === selected.start && range.end === selected.end));
          let badge = el.querySelector(':scope > .comment-count') as HTMLElement | null;
          if (n > 0) {
            if (!badge) {
              badge = document.createElement('span');
              badge.className = 'comment-count';
              el.prepend(badge);
            }
            badge.textContent = String(n);
          } else if (badge) {
            badge.remove();
          }
        }
      }}
    >
      {children}
    </div>
  );
}
