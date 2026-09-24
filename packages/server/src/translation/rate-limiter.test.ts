import { describe, expect, it } from 'vitest';
import { RateLimiter } from './rate-limiter.js';

describe('RateLimiter', () => {
  it('allows a burst up to the per-minute budget, then spaces requests out', async () => {
    let now = 0;
    const sleeps: number[] = [];
    const l = new RateLimiter(6, () => now, async (ms) => { sleeps.push(ms); now += ms; });
    for (let i = 0; i < 6; i++) await l.acquire(60_000);
    expect(sleeps).toEqual([]);
    await l.acquire(60_000); // 7th: must wait one token = 10 s
    expect(sleeps).toEqual([10_000]);
    now += 30_000; // 3 tokens refill
    expect(l.waitMs()).toBe(0);
  });

  it('rejects instead of waiting longer than maxWaitMs', async () => {
    const now = 0;
    const l = new RateLimiter(2, () => now, async () => {});
    await l.acquire(1000);
    await l.acquire(1000);
    await expect(l.acquire(1000)).rejects.toThrow(/rate limited/);
  });

  it('honours a cooldown after being penalised', async () => {
    let now = 0;
    const sleeps: number[] = [];
    const l = new RateLimiter(60, () => now, async (ms) => { sleeps.push(ms); now += ms; });
    l.penalize(5000);
    expect(l.waitMs()).toBe(5000);
    await l.acquire(10_000);
    expect(sleeps).toEqual([5000]);
  });
});
