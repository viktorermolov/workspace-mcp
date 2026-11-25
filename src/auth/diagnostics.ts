import { all, now, run, type DB } from '../db/db.ts';

/**
 * OAuth diagnostics: a short log of each step of the connection flow (discovery, registration,
 * authorization, consent, token, first MCP call) so the owner can see where a platform gets stuck.
 * Never stores tokens, codes, secrets or cookies.
 */
export type DiagStep = 'discovery' | 'registration' | 'authorize' | 'login' | 'consent' | 'token' | 'revoke' | 'mcp';

export interface DiagInput {
  client_id?: string | null;
  step: DiagStep;
  method: string;
  path: string;
  status: number;
  outcome: 'ok' | 'error';
  detail?: Record<string, unknown>;
}

const KEEP = 2000;

export function recordDiag(db: DB, d: DiagInput): void {
  try {
    run(
      db,
      'INSERT INTO oauth_diag (at, client_id, step, method, path, status, outcome, detail) VALUES (?,?,?,?,?,?,?,?)',
      now(),
      d.client_id ?? null,
      d.step,
      d.method,
      d.path,
      d.status,
      d.outcome,
      JSON.stringify(d.detail ?? {}),
    );
    run(db, 'DELETE FROM oauth_diag WHERE id <= (SELECT MAX(id) FROM oauth_diag) - ?', KEEP);
  } catch {
    // Diagnostics must never break the flow.
  }
}

export function listDiag(db: DB, opts: { client_id?: string; limit?: number } = {}) {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const rows = opts.client_id
    ? all<Record<string, unknown>>(db, 'SELECT * FROM oauth_diag WHERE client_id = ? ORDER BY id DESC LIMIT ?', opts.client_id, limit)
    : all<Record<string, unknown>>(db, 'SELECT * FROM oauth_diag ORDER BY id DESC LIMIT ?', limit);
  return rows.map((r) => ({ ...r, detail: JSON.parse(String(r.detail)) }));
}

const SAFE_PARAMS = ['client_id', 'response_type', 'scope', 'resource', 'code_challenge_method', 'prompt', 'grant_type', 'token_endpoint_auth_method'];

/** Classifies an /api/auth or /.well-known request into a diagnostics step, or null if not interesting. */
export function classifyAuthPath(pathname: string): DiagStep | null {
  if (pathname.startsWith('/.well-known/')) return 'discovery';
  if (pathname.endsWith('/oauth2/register')) return 'registration';
  if (pathname.endsWith('/oauth2/authorize')) return 'authorize';
  if (pathname.endsWith('/oauth2/consent')) return 'consent';
  if (pathname.endsWith('/oauth2/token')) return 'token';
  if (pathname.endsWith('/oauth2/revoke')) return 'revoke';
  if (pathname.includes('/passkey/verify-authentication')) return 'login';
  return null;
}

/** Extracts only non-secret request parameters for the log. */
export function safeParams(url: URL, form?: URLSearchParams | Record<string, unknown> | null): Record<string, string> {
  const out: Record<string, string> = {};
  const take = (k: string, v: unknown) => {
    if (SAFE_PARAMS.includes(k) && typeof v === 'string') out[k] = v.slice(0, 300);
  };
  url.searchParams.forEach((v, k) => take(k, v));
  if (form instanceof URLSearchParams) form.forEach((v, k) => take(k, v));
  else if (form && typeof form === 'object') for (const [k, v] of Object.entries(form)) take(k, v);
  return out;
}
