import type { TranscriptMessage } from '@lst/protocol';
import type { AsrTranscript } from '../asr/types.js';
import type { TranslationAdapter, TranslationContextItem } from './types.js';

export interface TranslationPipelineOptions {
  sessionId: string;
  targetLanguage: string;
  adapter: TranslationAdapter;
  emit: (message: TranscriptMessage) => void;
  onError: (code: 'translation_failed', message: string) => void;
  onMetrics?: (sample: { translateMs: number; status: 'partial' | 'final' }) => void;
  translatePartials?: boolean;
  /** Minimum interval between partial translations of the same segment. */
  partialIntervalMs?: number;
  /** Partials shorter than this are not translated. */
  partialMinChars?: number;
  /** Finals waiting beyond this count lose their translation (source stays visible). */
  maxBacklog?: number;
  /** Per-request timeout. */
  timeoutMs?: number;
  /** Consecutive failures before onError fires. */
  failureThreshold?: number;
  /** Number of previous finals passed as context. */
  contextSize?: number;
  now?: () => number;
}

interface SegmentState {
  outRevision: number;
  status: 'partial' | 'final';
  text: string;
  startMs: number;
  endMs?: number;
  language?: string;
  lastPartialTranslateAt: number;
  translatedText?: string;
}

interface Job {
  segmentId: string;
  status: 'partial' | 'final';
  text: string;
}

/**
 * Sits between the ASR and the wire. Every ASR transcript is forwarded at
 * once (source only) with pipeline-owned revisions; translations arrive
 * later as a higher revision of the same segment. One translation runs at a
 * time; finals are queued, partials are throttled and replaced by newer
 * ones; a final always supersedes a pending partial of its segment.
 */
export class TranslationPipeline {
  private readonly o: Required<Omit<TranslationPipelineOptions, 'onMetrics'>> & { onMetrics: NonNullable<TranslationPipelineOptions['onMetrics']> };
  private readonly segments = new Map<string, SegmentState>();
  private readonly finalQueue: Job[] = [];
  private pendingPartial: Job | null = null;
  private inFlight: { job: Job; abort: AbortController } | null = null;
  private readonly history: TranslationContextItem[] = [];
  private consecutiveFailures = 0;
  private _translated = 0;
  private stopped = false;
  private failed = false;

  constructor(options: TranslationPipelineOptions) {
    this.o = {
      translatePartials: false,
      partialIntervalMs: 2000,
      partialMinChars: 12,
      maxBacklog: 3,
      timeoutMs: 15000,
      failureThreshold: 3,
      contextSize: 2,
      now: () => Date.now(),
      onMetrics: () => {},
      ...options,
    };
  }

  get backlog(): number {
    return this.finalQueue.length + (this.inFlight?.job.status === 'final' ? 1 : 0);
  }

  get translated(): number {
    return this._translated;
  }

  /** ASR transcript in → forwarded immediately; translation scheduled. */
  onTranscript(t: AsrTranscript): void {
    if (this.stopped) return;
    let seg = this.segments.get(t.segmentId);
    if (seg === undefined) {
      seg = { outRevision: 0, status: t.status, text: t.text, startMs: t.startMs, lastPartialTranslateAt: -Infinity };
      this.segments.set(t.segmentId, seg);
      this.trimSegments();
    } else {
      // A final is terminal for source text; ignore anything after it.
      if (seg.status === 'final' && t.status !== 'final') return;
      seg.outRevision += 1;
      seg.status = t.status;
      seg.text = t.text;
      seg.startMs = t.startMs;
      delete seg.translatedText;
    }
    if (t.endMs !== undefined) seg.endMs = t.endMs;
    if (t.language !== undefined) seg.language = t.language;
    this.emit(t.segmentId, seg);

    if (this.failed) return;
    if (t.status === 'final') {
      // A final supersedes any pending or in-flight partial of the same segment.
      if (this.pendingPartial?.segmentId === t.segmentId) this.pendingPartial = null;
      if (this.inFlight?.job.segmentId === t.segmentId && this.inFlight.job.status === 'partial') this.inFlight.abort.abort();
      this.finalQueue.push({ segmentId: t.segmentId, status: 'final', text: t.text });
      while (this.finalQueue.length > this.o.maxBacklog) this.finalQueue.shift(); // oldest lose their translation
    } else if (this.o.translatePartials && t.text.length >= this.o.partialMinChars) {
      if (this.o.now() - seg.lastPartialTranslateAt >= this.o.partialIntervalMs) {
        this.pendingPartial = { segmentId: t.segmentId, status: 'partial', text: t.text };
      }
    }
    this.pump();
  }

  /** Stop scheduling; abort in-flight work. */
  stop(): void {
    this.stopped = true;
    this.finalQueue.length = 0;
    this.pendingPartial = null;
    this.inFlight?.abort.abort();
  }

  private pump(): void {
    if (this.inFlight !== null || this.stopped || this.failed) return;
    const job = this.finalQueue.shift() ?? this.takePartial();
    if (job === undefined) return;
    const seg = this.segments.get(job.segmentId);
    if (seg === undefined || seg.text !== job.text) {
      // Segment moved on (newer text) — for partials just drop; for finals translate current text.
      if (job.status === 'partial' || seg === undefined) return this.pump();
      job.text = seg.text;
    }
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.o.timeoutMs);
    this.inFlight = { job, abort };
    const t0 = this.o.now();
    if (job.status === 'partial') seg.lastPartialTranslateAt = t0;
    this.o.adapter
      .translate({
        text: job.text,
        sourceLanguage: seg.language ?? 'auto',
        targetLanguage: this.o.targetLanguage,
        context: this.history.slice(-this.o.contextSize),
        signal: abort.signal,
      })
      .then(
        (translated) => this.onTranslated(job, translated, this.o.now() - t0),
        (err: unknown) => this.onFailed(job, err, abort.signal.aborted),
      )
      .finally(() => {
        clearTimeout(timer);
        this.inFlight = null;
        this.pump();
      });
  }

  private takePartial(): Job | undefined {
    const job = this.pendingPartial ?? undefined;
    this.pendingPartial = null;
    return job;
  }

  private onTranslated(job: Job, translated: string, translateMs: number): void {
    this.consecutiveFailures = 0;
    const seg = this.segments.get(job.segmentId);
    if (seg === undefined || this.stopped) return;
    const text = translated.trim();
    // Stale: the segment's source text changed while we were translating.
    if (seg.text !== job.text) return;
    if (text.length === 0) return;
    seg.translatedText = text;
    seg.outRevision += 1;
    this._translated += 1;
    this.o.onMetrics({ translateMs, status: job.status });
    this.emit(job.segmentId, seg);
    if (job.status === 'final') {
      this.history.push({ source: job.text, translated: text });
      while (this.history.length > 8) this.history.shift();
    }
  }

  private onFailed(job: Job, err: unknown, aborted: boolean): void {
    if (this.stopped) return;
    if (aborted && this.segments.get(job.segmentId)?.text !== job.text) return; // superseded, not a failure
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.o.failureThreshold) {
      this.failed = true;
      this.finalQueue.length = 0;
      this.pendingPartial = null;
      const reason = aborted ? `timed out after ${this.o.timeoutMs} ms` : err instanceof Error ? err.message : String(err);
      this.o.onError('translation_failed', `translation failed ${this.consecutiveFailures} times in a row (${reason}); continuing with source text only`);
    }
  }

  private emit(segmentId: string, seg: SegmentState): void {
    const message: TranscriptMessage = {
      type: 'transcript',
      sessionId: this.o.sessionId,
      segmentId,
      revision: seg.outRevision,
      status: seg.status,
      startMs: seg.startMs,
      sourceText: seg.text,
    };
    if (seg.endMs !== undefined) message.endMs = seg.endMs;
    if (seg.translatedText !== undefined) message.translatedText = seg.translatedText;
    this.o.emit(message);
  }

  private trimSegments(): void {
    if (this.segments.size <= 50) return;
    const oldest = this.segments.keys().next().value;
    if (oldest !== undefined) this.segments.delete(oldest);
  }
}
