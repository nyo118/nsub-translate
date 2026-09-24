import type { SubtitleLine } from './subtitle-state.js';

/**
 * Finals already recognised (and translated) for this video, keyed by their
 * position in the video. When the viewer seeks back, the matching lines are
 * shown at once instead of waiting for recognition again. In-memory only;
 * cleared when the session stops or the page navigates.
 */
export interface CachedSegment {
  segmentId: string;
  /** Video time range in seconds. */
  startTime: number;
  endTime: number;
  sourceText: string;
  translatedText?: string;
}

export class SubtitleCache {
  private readonly segments = new Map<string, CachedSegment>();
  private readonly maxSegments: number;

  constructor(maxSegments = 2000) {
    this.maxSegments = maxSegments;
  }

  /** Insert or update (e.g. when the translation arrives later). */
  upsert(segment: CachedSegment): void {
    if (!(segment.endTime > segment.startTime)) return;
    this.segments.set(segment.segmentId, segment);
    if (this.segments.size > this.maxSegments) {
      const oldest = this.segments.keys().next().value;
      if (oldest !== undefined) this.segments.delete(oldest);
    }
  }

  /**
   * Lines to show at `videoTime`: the segment covering it (with `slack`
   * seconds of grace after its end) preceded by the previous segment, so the
   * display matches the live two-line layout.
   */
  at(videoTime: number, slack = 0.4): SubtitleLine[] {
    const sorted = [...this.segments.values()].sort((a, b) => a.startTime - b.startTime);
    const idx = sorted.findIndex((s) => videoTime >= s.startTime && videoTime <= s.endTime + slack);
    if (idx < 0) return [];
    const picked = sorted.slice(Math.max(0, idx - 1), idx + 1);
    return picked.map((s) => ({ sourceText: s.sourceText, translatedText: s.translatedText, status: 'final' as const }));
  }

  get size(): number {
    return this.segments.size;
  }

  clear(): void {
    this.segments.clear();
  }
}
