/**
 * Maps wall-clock time to video time. The backend's audio clock runs at
 * wall-clock speed (the tab is captured continuously, silence included), so
 * a transcript's `startMs/endMs` become wall times once the audio origin is
 * known, and this timeline turns those into positions in the video.
 */
export interface TimelineSample {
  /** Date.now() when the sample was taken. */
  wall: number;
  videoTime: number;
  playing: boolean;
  playbackRate: number;
}

export class PlaybackTimeline {
  private samples: TimelineSample[] = [];
  private _lastSeekWall: number | null = null;
  private readonly maxSamples: number;

  constructor(maxSamples = 4000) {
    this.maxSamples = maxSamples;
  }

  record(sample: TimelineSample): void {
    const last = this.samples[this.samples.length - 1];
    if (last !== undefined && sample.wall < last.wall) return; // ignore out-of-order clocks
    this.samples.push(sample);
    if (this.samples.length > this.maxSamples) this.samples.splice(0, this.samples.length - this.maxSamples);
  }

  /** A jump in the video: everything captured before `wall` is stale for display. */
  markSeek(wall: number): void {
    this._lastSeekWall = wall;
  }

  get lastSeekWall(): number | null {
    return this._lastSeekWall;
  }

  /** Video position at a wall time, or null before the first sample. */
  videoTimeAt(wall: number): number | null {
    let lo = 0;
    let hi = this.samples.length - 1;
    if (hi < 0 || wall < this.samples[0]!.wall) return null;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.samples[mid]!.wall <= wall) lo = mid;
      else hi = mid - 1;
    }
    const s = this.samples[lo]!;
    if (!s.playing) return s.videoTime;
    return s.videoTime + ((wall - s.wall) / 1000) * s.playbackRate;
  }

  /** True when audio captured up to `endWall` predates the last seek. */
  isStale(endWall: number): boolean {
    return this._lastSeekWall !== null && endWall < this._lastSeekWall;
  }

  clear(): void {
    this.samples = [];
    this._lastSeekWall = null;
  }

  get size(): number {
    return this.samples.length;
  }
}
