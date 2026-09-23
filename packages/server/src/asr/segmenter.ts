import type { AsrMetricsSample, AsrTranscript } from './types.js';

/**
 * Turns a continuous 16 kHz float stream into partial/final transcripts.
 *
 *   audio → VAD (512-sample windows) → speech segments
 *     while speaking: every `partialIntervalMs` decode the audio since the
 *       segment began → `partial` (same segmentId, revision++)
 *     when the VAD closes the segment: decode the exact segment → `final`
 *
 * VAD and recognizer are injected so the logic is testable without native
 * code; the sherpa-onnx implementations live in sherpa-worker.ts.
 */

export interface VadSegment {
  samples: Float32Array;
  /** Index (in samples since stream start) of the first sample. */
  startSample: number;
}

export interface VoiceActivityDetector {
  readonly windowSize: number;
  push(window: Float32Array): void;
  isSpeaking(): boolean;
  popSegment(): VadSegment | null;
  /** Force-close an in-progress segment (end of stream). */
  flush(): void;
}

export interface RecognizerResult {
  text: string;
  language?: string;
}

export interface Recognizer {
  decode(samples: Float32Array): RecognizerResult;
}

export interface SegmenterOptions {
  sampleRate: number;
  vad: VoiceActivityDetector;
  recognizer: Recognizer;
  onTranscript: (t: AsrTranscript) => void;
  onMetrics?: (m: AsrMetricsSample) => void;
  /** Minimum interval between partial decodes for the same segment. */
  partialIntervalMs?: number;
  /** Do not decode partials shorter than this. */
  minPartialMs?: number;
  /** Audio kept before the VAD trigger so word onsets are not clipped. */
  preRollMs?: number;
  /** Segments longer than this are force-finalised (long monologues). */
  maxSegmentMs?: number;
  /**
   * Once a segment is this long, finalise it early at the quietest point in
   * the last `softSplitWindowMs` of audio (usually a gap between words), so
   * dense speech without real pauses still yields sentence-sized segments.
   */
  softSegmentMs?: number;
  softSplitWindowMs?: number;
  now?: () => number;
}

export class Segmenter {
  private readonly o: Required<Omit<SegmenterOptions, 'onMetrics'>> & { onMetrics: (m: AsrMetricsSample) => void };
  private pending = new Float32Array(0);
  private processed = 0; // samples fed to the VAD so far
  private readonly preRoll: Float32Array;
  private preRollFill = 0;
  private current: Float32Array[] = [];
  private currentLen = 0;
  private currentStart = 0;
  private inSpeech = false;
  private segmentSeq = 0;
  private segmentId = '';
  private revision = 0;
  private lastPartialAt = -Infinity;
  private lastPartialLen = 0;
  private lastPartialText = '';
  private lastAudioAt = 0;
  private partialsEnabled = true;
  private skippedPartials = 0;

  constructor(options: SegmenterOptions) {
    this.o = {
      partialIntervalMs: 600,
      minPartialMs: 700,
      preRollMs: 300,
      maxSegmentMs: 8000,
      softSegmentMs: 5000,
      softSplitWindowMs: 1500,
      now: () => Date.now(),
      onMetrics: () => {},
      ...options,
    };
    this.preRoll = new Float32Array(Math.round((this.o.preRollMs / 1000) * this.o.sampleRate));
  }

  get activeSegmentId(): string | null {
    return this.inSpeech ? this.segmentId : null;
  }

  /**
   * Backpressure: when audio arrives faster than we can decode (slow CPU,
   * or a burst after a stall), skip partial decodes and keep only finals so
   * the pipeline catches up instead of falling further behind.
   */
  setPartialsEnabled(enabled: boolean): void {
    this.partialsEnabled = enabled;
  }

  get stats(): { skippedPartials: number } {
    return { skippedPartials: this.skippedPartials };
  }

  push(samples: Float32Array): void {
    this.lastAudioAt = this.o.now();
    const merged = new Float32Array(this.pending.length + samples.length);
    merged.set(this.pending);
    merged.set(samples, this.pending.length);
    const w = this.o.vad.windowSize;
    let offset = 0;
    while (merged.length - offset >= w) {
      this.processWindow(merged.subarray(offset, offset + w));
      offset += w;
    }
    this.pending = merged.slice(offset);
  }

  /** End of stream: finalise whatever is in progress. */
  flush(): void {
    this.o.vad.flush();
    this.drainSegments();
    if (this.inSpeech) {
      // The VAD produced no segment (too short); finalise from our own buffer if it has content.
      this.finalizeCurrent(this.concatCurrent(), this.currentStart);
    }
    this.pending = new Float32Array(0);
  }

  private processWindow(window: Float32Array): void {
    this.o.vad.push(window);
    const speaking = this.o.vad.isSpeaking();
    if (speaking && !this.inSpeech) this.beginSegment();
    if (this.inSpeech) {
      this.current.push(window.slice());
      this.currentLen += window.length;
    }
    this.processed += window.length;
    this.pushPreRoll(window);

    this.drainSegments();

    if (this.inSpeech) {
      const durMs = (this.currentLen / this.o.sampleRate) * 1000;
      if (durMs >= this.o.maxSegmentMs) {
        this.splitCurrentAt(this.currentLen);
        return;
      }
      if (durMs >= this.o.softSegmentMs) {
        const cut = this.findQuietCut();
        if (cut !== null) {
          this.splitCurrentAt(cut);
          return;
        }
      }
      this.maybePartial(durMs);
    }
  }

  /**
   * Finalise the current segment up to `cutSamples` and continue the same
   * utterance as a new segment holding the remaining audio.
   */
  private splitCurrentAt(cutSamples: number): void {
    const all = this.concatCurrent();
    const head = all.subarray(0, cutSamples);
    const tail = all.slice(cutSamples);
    const startSample = this.currentStart;
    this.finalizeCurrent(head, startSample);
    this.beginSegment();
    // The new segment starts exactly where the cut was, carrying the tail audio.
    this.current = tail.length > 0 ? [tail] : [];
    this.currentLen = tail.length;
    this.currentStart = startSample + cutSamples;
  }

  /**
   * Quietest 100 ms window inside the last `softSplitWindowMs` (excluding the
   * final 200 ms, which is still being spoken). Returns the sample index to
   * cut at, or null if no window is clearly quieter than the segment average.
   */
  private findQuietCut(): number | null {
    const rate = this.o.sampleRate;
    const all = this.concatCurrent();
    const win = Math.round(rate * 0.1);
    const searchEnd = all.length - Math.round(rate * 0.2);
    const searchStart = Math.max(0, all.length - Math.round((this.o.softSplitWindowMs / 1000) * rate));
    if (searchEnd - searchStart < win * 2) return null;
    const rms = (from: number, to: number) => {
      let sum = 0;
      for (let i = from; i < to; i++) sum += (all[i] ?? 0) ** 2;
      return Math.sqrt(sum / Math.max(1, to - from));
    };
    const overall = rms(0, all.length);
    let best = -1;
    let bestRms = Infinity;
    for (let i = searchStart; i + win <= searchEnd; i += win / 2) {
      const r = rms(i, i + win);
      if (r < bestRms) {
        bestRms = r;
        best = i;
      }
    }
    if (best < 0 || bestRms > overall * 0.35) return null;
    return best + win / 2;
  }

  private beginSegment(): void {
    this.inSpeech = true;
    this.segmentSeq += 1;
    this.segmentId = `seg-${String(this.segmentSeq).padStart(4, '0')}`;
    this.revision = 0;
    this.lastPartialAt = -Infinity;
    this.lastPartialLen = 0;
    this.lastPartialText = '';
    const pre = this.preRoll.subarray(this.preRoll.length - this.preRollFill);
    this.current = pre.length > 0 ? [pre.slice()] : [];
    this.currentLen = pre.length;
    // `processed` does not yet include the window being processed, so it is
    // exactly the index of the first speech window.
    this.currentStart = Math.max(0, this.processed - pre.length);
  }

  private pushPreRoll(window: Float32Array): void {
    const n = this.preRoll.length;
    if (n === 0) return;
    if (window.length >= n) {
      this.preRoll.set(window.subarray(window.length - n));
      this.preRollFill = n;
      return;
    }
    this.preRoll.copyWithin(0, window.length);
    this.preRoll.set(window, n - window.length);
    this.preRollFill = Math.min(n, this.preRollFill + window.length);
  }

  private drainSegments(): void {
    for (let seg = this.o.vad.popSegment(); seg !== null; seg = this.o.vad.popSegment()) {
      if (!this.inSpeech) this.beginSegment();
      // After a soft/hard split the VAD's segment still begins at the
      // utterance's original start; only the part after our last cut is new.
      const skip = Math.max(0, this.currentStart - seg.startSample);
      if (skip >= seg.samples.length) {
        // Everything in this VAD segment was already finalised.
        this.inSpeech = false;
        this.current = [];
        this.currentLen = 0;
        continue;
      }
      this.finalizeCurrent(skip > 0 ? seg.samples.subarray(skip) : seg.samples, seg.startSample + skip);
    }
  }

  private maybePartial(durMs: number): void {
    const now = this.o.now();
    if (durMs < this.o.minPartialMs) return;
    if (now - this.lastPartialAt < this.o.partialIntervalMs) return;
    if (this.currentLen === this.lastPartialLen) return;
    if (!this.partialsEnabled) {
      this.skippedPartials += 1;
      return;
    }
    const audio = this.concatCurrent();
    this.lastPartialAt = now;
    this.lastPartialLen = this.currentLen;
    const t0 = this.o.now();
    const result = this.o.recognizer.decode(audio);
    const decodeMs = this.o.now() - t0;
    const text = result.text.trim();
    if (text.length === 0 || text === this.lastPartialText) return;
    this.lastPartialText = text;
    const transcript: AsrTranscript = {
      segmentId: this.segmentId,
      revision: this.revision++,
      status: 'partial',
      startMs: this.toMs(this.currentStart),
      text,
    };
    if (result.language !== undefined) transcript.language = result.language;
    this.o.onTranscript(transcript);
    this.o.onMetrics({ decodeMs, latencyMs: this.o.now() - this.lastAudioAt, status: 'partial' });
  }

  private finalizeCurrent(samples: Float32Array, startSample: number): void {
    const segmentId = this.segmentId;
    const startMs = this.toMs(startSample);
    const endMs = this.toMs(startSample + samples.length);
    this.inSpeech = false;
    this.current = [];
    this.currentLen = 0;
    if (samples.length === 0) return;
    const t0 = this.o.now();
    const result = this.o.recognizer.decode(samples);
    const decodeMs = this.o.now() - t0;
    const text = result.text.trim();
    if (text.length === 0) return;
    const transcript: AsrTranscript = { segmentId, revision: this.revision++, status: 'final', startMs, endMs, text };
    if (result.language !== undefined) transcript.language = result.language;
    this.o.onTranscript(transcript);
    this.o.onMetrics({ decodeMs, latencyMs: this.o.now() - this.lastAudioAt, status: 'final' });
  }

  private concatCurrent(): Float32Array {
    const out = new Float32Array(this.currentLen);
    let off = 0;
    for (const c of this.current) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  }

  private toMs(samples: number): number {
    return Math.round((samples / this.o.sampleRate) * 1000);
  }
}
