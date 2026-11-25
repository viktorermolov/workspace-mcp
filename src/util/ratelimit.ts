/** Fixed-window in-memory rate limiter keyed by client and bucket. One process, one owner: enough. */
export class RateLimiter {
  private hits = new Map<string, { start: number; n: number }>();
  private max: number;
  private windowMs: number;
  constructor(max: number, windowMs: number) {
    this.max = max;
    this.windowMs = windowMs;
  }

  /** Returns 0 when allowed, otherwise seconds until the window resets. */
  take(key: string): number {
    const t = Date.now();
    const h = this.hits.get(key);
    if (!h || t - h.start >= this.windowMs) {
      this.hits.set(key, { start: t, n: 1 });
      if (this.hits.size > 10_000) this.sweep(t);
      return 0;
    }
    h.n++;
    if (h.n <= this.max) return 0;
    return Math.ceil((h.start + this.windowMs - t) / 1000);
  }

  private sweep(t: number) {
    for (const [k, v] of this.hits) if (t - v.start >= this.windowMs) this.hits.delete(k);
  }
}
