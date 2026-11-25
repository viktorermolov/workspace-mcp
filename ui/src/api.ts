/** Thin client for the owner API. Every call runs under the owner session cookie, same origin only. */

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

type Init = { method?: string; json?: unknown; body?: BodyInit; headers?: Record<string, string> };

export async function request(path: string, init: Init = {}): Promise<Response> {
  const headers: Record<string, string> = { ...init.headers };
  let body = init.body;
  if (init.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(init.json);
  }
  const res = await fetch(path, { method: init.method ?? (body ? 'POST' : 'GET'), headers, body, credentials: 'same-origin' });
  if (!res.ok) {
    let code = 'error';
    let message = `Request failed (${res.status})`;
    try {
      const j = (await res.json()) as { error?: string; message?: string; code?: string };
      code = j.error ?? j.code ?? code;
      message = j.message ?? message;
    } catch {
      /* not JSON */
    }
    if (res.status === 401 && path.startsWith('/api/owner/')) onUnauthorized();
    throw new ApiError(res.status, code, message);
  }
  return res;
}

export async function api<T = any>(path: string, init: Init = {}): Promise<T> {
  const res = await request(path.startsWith('/api/') ? path : `/api/owner${path}`, init);
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

/** Reads every page of a search listing (pages of 100, at most 20 pages). */
export async function searchAll<T = any>(path: string): Promise<{ results: T[] }> {
  const results: T[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 20; page++) {
    const r: { results: T[]; next_cursor: string | null } = await api(`${path}${path.includes('?') ? '&' : '?'}limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    results.push(...r.results);
    cursor = r.next_cursor;
    if (!cursor) break;
  }
  return { results };
}

export const post = <T = any>(path: string, json: unknown = {}) => api<T>(path, { method: 'POST', json });
export const del = <T = any>(path: string) => api<T>(path, { method: 'DELETE' });

let unauthorizedHandler = () => {};
export function setUnauthorizedHandler(fn: () => void): void {
  unauthorizedHandler = fn;
}
function onUnauthorized() {
  unauthorizedHandler();
}

export const enc = encodeURIComponent;
