import type { ButtonHTMLAttributes, ComponentChildren } from 'preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { ApiError, post } from './api.ts';

/** Loads data on mount and whenever `deps` change; `reload` runs it again. */
export function useData<T>(load: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const reload = useCallback(async () => {
    const n = ++seq.current;
    setLoading(true);
    try {
      const d = await load();
      if (n === seq.current) {
        setData(d);
        setError(null);
      }
    } catch (e) {
      if (n === seq.current) setError(message(e));
    } finally {
      if (n === seq.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, loading, reload, setData };
}

export function message(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) {
    if (e.name === 'NotAllowedError') return 'The passkey prompt was cancelled or timed out.';
    return e.message;
  }
  return String(e);
}

/** Runs an action with a busy flag and an error message; returns a stable runner. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(message(e));
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, run, setError };
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
export function ago(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const s = (Date.parse(iso) - Date.now()) / 1000;
  const abs = Math.abs(s);
  if (abs < 45) return rtf.format(Math.round(s), 'second');
  if (abs < 2700) return rtf.format(Math.round(s / 60), 'minute');
  if (abs < 64800) return rtf.format(Math.round(s / 3600), 'hour');
  if (abs < 2592000) return rtf.format(Math.round(s / 86400), 'day');
  return new Date(iso).toLocaleDateString();
}

export function Time({ at }: { at: string | null | undefined }) {
  if (!at) return <span class="muted">never</span>;
  return (
    <time dateTime={at} title={new Date(at).toLocaleString()}>
      {ago(at)}
    </time>
  );
}

export function Page({ title, actions, children, back }: { title: string; actions?: ComponentChildren; children: ComponentChildren; back?: string }) {
  useEffect(() => {
    document.title = `${title} · Workspace`;
  }, [title]);
  return (
    <section class="page">
      <header class="page-head">
        {back && (
          <a class="back" href={back} aria-label="Back">
            ‹
          </a>
        )}
        <h1>{title}</h1>
        {actions && <div class="page-actions">{actions}</div>}
      </header>
      {children}
    </section>
  );
}

export function Loading({ error, loading, children }: { error?: string | null; loading?: boolean; children?: ComponentChildren }) {
  if (error) return <Alert>{error}</Alert>;
  if (loading && !children) return <p class="muted loading">Loading…</p>;
  return <>{children}</>;
}

export function Alert({ children, kind = 'error' }: { children: ComponentChildren; kind?: 'error' | 'ok' | 'info' | 'warn' }) {
  return (
    <div class={`alert alert-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      {children}
    </div>
  );
}

export function Empty({ children }: { children: ComponentChildren }) {
  return <p class="empty">{children}</p>;
}

export function Button({ busy, children, kind = 'default', ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean; kind?: 'default' | 'primary' | 'danger' | 'quiet' }) {
  return (
    <button type="button" {...rest} class={`btn btn-${kind} ${rest.class ?? ''}`} disabled={busy || rest.disabled} aria-busy={busy ? 'true' : undefined}>
      {children}
    </button>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ComponentChildren; children: ComponentChildren }) {
  return (
    <div class="field">
      <label class="field-control">
        <span class="field-label">{label}</span>
        {children}
      </label>
      {hint && <span class="field-hint">{hint}</span>}
    </div>
  );
}

export function Card({ children, class: cls = '' }: { children: ComponentChildren; class?: string }) {
  return <div class={`card ${cls}`}>{children}</div>;
}

export function Badge({ children, tone = 'neutral' }: { children: ComponentChildren; tone?: 'neutral' | 'accent' | 'warn' | 'danger' | 'ok' }) {
  return <span class={`badge badge-${tone}`}>{children}</span>;
}

export interface DiffLine {
  op: '+' | '-' | ' ' | '…' | string;
  text: string;
}

/** Line-by-line difference, as returned by the server. */
export function Diff({ lines, truncated }: { lines: DiffLine[]; truncated?: boolean }) {
  if (!lines.length) return <p class="muted">No textual difference.</p>;
  return (
    <div class="diff" role="table" aria-label="Line-by-line difference">
      {lines.map((l, i) => (
        <div key={i} role="row" class={`diff-line ${l.op === '+' ? 'add' : l.op === '-' ? 'del' : l.op === ' ' ? 'ctx' : 'gap'}`}>
          <span class="diff-op" aria-hidden="true">
            {l.op === ' ' ? '' : l.op}
          </span>
          <span class="diff-text">{l.text || ' '}</span>
        </div>
      ))}
      {truncated && <div class="diff-line gap">…difference shortened</div>}
    </div>
  );
}

/** Renders text as plain paragraphs: content is data and is never interpreted as HTML. */
export function Prose({ text }: { text: string }) {
  if (!text?.trim()) return <p class="muted">Empty.</p>;
  return <pre class="prose">{text}</pre>;
}

export const STATUS_TONE: Record<string, 'neutral' | 'accent' | 'warn' | 'danger' | 'ok'> = {
  open: 'neutral',
  in_progress: 'accent',
  blocked: 'danger',
  in_review: 'warn',
  done: 'ok',
  cancelled: 'neutral',
};

export const label = (s: string) => s.replace(/_/g, ' ');

/**
 * Archive or restore an item. An archived item can also be deleted permanently, which only the
 * owner can do (agents can only archive), after a confirmation.
 */
export function ArchiveControls({ type, id, archived, onDone, onDeleted }: { type: 'role' | 'project' | 'document' | 'task'; id: string; archived: boolean; onDone: () => void; onDeleted: () => void }) {
  const act = useAction();
  const toggle = () => act.run(() => post('/archive', { type, id, restore: archived })).then((r) => r && onDone());
  const purge = () => {
    if (!confirm(`Delete this ${type} permanently? Its history is deleted too. This cannot be undone.`)) return;
    void act.run(() => post('/purge', { type, id })).then((r) => r && onDeleted());
  };
  return (
    <>
      <Button kind="quiet" busy={act.busy} onClick={toggle}>
        {archived ? 'Restore' : 'Archive'}
      </Button>
      {archived && (
        <Button kind="danger" busy={act.busy} onClick={purge}>
          Delete permanently
        </Button>
      )}
      {act.error && <Alert>{act.error}</Alert>}
    </>
  );
}
