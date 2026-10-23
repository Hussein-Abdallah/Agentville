// Limits that keep one runaway session (or anything else posting events) from flooding the service.

/** Most bytes in one event (a Write of a big file carries the whole file). */
export const MAX_EVENT_BYTES = 5 * 1024 * 1024;

/**
 * Token buckets: each session may burst `burst` events and then `perSecond` a second; all sessions
 * together `total` times that. Claude Code sends two events per tool call, a few calls a second at most.
 */
export class RateLimit {
  private buckets = new Map<string, { tokens: number; t: number }>();

  constructor(private burst = 300, private perSecond = 10, private total = 5, private now = () => Date.now()) {}

  /** Whether an event from this session may go through (and counts it). */
  take(session: string): boolean {
    const all = this.bucket('\0all', this.burst * this.total, this.perSecond * this.total);
    const one = this.bucket(session, this.burst, this.perSecond);
    if (all.tokens < 1 || one.tokens < 1) return false;
    all.tokens--; one.tokens--;
    if (this.buckets.size > 1000) this.prune();
    return true;
  }

  private bucket(key: string, cap: number, rate: number) {
    const t = this.now();
    let b = this.buckets.get(key);
    if (!b) this.buckets.set(key, (b = { tokens: cap, t }));
    b.tokens = Math.min(cap, b.tokens + ((t - b.t) / 1000) * rate);
    b.t = t;
    return b;
  }

  /** Forget sessions whose bucket is full again (quiet for a while). */
  private prune() {
    for (const [k, b] of this.buckets) if (k !== '\0all' && this.now() - b.t > (this.burst / this.perSecond) * 1000) this.buckets.delete(k);
  }
}

/** Prints a message at most once a minute per kind, so a flood doesn't flood the terminal too. */
export function warnOnce(kind: string, message: string, now = Date.now()) {
  if (now - (warned.get(kind) ?? -Infinity) < 60_000) return;
  warned.set(kind, now);
  console.warn(message);
}
const warned = new Map<string, number>();
