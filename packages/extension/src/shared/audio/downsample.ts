/**
 * Streaming mono downsampler: Float32 at any input rate → Int16 at the
 * target rate (16 kHz for ASR). Linear interpolation with a one-pole
 * low-pass pre-filter to tame aliasing; good enough for speech and cheap
 * enough for the audio thread.
 */
export class Downsampler {
  private readonly ratio: number;
  private pos = 0; // fractional read position into the "virtual" input stream
  private prev = 0; // last input sample of the previous block (for interpolation)
  private hasPrev = false;
  private lp = 0; // low-pass state
  private readonly alpha: number;

  constructor(inputRate: number, readonly outputRate: number) {
    if (inputRate <= 0 || outputRate <= 0) throw new Error('rates must be positive');
    this.ratio = inputRate / outputRate;
    // One-pole low-pass with cutoff ≈ 0.45 × output Nyquist; identity when not downsampling.
    const cutoff = Math.min(inputRate / 2, outputRate * 0.45);
    this.alpha = this.ratio <= 1 ? 1 : 1 - Math.exp((-2 * Math.PI * cutoff) / inputRate);
  }

  /** Mix any number of channels to mono in place-free fashion. */
  static mixToMono(channels: Float32Array[]): Float32Array {
    const first = channels[0];
    if (first === undefined) return new Float32Array(0);
    if (channels.length === 1) return first;
    const out = new Float32Array(first.length);
    for (const ch of channels) for (let i = 0; i < out.length; i++) out[i] = (out[i] ?? 0) + (ch[i] ?? 0);
    const g = 1 / channels.length;
    for (let i = 0; i < out.length; i++) out[i] = (out[i] ?? 0) * g;
    return out;
  }

  /** Feed one block of mono input; returns the newly produced Int16 samples (may be empty). */
  process(input: Float32Array): Int16Array {
    if (input.length === 0) return new Int16Array(0);
    // Low-pass filter into a working copy.
    const filtered = new Float32Array(input.length);
    let lp = this.lp;
    const a = this.alpha;
    for (let i = 0; i < input.length; i++) {
      lp += a * ((input[i] ?? 0) - lp);
      filtered[i] = lp;
    }
    this.lp = lp;

    // Virtual stream = [prev, ...filtered]; positions are relative to `prev` at index 0.
    const total = filtered.length + (this.hasPrev ? 1 : 0);
    const at = (i: number): number => (this.hasPrev ? (i === 0 ? this.prev : (filtered[i - 1] ?? 0)) : (filtered[i] ?? 0));
    const out: number[] = [];
    let pos = this.pos;
    while (pos + 1 < total) {
      const i = Math.floor(pos);
      const frac = pos - i;
      const s = at(i) * (1 - frac) + at(i + 1) * frac;
      out.push(Math.max(-32768, Math.min(32767, Math.round(s * 32767))));
      pos += this.ratio;
    }
    // Keep the last input sample as the new index 0 and rebase the position.
    this.prev = filtered[filtered.length - 1] ?? 0;
    this.hasPrev = true;
    this.pos = pos - (total - 1);
    return Int16Array.from(out);
  }
}

/** Accumulates Int16 samples and emits fixed-size chunks (e.g. 100 ms = 1600 samples at 16 kHz). */
export class ChunkAssembler {
  private buffer: Int16Array;
  private fill = 0;

  constructor(readonly chunkSamples: number) {
    this.buffer = new Int16Array(chunkSamples);
  }

  push(samples: Int16Array, emit: (chunk: Int16Array) => void): void {
    let offset = 0;
    while (offset < samples.length) {
      const n = Math.min(samples.length - offset, this.chunkSamples - this.fill);
      this.buffer.set(samples.subarray(offset, offset + n), this.fill);
      this.fill += n;
      offset += n;
      if (this.fill === this.chunkSamples) {
        emit(this.buffer);
        this.buffer = new Int16Array(this.chunkSamples);
        this.fill = 0;
      }
    }
  }

  /** Emit whatever is buffered (zero-padded to a full chunk if non-empty). */
  flush(emit: (chunk: Int16Array) => void): void {
    if (this.fill === 0) return;
    emit(this.buffer);
    this.buffer = new Int16Array(this.chunkSamples);
    this.fill = 0;
  }
}
