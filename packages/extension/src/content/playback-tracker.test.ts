// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { PlaybackTracker } from './playback-tracker.js';
import { PlaybackTimeline } from './playback-timeline.js';

/** happy-dom's <video> has no media engine; back the media properties with plain fields. */
function makeVideo(): HTMLVideoElement & { set(t: number, paused?: boolean): void } {
  const v = document.createElement('video') as HTMLVideoElement & { set(t: number, paused?: boolean): void };
  let time = 0;
  let paused = true;
  Object.defineProperty(v, 'currentTime', { get: () => time, set: (t: number) => (time = t) });
  Object.defineProperty(v, 'paused', { get: () => paused });
  Object.defineProperty(v, 'ended', { get: () => false });
  Object.defineProperty(v, 'playbackRate', { get: () => 1 });
  v.set = (t, p = paused) => {
    time = t;
    paused = p;
  };
  return v;
}

describe('PlaybackTracker', () => {
  it('records samples on play/pause and reports seeks beyond the threshold', () => {
    let wall = 1000;
    const timeline = new PlaybackTimeline();
    const seeks: Array<[number, number | null]> = [];
    const tracker = new PlaybackTracker(timeline, { onSeek: (to, from) => seeks.push([to, from]) }, () => wall);
    const v = makeVideo();
    tracker.attach(v);
    v.set(10, false);
    v.dispatchEvent(new Event('play'));
    wall = 3000;
    expect(timeline.videoTimeAt(3000)).toBe(12);
    // Small nudge (< 2 s) → no seek event.
    v.dispatchEvent(new Event('seeking'));
    v.set(13, false);
    v.dispatchEvent(new Event('seeked'));
    expect(seeks).toEqual([]);
    expect(timeline.lastSeekWall).toBeNull();
    // Big jump → seek event with from/to, timeline marked.
    wall = 4000;
    v.dispatchEvent(new Event('seeking'));
    v.dispatchEvent(new Event('seeking')); // drag emits several
    v.set(120, false);
    v.dispatchEvent(new Event('seeked'));
    expect(seeks).toEqual([[120, 14]]);
    expect(timeline.lastSeekWall).toBe(4000);
    expect(timeline.videoTimeAt(4500)).toBe(120.5);
    tracker.detach();
    expect(tracker.video).toBeNull();
  });

  it('holds position while paused and re-attaches to a new element cleanly', () => {
    let wall = 0;
    const timeline = new PlaybackTimeline();
    const tracker = new PlaybackTracker(timeline, { onSeek: () => {} }, () => wall);
    const a = makeVideo();
    tracker.attach(a);
    a.set(5, false);
    a.dispatchEvent(new Event('play'));
    wall = 2000;
    a.set(7, true);
    a.dispatchEvent(new Event('pause'));
    wall = 9000;
    expect(timeline.videoTimeAt(9000)).toBe(7);
    const b = makeVideo();
    b.set(100, false);
    tracker.attach(b);
    expect(tracker.video).toBe(b);
    expect(timeline.videoTimeAt(9000)).toBe(100);
    // Events on the old element are ignored after re-attach.
    a.set(999, false);
    a.dispatchEvent(new Event('play'));
    expect(timeline.videoTimeAt(9000)).toBe(100);
    expect(tracker.paused).toBe(false);
  });

  it('throttles timeupdate samples to ~1 Hz', () => {
    let wall = 0;
    const timeline = new PlaybackTimeline();
    const tracker = new PlaybackTracker(timeline, { onSeek: () => {} }, () => wall);
    const v = makeVideo();
    tracker.attach(v);
    const before = timeline.size;
    for (let i = 0; i < 8; i++) {
      wall += 250;
      v.set(i, false);
      v.dispatchEvent(new Event('timeupdate'));
    }
    expect(timeline.size - before).toBe(2);
  });
});
