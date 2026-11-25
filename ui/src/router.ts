import { useEffect, useState } from 'preact/hooks';

/** Minimal history router: the server answers every interface path with index.html. */
const listeners = new Set<() => void>();

export function navigate(to: string, replace = false): void {
  if (to === location.pathname + location.search) return;
  if (replace) history.replaceState(null, '', to);
  else history.pushState(null, '', to);
  window.scrollTo(0, 0);
  for (const l of listeners) l();
}

export function useLocation(): { path: string; query: URLSearchParams } {
  const [, force] = useState(0);
  useEffect(() => {
    const f = () => force((n) => n + 1);
    listeners.add(f);
    window.addEventListener('popstate', f);
    return () => {
      listeners.delete(f);
      window.removeEventListener('popstate', f);
    };
  }, []);
  return { path: location.pathname, query: new URLSearchParams(location.search) };
}

/** Matches "/tasks/:id" style patterns. */
export function match(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split('/').filter(Boolean);
  const s = path.split('/').filter(Boolean);
  if (p.length !== s.length) return null;
  const out: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i]!.startsWith(':')) out[p[i]!.slice(1)] = decodeURIComponent(s[i]!);
    else if (p[i] !== s[i]) return null;
  }
  return out;
}

/** Intercepts clicks on local links so they navigate without a page load. */
export function onLinkClick(e: MouseEvent): void {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = (e.target as HTMLElement).closest('a');
  if (!a || a.target || a.hasAttribute('download')) return;
  const href = a.getAttribute('href');
  if (!href || !href.startsWith('/') || href.startsWith('//') || href.startsWith('/api/')) return;
  e.preventDefault();
  navigate(href);
}
