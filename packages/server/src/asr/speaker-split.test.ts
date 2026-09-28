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

/** Fake embeddings: unit vector on a per-speaker axis plus deterministic noise (noise 0.6 ≈ cosine 0.75 to the clean axis). */
function emb(axis: number, noise = 0.1, dim = 8): Float32Array {
  const v = new Float32Array(dim);
  v[axis] = 1;
  for (let i = 0; i < dim; i++) v[i] = (v[i] ?? 0) + (Math.sin(i * 7.1 + axis * 3.3 + noise * 13) * noise) / 2;
  return v;
}

describe('SpeakerRegistry', () => {
  const opts = { match: 0.5, create: 0.4, weak: 0.55 };

  it('founds speakers only from long pieces and reuses letters for similar voices', () => {
    const reg = new SpeakerRegistry(opts);
    expect(reg.label(emb(0), { seconds: 3 })).toBe('A');
    expect(reg.label(emb(1), { seconds: 3 })).toBe('B');
    expect(reg.label(emb(0, 0.3), { seconds: 3 })).toBe('A');
    expect(reg.label(emb(1, 0.3), { seconds: 1 })).toBe('B');
    expect(reg.size).toBe(2);
  });

  it('a short piece never founds a speaker: it joins its best match above weak, else takes the fallback', () => {
    const reg = new SpeakerRegistry(opts);
    expect(reg.label(emb(0), { seconds: 3 })).toBe('A');
    expect(reg.label(emb(5), { seconds: 1.2 })).toBeUndefined(); // stranger, too short
    expect(reg.label(emb(5), { seconds: 1.2, fallback: 'A' })).toBe('A');
    expect(reg.size).toBe(1);
    expect(reg.label(emb(0, 0.2), { seconds: 0.8 })).toBe('A');
  });

  it('A → B → A+C keeps A as A and gives the newcomer the next letter', () => {
    const reg = new SpeakerRegistry(opts);
    expect(reg.label(emb(0), { seconds: 4 })).toBe('A');
    expect(reg.label(emb(1), { seconds: 4 })).toBe('B');
    // Overlap segment: A's solo edge is short and noisy, C speaks long enough.
    const out = reg.labelMany([
      { embedding: emb(0, 0.4), seconds: 1.0, fallback: reg.lastLabel },
      { embedding: emb(2), seconds: 2.5 },
    ]);
    expect(out).toEqual(['A', 'C']);
  });

  it('assigns one-to-one within a segment: two local speakers never share a letter', () => {
    const reg = new SpeakerRegistry(opts);
    reg.label(emb(0), { seconds: 3 });
    reg.label(emb(1), { seconds: 3 });
    const out = reg.labelMany([
      { embedding: emb(0, 0.2), seconds: 3 },
      { embedding: emb(0, 0.35), seconds: 3 }, // also looks like A, but A is taken → nearest free (B) rather than a duplicate
    ]);
    expect(new Set(out).size).toBe(2);
    expect(out[0]).toBe('A');
  });

  it('retires an unconfirmed provisional speaker after the TTL but never reuses its letter', () => {
    let now = 0;
    const reg = new SpeakerRegistry({ ...opts, provisionalTtlMs: 1000, now: () => now });
    expect(reg.label(emb(0), { seconds: 5 })).toBe('A'); // confirmed by the next piece below
    expect(reg.label(emb(0, 0.2), { seconds: 5 })).toBe('A');
    expect(reg.label(emb(1), { seconds: 2.5 })).toBe('B'); // provisional, never heard again
    expect(reg.labels().map((l) => [l.label, l.confirmed])).toEqual([['A', true], ['B', false]]);
    now = 2000;
    expect(reg.label(emb(0, 0.3), { seconds: 3 })).toBe('A');
    expect(reg.size).toBe(1);
    expect(reg.label(emb(2), { seconds: 3 })).toBe('C'); // B stays retired
  });

  it('when full, the nearest speaker wins and the overflow counter increments', () => {
    const reg = new SpeakerRegistry({ ...opts, maxSpeakers: 2 });
    reg.label(emb(0), { seconds: 3 });
    reg.label(emb(1), { seconds: 3 });
    expect(['A', 'B']).toContain(reg.label(emb(2), { seconds: 3 }));
    expect(reg.size).toBe(2);
    expect(reg.overflow).toBe(1);
  });

  it('learns only from confident matches, so a drifting voice keeps its letter without a stranger pulling it', () => {
    const reg = new SpeakerRegistry(opts);
    reg.label(emb(0), { seconds: 3 });
    let label: string | undefined = 'A';
    for (let k = 1; k <= 10; k++) {
      const v = new Float32Array(8);
      v[0] = Math.cos((k / 10) * (Math.PI / 3));
      v[1] = Math.sin((k / 10) * (Math.PI / 3));
      label = reg.label(v, { seconds: 3 });
    }
    expect(label).toBe('A');
    expect(reg.size).toBe(1);
  });
});
