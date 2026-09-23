import { describe, expect, it } from 'vitest';
import { ChunkAssembler, Downsampler } from './downsample.js';

function sine(rate: number, freq: number, seconds: number, phase = 0): Float32Array {
  const out = new Float32Array(Math.round(rate * seconds));
  for (let i = 0; i < out.length; i++) out[i] = Math.sin(phase + (2 * Math.PI * freq * i) / rate);
  return out;
}

describe('Downsampler', () => {
  it('produces the right number of output samples for 48k → 16k across blocks', () => {
    const d = new Downsampler(48000, 16000);
    let total = 0;
    for (let i = 0; i < 10; i++) total += d.process(new Float32Array(128)).length;
    // 1280 input samples → ~426–427 output samples (3:1), regardless of block boundaries.
    expect(total).toBeGreaterThanOrEqual(425);
    expect(total).toBeLessThanOrEqual(427);
  });

  it('preserves a low-frequency tone (amplitude and period) through 48k → 16k', () => {
    const d = new Downsampler(48000, 16000);
    const out = d.process(sine(48000, 440, 0.5));
    const tail = Array.from(out.slice(4000)); // skip filter warm-up
    const peak = Math.max(...tail.map(Math.abs)) / 32767;
    expect(peak).toBeGreaterThan(0.8);
    // Zero crossings ≈ 2 × 440 × duration of the tail
    let crossings = 0;
    for (let i = 1; i < tail.length; i++) if ((tail[i - 1]! < 0) !== (tail[i]! < 0)) crossings++;
    const seconds = tail.length / 16000;
    expect(Math.abs(crossings / seconds - 880)).toBeLessThan(40);
  });

  it('is a near pass-through at equal rates and clamps to int16', () => {
    const d = new Downsampler(16000, 16000);
    const out = d.process(new Float32Array([0, 0.5, 2, -2]));
    expect(out.length).toBe(3); // needs one sample of lookahead
    const d2 = new Downsampler(16000, 16000);
    const big = d2.process(new Float32Array(100).fill(5));
    expect(Math.max(...Array.from(big))).toBe(32767);
    const d3 = new Downsampler(16000, 16000);
    const neg = d3.process(new Float32Array(100).fill(-5));
    expect(Math.min(...Array.from(neg))).toBe(-32768);
  });

  it('mixes channels to mono', () => {
    const mono = Downsampler.mixToMono([new Float32Array([1, 0.5]), new Float32Array([0, 0.5])]);
    expect(Array.from(mono)).toEqual([0.5, 0.5]);
    expect(Downsampler.mixToMono([]).length).toBe(0);
  });
});

describe('ChunkAssembler', () => {
  it('emits fixed-size chunks across arbitrary input sizes and flushes the remainder', () => {
    const chunks: number[] = [];
    const a = new ChunkAssembler(4);
    a.push(new Int16Array([1, 2, 3]), (c) => chunks.push(c.length));
    a.push(new Int16Array([4, 5, 6, 7, 8, 9]), (c) => chunks.push(c.length));
    expect(chunks).toEqual([4, 4]);
    a.flush((c) => chunks.push(c.length));
    expect(chunks).toEqual([4, 4, 4]);
    a.flush((c) => chunks.push(c.length));
    expect(chunks).toHaveLength(3);
  });
  it('emits chunk contents in order', () => {
    const seen: number[][] = [];
    const a = new ChunkAssembler(2);
    a.push(new Int16Array([1, 2, 3, 4, 5]), (c) => seen.push(Array.from(c)));
    expect(seen).toEqual([[1, 2], [3, 4]]);
  });
});
