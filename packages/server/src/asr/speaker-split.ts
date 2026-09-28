/**
 * Multi-voice handling (0.2.0), kept free of native code so it can be unit-tested:
 *
 *   - `splitBySpeaker` turns a diarizer's per-segment output
 *     ([{start, end, speaker}] with overlaps allowed) into a list of
 *     non-overlapping pieces: runs of a single speaker, and runs where two or
 *     more people talk at once.
 *   - `SpeakerRegistry` keeps session-stable labels ("A", "B", …) by matching
 *     speaker embeddings against a running mean per known speaker.
 *
 * The sherpa-onnx pyannote diarizer numbers speakers per call, so its ids are
 * only meaningful inside one segment; the registry is what makes "A" mean the
 * same person from one segment to the next.
 */

export interface DiarizationSegment {
  /** Seconds, relative to the audio that was diarized. */
  start: number;
  end: number;
  /** Diarizer-local speaker index. */
  speaker: number;
}

export interface RawPiece {
  /** Sample offset inside the diarized audio. */
  offset: number;
  length: number;
  /** Diarizer-local speaker index; -1 for an overlap piece. */
  localSpeaker: number;
  overlap: boolean;
}

export interface SplitOptions {
  sampleRate: number;
  /** Pieces shorter than this are merged into their neighbour (backchannels, diarizer jitter). */
  minPieceMs?: number;
}

/**
 * Cut `totalSamples` of audio into single-speaker and overlap pieces.
 *
 * Silence between speakers is attached to the preceding piece so no audio is
 * dropped and word endings are not clipped. When the diarizer sees nothing,
 * or only one speaker, the whole audio is returned as one piece.
 */
export function splitBySpeaker(diarization: DiarizationSegment[], totalSamples: number, options: SplitOptions): RawPiece[] {
  const rate = options.sampleRate;
  const minPiece = Math.round(((options.minPieceMs ?? 400) / 1000) * rate);
  const segs = diarization.filter((s) => s.end > s.start);
  if (totalSamples <= 0) return [];
  const speakers = new Set(segs.map((s) => s.speaker));
  if (speakers.size <= 1) {
    return [{ offset: 0, length: totalSamples, localSpeaker: segs[0]?.speaker ?? -1, overlap: false }];
  }

  // Sweep over speaker on/off events to get intervals with a constant set of active speakers.
  const events: Array<{ at: number; speaker: number; on: boolean }> = [];
  for (const s of segs) {
    events.push({ at: clampSample(s.start * rate, totalSamples), speaker: s.speaker, on: true });
    events.push({ at: clampSample(s.end * rate, totalSamples), speaker: s.speaker, on: false });
  }
  events.sort((a, b) => a.at - b.at || Number(a.on) - Number(b.on));
  const active = new Map<number, number>();
  const raw: RawPiece[] = [];
  let cursor = 0;
  const emit = (end: number) => {
    if (end <= cursor) return;
    const ids = [...active.entries()].filter(([, n]) => n > 0).map(([id]) => id);
    if (ids.length === 0) {
      // Silence / undetected: extend the previous piece, or start the first one as "unknown".
      const prev = raw[raw.length - 1];
      if (prev) prev.length = end - prev.offset;
      else raw.push({ offset: cursor, length: end - cursor, localSpeaker: -1, overlap: false });
    } else if (ids.length === 1) {
      raw.push({ offset: cursor, length: end - cursor, localSpeaker: ids[0]!, overlap: false });
    } else {
      raw.push({ offset: cursor, length: end - cursor, localSpeaker: -1, overlap: true });
    }
    cursor = end;
  };
  for (const e of events) {
    emit(e.at);
    active.set(e.speaker, (active.get(e.speaker) ?? 0) + (e.on ? 1 : -1));
  }
  emit(totalSamples);

  // A leading "unknown" stub (audio before the first detected speaker) belongs to whoever speaks first.
  if (raw.length > 1 && raw[0]!.localSpeaker === -1 && !raw[0]!.overlap) {
    const first = raw.shift()!;
    raw[0]!.offset = first.offset;
    raw[0]!.length += first.length;
  }
  return mergeSmallPieces(raw, minPiece);
}

/** Merge same-kind neighbours, then absorb pieces shorter than `minPiece` into a neighbour. */
function mergeSmallPieces(pieces: RawPiece[], minPiece: number): RawPiece[] {
  const merged: RawPiece[] = [];
  const same = (a: RawPiece, b: RawPiece) => a.overlap === b.overlap && a.localSpeaker === b.localSpeaker;
  const push = (p: RawPiece) => {
    const prev = merged[merged.length - 1];
    if (prev && same(prev, p)) prev.length += p.length;
    else merged.push({ ...p });
  };
  for (const p of pieces) push(p);
  // Absorb short pieces: prefer the previous neighbour (keeps time monotonic), else the next.
  let changed = true;
  while (changed && merged.length > 1) {
    changed = false;
    const idx = merged.findIndex((p) => p.length < minPiece);
    if (idx < 0) break;
    const victim = merged.splice(idx, 1)[0]!;
    const target = merged[idx - 1] ?? merged[idx]!;
    if (target === merged[idx - 1]) target.length += victim.length;
    else {
      target.offset = victim.offset;
      target.length += victim.length;
    }
    // Re-merge neighbours that became identical.
    const again = merged.splice(0, merged.length);
    for (const p of again) push(p);
    changed = true;
  }
  return merged;
}

function clampSample(x: number, max: number): number {
  return Math.max(0, Math.min(max, Math.round(x)));
}

// ---------------------------------------------------------------------------
// Session-stable speaker labels
// ---------------------------------------------------------------------------

export const SPEAKER_LABELS = ['A', 'B', 'C', 'D', 'E', 'F'] as const;

export interface SpeakerRegistryOptions {
  /** Cosine similarity needed to reuse an existing label. */
  threshold?: number;
  maxSpeakers?: number;
  /** Cap on how many embeddings feed a speaker's running mean (keeps it adaptive). */
  meanWindow?: number;
}

/**
 * Maps speaker embeddings to labels. Each known speaker keeps a running mean
 * embedding; a new embedding joins the closest speaker above `threshold`, or
 * founds a new speaker until `maxSpeakers` is reached (then the closest wins
 * whatever the similarity, so labels never run out mid-session).
 */
export class SpeakerRegistry {
  private readonly speakers: Array<{ label: string; mean: Float32Array; n: number }> = [];
  private readonly threshold: number;
  private readonly maxSpeakers: number;
  private readonly meanWindow: number;

  constructor(options: SpeakerRegistryOptions = {}) {
    this.threshold = options.threshold ?? 0.45;
    this.maxSpeakers = Math.min(SPEAKER_LABELS.length, options.maxSpeakers ?? SPEAKER_LABELS.length);
    this.meanWindow = options.meanWindow ?? 20;
  }

  get size(): number {
    return this.speakers.length;
  }

  /** Label for this embedding, learning it as a new speaker when nobody matches. */
  label(embedding: Float32Array): string {
    const v = normalize(embedding);
    let best = -1;
    let bestSim = -Infinity;
    this.speakers.forEach((s, i) => {
      const sim = dot(s.mean, v);
      if (sim > bestSim) {
        bestSim = sim;
        best = i;
      }
    });
    if (best >= 0 && (bestSim >= this.threshold || this.speakers.length >= this.maxSpeakers)) {
      const s = this.speakers[best]!;
      const n = Math.min(s.n, this.meanWindow);
      for (let i = 0; i < s.mean.length; i++) s.mean[i] = (s.mean[i]! * n + v[i]!) / (n + 1);
      s.mean = normalize(s.mean);
      s.n += 1;
      return s.label;
    }
    const label = SPEAKER_LABELS[this.speakers.length]!;
    this.speakers.push({ label, mean: v, n: 1 });
    return label;
  }
}

function normalize(v: Float32Array): Float32Array {
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i]! * v[i]!;
  norm = Math.sqrt(norm) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i]! / norm;
  return out;
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}
