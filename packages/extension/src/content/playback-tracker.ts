import type { PlaybackTimeline } from './playback-timeline.js';

export interface PlaybackTrackerEvents {
  /** A jump of more than `seekThresholdSec` in the video. */
  onSeek: (toVideoTime: number, fromVideoTime: number | null) => void;
  /** Any play/pause/rate change (after the timeline was updated). */
  onStateChange?: () => void;
}

const EVENTS = ['play', 'playing', 'pause', 'seeking', 'seeked', 'ratechange', 'ended', 'timeupdate', 'durationchange'] as const;

/**
 * Follows one <video> element, feeds the PlaybackTimeline with samples and
 * turns `seeking/seeked` pairs into seek events. Re-attach when the player
 * swaps its video element (SPA navigation, mini-player, ads).
 */
export class PlaybackTracker {
  private _video: HTMLVideoElement | null = null;
  private seekFrom: number | null = null;
  private readonly handlers = new Map<string, () => void>();
  private lastTimeupdateWall = 0;

  constructor(
    private readonly timeline: PlaybackTimeline,
    private readonly events: PlaybackTrackerEvents,
    private readonly now: () => number = () => Date.now(),
    private readonly seekThresholdSec = 2,
  ) {}

  get video(): HTMLVideoElement | null {
    return this._video;
  }

  attach(video: HTMLVideoElement): void {
    if (this._video === video) return;
    this.detach();
    this._video = video;
    for (const name of EVENTS) {
      const handler = () => this.handle(name);
      this.handlers.set(name, handler);
      video.addEventListener(name, handler);
    }
    this.sample();
  }

  detach(): void {
    if (this._video === null) return;
    for (const [name, handler] of this.handlers) this._video.removeEventListener(name, handler);
    this.handlers.clear();
    this._video = null;
    this.seekFrom = null;
  }

  currentTime(): number | null {
    return this._video?.currentTime ?? null;
  }

  get paused(): boolean {
    return this._video?.paused ?? true;
  }

  /** Record the current position (call periodically as a safety net). */
  sample(): void {
    const v = this._video;
    if (v === null) return;
    this.timeline.record({ wall: this.now(), videoTime: v.currentTime, playing: !v.paused && !v.ended, playbackRate: v.playbackRate || 1 });
  }

  private handle(name: (typeof EVENTS)[number]): void {
    const v = this._video;
    if (v === null) return;
    switch (name) {
      case 'seeking':
        // Keep the position we are leaving from (first `seeking` of a drag).
        if (this.seekFrom === null) this.seekFrom = this.timeline.videoTimeAt(this.now()) ?? v.currentTime;
        return;
      case 'seeked': {
        const from = this.seekFrom;
        this.seekFrom = null;
        const to = v.currentTime;
        this.sample();
        if (from === null || Math.abs(to - from) >= this.seekThresholdSec) {
          this.timeline.markSeek(this.now());
          this.events.onSeek(to, from);
        }
        return;
      }
      case 'timeupdate': {
        // ~4 Hz while playing; throttle to 1 Hz to keep the timeline small.
        const wall = this.now();
        if (wall - this.lastTimeupdateWall < 1000) return;
        this.lastTimeupdateWall = wall;
        this.sample();
        return;
      }
      default:
        this.sample();
        this.events.onStateChange?.();
    }
  }
}
