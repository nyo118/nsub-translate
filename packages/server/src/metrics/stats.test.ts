import { describe, expect, it } from 'vitest';
import { SampleSeries, mean, percentile } from './stats.js';

describe('stats', () => {
  it('computes percentiles and means', () => {
    expect(percentile([], 95)).toBe(0);
    expect(percentile([5], 95)).toBe(5);
    const v = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(v, 50)).toBe(50);
    expect(percentile(v, 95)).toBe(95);
    expect(percentile(v, 100)).toBe(100);
    expect(mean([1, 2, 3, 4])).toBe(3);
  });
  it('SampleSeries keeps lifetime mean/count and windowed percentiles', () => {
    const s = new SampleSeries(3);
    for (const v of [10, 20, 30, 40]) s.push(v);
    expect(s.count).toBe(4);
    expect(s.mean).toBe(25);
    expect(s.p(50)).toBe(30); // window is [20, 30, 40]
    expect(s.recentMean(2)).toBe(35);
    expect(s.recentP(95, 2)).toBe(40);
  });
});
