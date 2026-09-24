import { describe, expect, it } from 'vitest';
import { PlaybackTimeline } from './playback-timeline.js';

describe('PlaybackTimeline', () => {
  it('extrapolates video time while playing and holds it while paused', () => {
    const t = new PlaybackTimeline();
    t.record({ wall: 1000, videoTime: 10, playing: true, playbackRate: 1 });
    expect(t.videoTimeAt(1000)).toBe(10);
    expect(t.videoTimeAt(3500)).toBe(12.5);
    t.record({ wall: 4000, videoTime: 13, playing: false, playbackRate: 1 });
    expect(t.videoTimeAt(9000)).toBe(13);
    t.record({ wall: 9000, videoTime: 13, playing: true, playbackRate: 2 });
    expect(t.videoTimeAt(10000)).toBe(15);
  });

  it('returns null before the first sample and ignores out-of-order clocks', () => {
    const t = new PlaybackTimeline();
    expect(t.videoTimeAt(5)).toBeNull();
    t.record({ wall: 1000, videoTime: 0, playing: true, playbackRate: 1 });
    t.record({ wall: 500, videoTime: 99, playing: true, playbackRate: 1 });
    expect(t.size).toBe(1);
    expect(t.videoTimeAt(999)).toBeNull();
  });

  it('answers with the latest sample at or before the wall time (seek jumps included)', () => {
    const t = new PlaybackTimeline();
    t.record({ wall: 0, videoTime: 0, playing: true, playbackRate: 1 });
    t.record({ wall: 10_000, videoTime: 300, playing: true, playbackRate: 1 }); // seeked to 5:00
    expect(t.videoTimeAt(9_999)).toBeCloseTo(9.999, 3);
    expect(t.videoTimeAt(10_500)).toBeCloseTo(300.5, 3);
  });

  it('marks seeks and flags audio captured before them as stale', () => {
    const t = new PlaybackTimeline();
    expect(t.isStale(1)).toBe(false);
    t.markSeek(5000);
    expect(t.lastSeekWall).toBe(5000);
    expect(t.isStale(4999)).toBe(true);
    expect(t.isStale(5000)).toBe(false);
    t.clear();
    expect(t.lastSeekWall).toBeNull();
    expect(t.size).toBe(0);
  });

  it('caps the number of samples', () => {
    const t = new PlaybackTimeline(10);
    for (let i = 0; i < 25; i++) t.record({ wall: i * 100, videoTime: i, playing: true, playbackRate: 1 });
    expect(t.size).toBe(10);
    expect(t.videoTimeAt(1500)).toBe(15);
    expect(t.videoTimeAt(1400)).toBeNull(); // pruned
  });
});
