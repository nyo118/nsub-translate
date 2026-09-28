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

/** Letters shown to the viewer; a retired provisional speaker's letter is never reused. */
export const SPEAKER_LABELS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'] as const;

export interface SpeakerRegistryOptions {
  /** Cosine similarity at which an embedding is assigned to a known speaker (calibrated EER point). */
  match?: number;
  /** A long piece founds a new speaker only when its best similarity is below this (≈ different-speaker p99). */
  create?: number;
  /** Short pieces are assigned to their best match only above this (≈ different-speaker p95). */
  weak?: number;
  /** Active speakers (confirmed + provisional) at once. */
  maxSpeakers?: number;
  /** Exemplar embeddings kept per speaker (FIFO). */
  exemplars?: number;
  /** A piece must carry at least this much speech to found a new speaker. */
  minCreateSeconds?: number;
  /** A provisional speaker is confirmed after this much speech across this many pieces … */
  confirmSeconds?: number;
  confirmPieces?: number;
  /** … otherwise it is retired after this long (its letter stays used). */
  provisionalTtlMs?: number;
  now?: () => number;
}

export interface LabelContext {
  /** Seconds of speech behind the embedding (drives create / short-piece rules). */
  seconds: number;
  /** Label to fall back to for a short piece nobody claims (same local speaker earlier in the segment, last speaker, …). */
  fallback?: string;
}

interface SpeakerEntry {
  label: string;
  centroid: Float32Array;
  exemplars: Float32Array[];
  seconds: number;
  pieces: number;
  confirmed: boolean;
  createdAt: number;
}

/**
 * Calibrated with 3D-Speaker CAM++ zh/en on 16 public speakers (8 Chinese from
 * sr-data, 8 English from LibriSpeech dev-clean) incl. music / speed / 1–4 s
 * variants: EER 7.1 % at 0.195, different-speaker p95 0.23 / p99 0.35
 * (scripts/speaker-calib.mjs, BENCHMARKS.md).
 */
export const DEFAULT_REGISTRY_THRESHOLDS = { match: 0.20, create: 0.35, weak: 0.23 } as const;

/**
 * Maps speaker embeddings to session-stable letters.
 *
 * Why the rules (0.3.0): the previous registry compared against a running
 * mean with one threshold, so a short or noisy piece could found a new
 * speaker at once — that is how "A" became "C" mid-conversation. Now:
 *  - similarity = max(centroid, best exemplar) so a speaker's natural
 *    variation (pitch, emotion, distance) is covered by several examples;
 *  - only a piece with enough speech (`minCreateSeconds`) that matches
 *    nobody (below `create`) may found a speaker, and that speaker stays
 *    provisional until confirmed by more speech;
 *  - short pieces never found anything: they join their best match above
 *    `weak`, else take the caller's fallback (turn continuity);
 *  - centroids move only on confident matches, so drift is slow.
 * `labelMany` assigns several embeddings from one segment one-to-one
 * (two local speakers can never share a letter).
 */
export class SpeakerRegistry {
  private readonly speakers: SpeakerEntry[] = [];
  private nextLabel = 0;
  private readonly o: Required<SpeakerRegistryOptions>;
  private _overflow = 0;
  private _last: string | undefined;

  constructor(options: SpeakerRegistryOptions = {}) {
    this.o = {
      match: DEFAULT_REGISTRY_THRESHOLDS.match,
      create: DEFAULT_REGISTRY_THRESHOLDS.create,
      weak: DEFAULT_REGISTRY_THRESHOLDS.weak,
      maxSpeakers: 6,
      exemplars: 8,
      minCreateSeconds: 2.0,
      confirmSeconds: 3.0,
      confirmPieces: 2,
      provisionalTtlMs: 60_000,
      now: () => Date.now(),
      ...options,
    };
    this.o.maxSpeakers = Math.min(SPEAKER_LABELS.length, this.o.maxSpeakers);
  }

  /** Active speakers (confirmed + provisional). */
  get size(): number {
    return this.speakers.length;
  }

  /** Times a piece had to be forced onto the nearest speaker because the registry was full. */
  get overflow(): number {
    return this._overflow;
  }

  /** Label assigned most recently (turn-taking prior for unlabeled short pieces). */
  get lastLabel(): string | undefined {
    return this._last;
  }

  labels(): Array<{ label: string; confirmed: boolean; seconds: number }> {
    return this.speakers.map((s) => ({ label: s.label, confirmed: s.confirmed, seconds: Math.round(s.seconds * 10) / 10 }));
  }

  label(embedding: Float32Array, ctx: LabelContext): string | undefined {
    return this.labelMany([{ embedding, ...ctx }])[0];
  }

  /**
   * Assign labels to several embeddings from the same segment, one-to-one:
   * pairs are taken best-similarity-first, each speaker at most once. Items
   * left over may found new speakers (long ones) or fall back (short ones).
   */
  labelMany(items: Array<{ embedding: Float32Array; seconds: number; fallback?: string }>): Array<string | undefined> {
    const now = this.o.now();
    this.retireStale(now);
    const vs = items.map((it) => normalize(it.embedding));
    const out: Array<string | undefined> = new Array(items.length).fill(undefined);
    const taken = new Set<number>();
    const done = new Set<number>();
    // All (item, speaker) similarities, best first.
    const pairs: Array<{ i: number; s: number; sim: number }> = [];
    vs.forEach((v, i) => this.speakers.forEach((sp, s) => pairs.push({ i, s, sim: this.similarity(sp, v) })));
    pairs.sort((a, b) => b.sim - a.sim);
    const bestSim = new Map<number, number>();
    for (const p of pairs) if (!bestSim.has(p.i)) bestSim.set(p.i, p.sim);
    for (const p of pairs) {
      if (done.has(p.i) || taken.has(p.s)) continue;
      const it = items[p.i]!;
      const short = it.seconds < this.o.minCreateSeconds;
      const accept = p.sim >= this.o.match || (short && p.sim >= this.o.weak);
      if (!accept) continue;
      const sp = this.speakers[p.s]!;
      this.absorb(sp, vs[p.i]!, it.seconds, p.sim, now);
      out[p.i] = sp.label;
      done.add(p.i);
      taken.add(p.s);
    }
    // Leftovers, longest first (the most reliable evidence founds speakers first).
    const rest = items.map((it, i) => ({ it, i })).filter(({ i }) => !done.has(i)).sort((a, b) => b.it.seconds - a.it.seconds);
    for (const { it, i } of rest) {
      const v = vs[i]!;
      const best = bestSim.get(i) ?? -Infinity;
      const long = it.seconds >= this.o.minCreateSeconds;
      // Re-rank against speakers not taken by this segment.
      const free = this.speakers.map((sp, s) => ({ s, sim: taken.has(s) ? -Infinity : this.similarity(sp, v) })).sort((a, b) => b.sim - a.sim)[0];
      if (long && best < this.o.create && this.speakers.length < this.o.maxSpeakers && this.nextLabel < SPEAKER_LABELS.length) {
        const label = SPEAKER_LABELS[this.nextLabel++]!;
        this.speakers.push({ label, centroid: v, exemplars: [v], seconds: it.seconds, pieces: 1, confirmed: false, createdAt: now });
        out[i] = label;
        taken.add(this.speakers.length - 1);
        continue;
      }
      if (free !== undefined && free.sim > -Infinity && (long || free.sim >= this.o.weak)) {
        // Long but ambiguous (between create and match), or the registry is full: nearest free speaker, no learning.
        if (this.speakers.length >= this.o.maxSpeakers && best < this.o.match) this._overflow += 1;
        out[i] = this.speakers[free.s]!.label;
        taken.add(free.s);
        continue;
      }
      out[i] = it.fallback;
    }
    for (const l of out) if (l !== undefined) this._last = l;
    return out;
  }

  private similarity(sp: SpeakerEntry, v: Float32Array): number {
    let best = dot(sp.centroid, v);
    for (const e of sp.exemplars) best = Math.max(best, dot(e, v));
    return best;
  }

  /** Learn from a confident match; count speech toward confirmation. */
  private absorb(sp: SpeakerEntry, v: Float32Array, seconds: number, sim: number, now: number): void {
    sp.seconds += seconds;
    sp.pieces += 1;
    if (!sp.confirmed && sp.seconds >= this.o.confirmSeconds && sp.pieces >= this.o.confirmPieces) sp.confirmed = true;
    if (sim < this.o.match + 0.1 || seconds < 1.0) return; // weak or tiny evidence never moves the model
    const a = 0.1;
    for (let i = 0; i < sp.centroid.length; i++) sp.centroid[i] = sp.centroid[i]! * (1 - a) + v[i]! * a;
    sp.centroid = normalize(sp.centroid);
    sp.exemplars.push(v);
    while (sp.exemplars.length > this.o.exemplars) sp.exemplars.shift();
    void now;
  }

  private retireStale(now: number): void {
    for (let i = this.speakers.length - 1; i >= 0; i--) {
      const sp = this.speakers[i]!;
      if (!sp.confirmed && now - sp.createdAt > this.o.provisionalTtlMs) this.speakers.splice(i, 1);
    }
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
