/**
 * Token bucket for cloud translation engines. `acquire()` resolves when a
 * request may be sent, or rejects if the wait would exceed `maxWaitMs`
 * (the pipeline then skips that sentence instead of piling up requests).
 * `penalize()` opens a cooldown after a 429.
 */
export class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  private cooldownUntil = 0;

  constructor(
    private readonly perMinute: number,
    private readonly now: () => number = () => Date.now(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    this.tokens = perMinute;
    this.lastRefill = now();
  }

  private refill(): void {
    const t = this.now();
    this.tokens = Math.min(this.perMinute, this.tokens + ((t - this.lastRefill) / 60_000) * this.perMinute);
    this.lastRefill = t;
  }

  /** Milliseconds until the next request may go out (0 = now). */
  waitMs(): number {
    this.refill();
    const cooldown = Math.max(0, this.cooldownUntil - this.now());
    if (this.tokens >= 1) return cooldown;
    return Math.max(cooldown, Math.ceil(((1 - this.tokens) / this.perMinute) * 60_000));
  }

  async acquire(maxWaitMs: number): Promise<void> {
    const wait = this.waitMs();
    if (wait > maxWaitMs) throw new Error(`rate limited: next request allowed in ${Math.ceil(wait / 1000)} s (limit ${this.perMinute}/min)`);
    if (wait > 0) await this.sleep(wait);
    this.refill();
    this.tokens = Math.max(0, this.tokens - 1);
  }

  /** After a 429: pause all requests for `ms`. */
  penalize(ms: number): void {
    this.cooldownUntil = Math.max(this.cooldownUntil, this.now() + ms);
  }
}
