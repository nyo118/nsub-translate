import type { TranscriptMessage } from '@lst/protocol';

export interface SubtitleSegment {
  segmentId: string;
  revision: number;
  status: 'partial' | 'final';
  startMs: number;
  endMs?: number;
  sourceText: string;
  translatedText?: string;
  speaker?: string;
  overlap?: boolean;
}

export interface SubtitleLine {
  sourceText: string;
  translatedText: string | undefined;
  status: 'partial' | 'final';
  /** Speaker label ("A", "B", …) when the backend diarizes. */
  speaker?: string;
  /** Several people spoke at once (sourceText may be a placeholder notice). */
  overlap?: boolean;
}

/**
 * Pure subtitle state. Applies the protocol's ordering rules:
 *  - a segmentId is stable across revisions;
 *  - revisions must increase; older or equal revisions are dropped;
 *  - once a segment is `final`, a non-final event can never replace it.
 */
export class SubtitleStore {
  private readonly segments = new Map<string, SubtitleSegment>();
  private readonly order: string[] = [];
  private readonly maxSegments: number;
  private readonly visibleCount: number;

  constructor(options: { maxSegments?: number; visibleCount?: number } = {}) {
    this.maxSegments = options.maxSegments ?? 50;
    this.visibleCount = options.visibleCount ?? 2;
  }

  /** Returns true when the visible state changed. */
  apply(t: TranscriptMessage): boolean {
    const existing = this.segments.get(t.segmentId);
    let sourceText = t.sourceText;
    if (existing !== undefined) {
      if (t.revision <= existing.revision) return false;
      if (existing.status === 'final' && t.status !== 'final') return false;
      // Stable partials: a partial that merely got shorter (model backtracking on the
      // same prefix) keeps the longer text so the line never shrinks then regrows.
      if (t.status === 'partial' && existing.status === 'partial' && sourceText.length < existing.sourceText.length && existing.sourceText.startsWith(sourceText)) {
        sourceText = existing.sourceText;
      }
    } else {
      this.order.push(t.segmentId);
      while (this.order.length > this.maxSegments) {
        const evicted = this.order.shift();
        if (evicted !== undefined) this.segments.delete(evicted);
      }
    }
    const segment: SubtitleSegment = {
      segmentId: t.segmentId,
      revision: t.revision,
      status: t.status,
      startMs: t.startMs,
      sourceText,
    };
    if (t.endMs !== undefined) segment.endMs = t.endMs;
    if (t.translatedText !== undefined) segment.translatedText = t.translatedText;
    if (t.speaker !== undefined) segment.speaker = t.speaker;
    if (t.overlap !== undefined) segment.overlap = t.overlap;
    this.segments.set(t.segmentId, segment);
    return true;
  }

  /**
   * The most recent segments, oldest first. Translations can lag several
   * seconds behind the speech; if none of the visible segments has one yet,
   * the most recent translated final (from the last `lookback` segments) is
   * kept on screen above them so the viewer always sees some translation.
   */
  visible(lookback = 5): SubtitleLine[] {
    const recent = this.order
      .slice(-this.visibleCount)
      .map((id) => this.segments.get(id))
      .filter((s): s is SubtitleSegment => s !== undefined);
    const lines = recent.map((s) => this.toLine(s));
    if (recent.some((s) => s.translatedText !== undefined)) return lines;
    const older = this.order.slice(-lookback, -this.visibleCount).reverse();
    for (const id of older) {
      const s = this.segments.get(id);
      if (s?.status === 'final' && s.translatedText !== undefined) return [this.toLine(s), ...lines];
    }
    return lines;
  }

  private toLine(s: SubtitleSegment): SubtitleLine {
    const line: SubtitleLine = { sourceText: s.sourceText, translatedText: s.translatedText, status: s.status };
    if (s.speaker !== undefined) line.speaker = s.speaker;
    if (s.overlap !== undefined) line.overlap = s.overlap;
    return line;
  }

  get size(): number {
    return this.segments.size;
  }

  clear(): void {
    this.segments.clear();
    this.order.length = 0;
  }
}
