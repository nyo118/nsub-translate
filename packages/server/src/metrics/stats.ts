/** Small numeric helpers for latency statistics. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[idx] ?? 0);
}

export function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}

/** Bounded sample store: keeps the last `cap` values for percentiles plus lifetime count/sum. */
export class SampleSeries {
  private readonly values: number[] = [];
  private _count = 0;
  private _sum = 0;
  constructor(private readonly cap = 5000) {}
  push(v: number): void {
    this._count += 1;
    this._sum += v;
    this.values.push(v);
    if (this.values.length > this.cap) this.values.shift();
  }
  get count(): number {
    return this._count;
  }
  /** Mean over the lifetime of the series. */
  get mean(): number {
    return this._count === 0 ? 0 : Math.round(this._sum / this._count);
  }
  /** Percentile over the retained window. */
  p(p: number): number {
    return percentile(this.values, p);
  }
  /** Mean over the last `n` samples. */
  recentMean(n: number): number {
    return mean(this.values.slice(-n));
  }
  recentP(p: number, n: number): number {
    return percentile(this.values.slice(-n), p);
  }
}
