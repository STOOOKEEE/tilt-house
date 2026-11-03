// Past this many tracked keys, expired windows are swept so memory stays bounded.
const SWEEP_THRESHOLD = 10_000;

/** Fixed-window counter per key, in memory (one relayer process). */
export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();
  private readonly limit: number;
  private readonly windowMs: number;

  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  /** Counts one hit for `key`; false once the key is over its limit in the current window. */
  take(key: string, now: number): boolean {
    const current = this.windows.get(key);
    if (!current || now - current.start >= this.windowMs) {
      if (this.windows.size >= SWEEP_THRESHOLD) this.sweep(now);
      this.windows.set(key, { start: now, count: 1 });
      return true;
    }
    if (current.count >= this.limit) return false;
    current.count += 1;
    return true;
  }

  private sweep(now: number): void {
    for (const [key, window] of this.windows) {
      if (now - window.start >= this.windowMs) this.windows.delete(key);
    }
  }
}
