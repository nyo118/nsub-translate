import { describe, expect, it } from 'vitest';
import { Segmenter, type Recognizer, type VadSegment, type VoiceActivityDetector } from './segmenter.js';
import type { AsrTranscript } from './types.js';

const RATE = 16000;
const WIN = 512;

/** Scripted VAD: speech is "on" while the sample index is inside one of the ranges. */
class FakeVad implements VoiceActivityDetector {
  readonly windowSize = WIN;
  private fed = 0;
  private speaking = false;
  private segStart = 0;
  private buf: Float32Array[] = [];
  private queue: VadSegment[] = [];
  constructor(private readonly ranges: Array<[number, number]>) {}
  push(window: Float32Array): void {
    const idx = this.fed;
    const inSpeech = this.ranges.some(([a, b]) => idx >= a && idx < b);
    if (inSpeech && !this.speaking) {
      this.speaking = true;
      this.segStart = idx;
      this.buf = [];
    }
    if (this.speaking) this.buf.push(window.slice());
    if (!inSpeech && this.speaking) {
      this.speaking = false;
      this.queue.push({ samples: concat(this.buf), startSample: this.segStart });
    }
    this.fed += window.length;
  }
  isSpeaking() {
    return this.speaking;
  }
  popSegment() {
    return this.queue.shift() ?? null;
  }
  flush() {
    if (this.speaking) {
      this.speaking = false;
      this.queue.push({ samples: concat(this.buf), startSample: this.segStart });
    }
  }
}

function concat(parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Recognizer whose text encodes how much audio it saw, so tests can check what was decoded. */
const lengthRecognizer: Recognizer = {
  decode: (samples) => ({ text: `len=${samples.length}`, language: 'en' }),
};

function run(ranges: Array<[number, number]>, totalSamples: number, options: Partial<ConstructorParameters<typeof Segmenter>[0]> = {}) {
  const out: AsrTranscript[] = [];
  let clock = 0;
  const seg = new Segmenter({
    sampleRate: RATE,
    vad: new FakeVad(ranges),
    recognizer: lengthRecognizer,
    onTranscript: (t) => out.push(t),
    now: () => clock,
    ...options,
  });
  // Feed 100 ms chunks; advance the clock in real time.
  const chunk = 1600;
  for (let i = 0; i < totalSamples; i += chunk) {
    seg.push(new Float32Array(Math.min(chunk, totalSamples - i)));
    clock += 100;
  }
  return { out, seg, flush: () => seg.flush() };
}

describe('Segmenter', () => {
  it('emits growing partials then a final for one utterance, with stable segmentId and increasing revisions', () => {
    const speechStart = RATE * 1; // speech from 1.0 s to 3.5 s
    const speechEnd = Math.round(RATE * 3.5);
    const { out } = run([[speechStart, speechEnd]], RATE * 5);
    const partials = out.filter((t) => t.status === 'partial');
    const finals = out.filter((t) => t.status === 'final');
    expect(partials.length).toBeGreaterThanOrEqual(2);
    expect(finals).toHaveLength(1);
    expect(new Set(out.map((t) => t.segmentId)).size).toBe(1);
    out.forEach((t, i) => expect(t.revision).toBe(i));
    expect(finals[0]!.revision).toBe(out.length - 1);
    // Partials grow.
    const lens = partials.map((t) => Number(t.text.slice(4)));
    for (let i = 1; i < lens.length; i++) expect(lens[i]).toBeGreaterThan(lens[i - 1]!);
    // Final decoded exactly the VAD segment (window-granular) and carries timing.
    const finalLen = Number(finals[0]!.text.slice(4));
    expect(Math.abs(finalLen - (speechEnd - speechStart))).toBeLessThanOrEqual(2 * WIN);
    expect(finals[0]!.startMs).toBeGreaterThanOrEqual(1000);
    expect(finals[0]!.startMs).toBeLessThan(1000 + 64);
    expect(Math.abs(finals[0]!.endMs! - 3500)).toBeLessThan(64);
    expect(finals[0]!.language).toBe('en');
  });

  it('includes pre-roll audio in partials so onsets are not clipped, but not before stream start', () => {
    const { out } = run([[RATE * 2, RATE * 4]], RATE * 5, { preRollMs: 300 });
    const first = out.find((t) => t.status === 'partial')!;
    expect(first.startMs).toBeGreaterThanOrEqual(1700);
    expect(first.startMs).toBeLessThan(1700 + 64);
    const fromZero = run([[0, RATE * 2]], RATE * 3, { preRollMs: 300 });
    expect(fromZero.out[0]!.startMs).toBe(0);
  });

  it('throttles partials by interval and skips unchanged text', () => {
    let decodes = 0;
    const rec: Recognizer = { decode: () => (decodes++, { text: 'same text' }) };
    const { out } = run([[0, RATE * 3]], RATE * 3, { recognizer: rec, partialIntervalMs: 1000 });
    expect(out.filter((t) => t.status === 'partial')).toHaveLength(1); // identical text is deduped
    expect(decodes).toBeLessThanOrEqual(4); // ~3 s / 1 s interval + final
  });

  it('produces separate segments for separate utterances', () => {
    const { out } = run([[RATE * 0.5, RATE * 1.5], [RATE * 3, RATE * 4.2]], RATE * 5);
    const finals = out.filter((t) => t.status === 'final');
    expect(finals.map((t) => t.segmentId)).toEqual(['seg-0001', 'seg-0002']);
    expect(Math.abs(finals[1]!.startMs - 3000)).toBeLessThan(64);
    expect(finals[1]!.revision).toBeGreaterThanOrEqual(0);
  });

  it('flush() finalises an utterance that is still in progress', () => {
    const { out, flush } = run([[RATE * 1, RATE * 10]], RATE * 3);
    expect(out.filter((t) => t.status === 'final')).toHaveLength(0);
    flush();
    const finals = out.filter((t) => t.status === 'final');
    expect(finals).toHaveLength(1);
    expect(Math.abs(finals[0]!.endMs! - 3000)).toBeLessThan(64);
  });

  it('force-finalises very long speech at maxSegmentMs and starts a new segment', () => {
    const { out } = run([[0, RATE * 10]], RATE * 10, { maxSegmentMs: 4000 });
    const finals = out.filter((t) => t.status === 'final');
    expect(finals.length).toBeGreaterThanOrEqual(2);
    expect(finals[0]!.segmentId).not.toBe(finals[1]!.segmentId);
    expect(finals[0]!.endMs! - finals[0]!.startMs).toBeLessThanOrEqual(4100);
  });

  it('skips partials while partials are disabled (backpressure) but still emits finals', () => {
    const out: AsrTranscript[] = [];
    let clock = 0;
    const seg = new Segmenter({ sampleRate: RATE, vad: new FakeVad([[0, RATE * 3]]), recognizer: lengthRecognizer, onTranscript: (t) => out.push(t), now: () => clock });
    seg.setPartialsEnabled(false);
    for (let i = 0; i < RATE * 4; i += 1600) {
      seg.push(new Float32Array(1600));
      clock += 100;
    }
    expect(out.filter((t) => t.status === 'partial')).toHaveLength(0);
    expect(out.filter((t) => t.status === 'final')).toHaveLength(1);
    expect(seg.stats.skippedPartials).toBeGreaterThan(0);
  });

  it('drops empty recognizer output and reports metrics', () => {
    const metrics: string[] = [];
    const rec: Recognizer = { decode: (s) => ({ text: s.length > RATE * 2 ? 'hello' : '   ' }) };
    const out: AsrTranscript[] = [];
    let clock = 0;
    const seg = new Segmenter({ sampleRate: RATE, vad: new FakeVad([[0, RATE * 3]]), recognizer: rec, onTranscript: (t) => out.push(t), onMetrics: (m) => metrics.push(m.status), now: () => clock });
    for (let i = 0; i < RATE * 4; i += 1600) {
      seg.push(new Float32Array(1600));
      clock += 100;
    }
    expect(out.every((t) => t.text === 'hello')).toBe(true);
    expect(metrics).toContain('final');
  });
});
