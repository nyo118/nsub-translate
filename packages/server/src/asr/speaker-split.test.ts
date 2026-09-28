import { describe, expect, it } from 'vitest';
import { SpeakerRegistry, splitBySpeaker, type DiarizationSegment } from './speaker-split.js';

const RATE = 16000;
const sec = (s: number) => Math.round(s * RATE);

function pieces(d: DiarizationSegment[], totalSec: number, minPieceMs?: number) {
  return splitBySpeaker(d, sec(totalSec), { sampleRate: RATE, ...(minPieceMs === undefined ? {} : { minPieceMs }) });
}

describe('splitBySpeaker', () => {
  it('returns the whole audio as one piece when the diarizer sees nothing or one speaker', () => {
    expect(pieces([], 3)).toEqual([{ offset: 0, length: sec(3), localSpeaker: -1, overlap: false }]);
    expect(pieces([{ start: 0.4, end: 2.5, speaker: 1 }], 3)).toEqual([{ offset: 0, length: sec(3), localSpeaker: 1, overlap: false }]);
    expect(pieces([], 0)).toEqual([]);
  });

  it('cuts two sequential speakers at the boundary and gives the gap to the first', () => {
    const out = pieces(
      [
        { start: 0.5, end: 3.0, speaker: 0 },
        { start: 3.6, end: 6.0, speaker: 1 },
      ],
      6.5,
    );
    expect(out).toEqual([
      { offset: 0, length: sec(3.6), localSpeaker: 0, overlap: false },
      { offset: sec(3.6), length: sec(6.5) - sec(3.6), localSpeaker: 1, overlap: false },
    ]);
    // No audio lost.
    expect(out.reduce((n, p) => n + p.length, 0)).toBe(sec(6.5));
  });

  it('marks the region where two speakers overlap and keeps the solo parts', () => {
    const out = pieces(
      [
        { start: 0, end: 4, speaker: 0 },
        { start: 3, end: 6, speaker: 1 },
      ],
      6,
    );
    expect(out).toEqual([
      { offset: 0, length: sec(3), localSpeaker: 0, overlap: false },
      { offset: sec(3), length: sec(1), localSpeaker: -1, overlap: true },
      { offset: sec(4), length: sec(2), localSpeaker: 1, overlap: false },
    ]);
  });

  it('treats fully overlapped audio as one overlap piece', () => {
    const out = pieces(
      [
        { start: 0.1, end: 5.0, speaker: 0 },
        { start: 0.2, end: 4.9, speaker: 1 },
      ],
      5,
    );
    expect(out).toEqual([{ offset: 0, length: sec(5), localSpeaker: -1, overlap: true }]);
  });

  it('absorbs pieces shorter than minPieceMs into a neighbour (backchannel "mm-hm")', () => {
    const out = pieces(
      [
        { start: 0, end: 5, speaker: 0 },
        { start: 2.0, end: 2.2, speaker: 1 }, // 200 ms overlap: not worth a "[overlap]" line
      ],
      5,
      400,
    );
    expect(out).toEqual([{ offset: 0, length: sec(5), localSpeaker: 0, overlap: false }]);
  });

  it('keeps speaker changes with a short pause and merges repeated same-speaker runs', () => {
    const out = pieces(
      [
        { start: 0, end: 1, speaker: 0 },
        { start: 1.1, end: 2, speaker: 0 },
        { start: 2.2, end: 4, speaker: 1 },
        { start: 4.2, end: 5, speaker: 0 },
      ],
      5,
    );
    expect(out.map((p) => [p.localSpeaker, p.overlap])).toEqual([
      [0, false],
      [1, false],
      [0, false],
    ]);
    expect(out[0]!.offset).toBe(0);
    expect(out[1]!.offset).toBe(sec(2.2));
    expect(out[2]!.offset).toBe(sec(4.2));
    expect(out[2]!.offset + out[2]!.length).toBe(sec(5));
  });

  it('clamps diarizer times to the audio length', () => {
    const out = pieces(
      [
        { start: -1, end: 2, speaker: 0 },
        { start: 2, end: 99, speaker: 1 },
      ],
      3,
    );
    expect(out).toEqual([
      { offset: 0, length: sec(2), localSpeaker: 0, overlap: false },
      { offset: sec(2), length: sec(1), localSpeaker: 1, overlap: false },
    ]);
  });
});

/** Fake embeddings: unit vectors around a per-speaker axis plus small noise. */
function emb(axis: number, noise = 0.1, dim = 8): Float32Array {
  const v = new Float32Array(dim);
  v[axis] = 1;
  for (let i = 0; i < dim; i++) v[i] = (v[i] ?? 0) + (Math.sin(i * 7.1 + axis * 3.3) * noise) / 2;
  return v;
}

describe('SpeakerRegistry', () => {
  it('assigns A, B, … to distinct speakers and reuses labels for similar embeddings', () => {
    const reg = new SpeakerRegistry({ threshold: 0.6 });
    expect(reg.label(emb(0))).toBe('A');
    expect(reg.label(emb(1))).toBe('B');
    expect(reg.label(emb(0, 0.2))).toBe('A');
    expect(reg.label(emb(1, 0.2))).toBe('B');
    expect(reg.label(emb(2))).toBe('C');
    expect(reg.size).toBe(3);
  });

  it('never runs out of labels: beyond maxSpeakers the closest known speaker wins', () => {
    const reg = new SpeakerRegistry({ threshold: 0.9, maxSpeakers: 2 });
    expect(reg.label(emb(0))).toBe('A');
    expect(reg.label(emb(1))).toBe('B');
    // Orthogonal to both, but the registry is full: it picks the nearest instead of throwing.
    expect(['A', 'B']).toContain(reg.label(emb(2)));
    expect(reg.size).toBe(2);
  });

  it('adapts the running mean so a drifting voice keeps its label', () => {
    const reg = new SpeakerRegistry({ threshold: 0.7 });
    reg.label(emb(0));
    // Slowly rotate from axis 0 toward axis 1 in small steps; each step is close to the current mean.
    let label = 'A';
    for (let k = 1; k <= 10; k++) {
      const v = new Float32Array(8);
      v[0] = Math.cos((k / 10) * (Math.PI / 3));
      v[1] = Math.sin((k / 10) * (Math.PI / 3));
      label = reg.label(v);
    }
    expect(label).toBe('A');
    expect(reg.size).toBe(1);
  });
});
