import { parentPort, workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';
import path from 'node:path';
import { OVERLAP_PLACEHOLDER, type OverlapMode } from '@lst/protocol';
import { Segmenter, type Recognizer, type SegmentSplitter, type SplitPiece, type VadSegment, type VoiceActivityDetector } from './segmenter.js';
import { normalizeDetectedLanguage, type SenseVoiceLanguage } from './languages.js';
import type { WorkerInbound, WorkerOutbound } from './sherpa-messages.js';
import { SpeakerRegistry, splitBySpeaker, type DiarizationSegment } from './speaker-split.js';

/**
 * Worker thread that owns the native sherpa-onnx objects. Recognition is
 * synchronous and CPU-heavy, so it must not run on the server's main thread.
 * One worker serves one session at a time (personal-use tool).
 */

interface WorkerInit {
  modelDir: string;
  vadModel: string;
  /** Optional models (may not exist on disk until the feature is first used). */
  denoiserModel: string;
  segmentationModel: string;
  embeddingModel: string;
  numThreads: number;
}

const init = workerData as WorkerInit;
const require = createRequire(import.meta.url);
const sherpa = require('sherpa-onnx-node');

/** Queue lag (ms) above which partial decodes are paused, and below which they resume. */
const BACKLOG_PAUSE_MS = 700;
const BACKLOG_RESUME_MS = 250;

const SAMPLE_RATE = 16000;
const recognizers = new Map<SenseVoiceLanguage, Recognizer>();

/** Pieces shorter than this get no embedding of their own (too little voice to be reliable). */
const MIN_EMBED_SAMPLES = Math.round(0.5 * SAMPLE_RATE);
/** Segments shorter than this are not worth diarizing. */
const MIN_DIARIZE_SAMPLES = Math.round(1.0 * SAMPLE_RATE);

function post(message: WorkerOutbound): void {
  parentPort?.postMessage(message);
}

function getRecognizer(language: SenseVoiceLanguage): Recognizer {
  const cached = recognizers.get(language);
  if (cached) return cached;
  const native = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      senseVoice: { model: path.join(init.modelDir, 'model.int8.onnx'), useInverseTextNormalization: 1, language },
      tokens: path.join(init.modelDir, 'tokens.txt'),
      numThreads: init.numThreads,
      provider: 'cpu',
      debug: 0,
    },
  });
  const recognizer: Recognizer = {
    decode(samples) {
      const stream = native.createStream();
      stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE });
      native.decode(stream);
      const r = native.getResult(stream) as { text: string; lang?: string };
      const language = normalizeDetectedLanguage(r.lang);
      return language === undefined ? { text: r.text } : { text: r.text, language };
    },
  };
  recognizers.set(language, recognizer);
  return recognizer;
}

function createVad(): VoiceActivityDetector {
  const native = new sherpa.Vad(
    {
      sileroVad: {
        model: init.vadModel,
        threshold: 0.5,
        minSpeechDuration: 0.25,
        minSilenceDuration: 0.3,
        maxSpeechDuration: 10,
        windowSize: 512,
      },
      sampleRate: SAMPLE_RATE,
      debug: false,
      numThreads: 1,
    },
    60,
  );
  return {
    windowSize: 512,
    push: (w) => native.acceptWaveform(w),
    isSpeaking: () => native.isDetected() as boolean,
    popSegment: (): VadSegment | null => {
      if (native.isEmpty()) return null;
      const s = native.front() as { samples: Float32Array; start: number };
      native.pop();
      return { samples: s.samples, startSample: s.start };
    },
    flush: () => native.flush(),
  };
}

// ---------------------------------------------------------------------------
// Optional front-ends (0.2.0): speech denoiser, speaker diarization
// ---------------------------------------------------------------------------

interface Denoiser {
  run(samples: Float32Array): Float32Array;
  flush(): Float32Array;
}

let denoiser: Denoiser | null = null;

/** GTCRN streaming denoiser: 16 kHz in, 16 kHz out, a few ms of internal buffering. */
function getDenoiser(): Denoiser {
  if (denoiser !== null) return denoiser;
  const native = new sherpa.OnlineSpeechDenoiser({ model: { gtcrn: { model: init.denoiserModel }, numThreads: 1, provider: 'cpu', debug: 0 } });
  denoiser = {
    run: (samples) => (native.run({ samples, sampleRate: SAMPLE_RATE }) as { samples: Float32Array }).samples,
    flush: () => (native.flush() as { samples: Float32Array }).samples,
  };
  return denoiser;
}

interface Diarizer {
  process(samples: Float32Array): DiarizationSegment[];
  embed(samples: Float32Array): Float32Array;
}

let diarizer: Diarizer | null = null;

/** pyannote segmentation 3.0 (int8) + 3D-Speaker ERes2Net embeddings; both ~RTF 0.05 on a laptop CPU. */
function getDiarizer(): Diarizer {
  if (diarizer !== null) return diarizer;
  const segmentation = new sherpa.OfflineSpeakerDiarization({
    segmentation: { pyannote: { model: init.segmentationModel }, numThreads: 1, provider: 'cpu', debug: 0 },
    embedding: { model: init.embeddingModel, numThreads: 1, provider: 'cpu', debug: 0 },
    clustering: { numClusters: -1, threshold: 0.5 },
    minDurationOn: 0.2,
    minDurationOff: 0.5,
  });
  const extractor = new sherpa.SpeakerEmbeddingExtractor({ model: init.embeddingModel, numThreads: 1, provider: 'cpu', debug: 0 });
  diarizer = {
    process: (samples) => segmentation.process(samples) as DiarizationSegment[],
    embed: (samples) => {
      const stream = extractor.createStream();
      stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE });
      return extractor.compute(stream) as Float32Array;
    },
  };
  return diarizer;
}

/**
 * Segment splitter for one session: diarize the final's audio, cut it by
 * speaker, label the pieces with session-stable letters and apply the
 * overlap policy. Never throws — on any failure the segment is decoded whole.
 */
function createSpeakerSplitter(overlap: OverlapMode): SegmentSplitter {
  const d = getDiarizer();
  const registry = new SpeakerRegistry();
  return (samples) => {
    if (samples.length < MIN_DIARIZE_SAMPLES) return null;
    try {
      const raw = splitBySpeaker(d.process(samples), samples.length, { sampleRate: SAMPLE_RATE });
      const labels = new Map<number, string>(); // diarizer-local id → session label, per segment
      const pieces: SplitPiece[] = [];
      for (const p of raw) {
        if (p.overlap) {
          if (overlap === 'skip') continue;
          const piece: SplitPiece = { offset: p.offset, length: p.length, overlap: true };
          if (overlap === 'mark') piece.text = OVERLAP_PLACEHOLDER;
          pieces.push(piece);
          continue;
        }
        const piece: SplitPiece = { offset: p.offset, length: p.length };
        let label = labels.get(p.localSpeaker);
        if (label === undefined && p.length >= MIN_EMBED_SAMPLES) {
          label = registry.label(d.embed(samples.subarray(p.offset, p.offset + p.length)));
          if (p.localSpeaker >= 0) labels.set(p.localSpeaker, label);
        }
        if (label !== undefined) piece.speaker = label;
        pieces.push(piece);
      }
      return pieces;
    } catch (err) {
      console.warn('[asr] speaker split failed; decoding segment whole', err instanceof Error ? err.message : err);
      return null;
    }
  };
}

let active: { sessionId: string; segmenter: Segmenter; partialsPaused: boolean; denoise: boolean } | null = null;

function handle(message: WorkerInbound): void {
  switch (message.t) {
    case 'preload':
      getRecognizer('auto');
      post({ t: 'loaded' });
      return;
    case 'start': {
      if (active !== null) {
        post({ t: 'error', sessionId: message.sessionId, code: 'asr_failed', message: 'worker is already serving a session' });
        return;
      }
      const recognizer = getRecognizer(message.language);
      // Optional front-ends degrade gracefully: a model that fails to load
      // disables the feature (reported in `started`) instead of the session.
      let denoise = false;
      if (message.denoise) {
        try {
          getDenoiser();
          denoise = true;
        } catch (err) {
          console.warn('[asr] denoiser unavailable, continuing without it:', err instanceof Error ? err.message : err);
        }
      }
      let splitter: SegmentSplitter | undefined;
      if (message.diarize) {
        try {
          splitter = createSpeakerSplitter(message.overlap);
        } catch (err) {
          console.warn('[asr] speaker diarization unavailable, continuing without it:', err instanceof Error ? err.message : err);
        }
      }
      const segmenter = new Segmenter({
        sampleRate: SAMPLE_RATE,
        vad: createVad(),
        recognizer,
        onTranscript: (transcript) => post({ t: 'transcript', sessionId: message.sessionId, transcript }),
        onMetrics: (sample) => post({ t: 'metrics', sessionId: message.sessionId, sample }),
        ...(splitter === undefined ? {} : { splitter }),
      });
      active = { sessionId: message.sessionId, segmenter, partialsPaused: false, denoise };
      post({ t: 'started', sessionId: message.sessionId, language: message.language, denoise, diarize: splitter !== undefined });
      return;
    }
    case 'audio': {
      if (active === null || active.sessionId !== message.sessionId) return;
      // Backpressure: if this frame waited too long in the queue we are behind real time.
      const lag = Date.now() - message.sentAt;
      if (!active.partialsPaused && lag > BACKLOG_PAUSE_MS) {
        active.partialsPaused = true;
        active.segmenter.setPartialsEnabled(false);
      } else if (active.partialsPaused && lag < BACKLOG_RESUME_MS) {
        active.partialsPaused = false;
        active.segmenter.setPartialsEnabled(true);
      }
      const pcm = new Int16Array(message.pcm);
      const f32 = new Float32Array(pcm.length);
      for (let i = 0; i < pcm.length; i++) f32[i] = (pcm[i] ?? 0) / 32768;
      // The denoiser buffers a few frames internally (< 20 ms), so the sample
      // clock drifts by at most that much; nothing is dropped.
      active.segmenter.push(active.denoise ? getDenoiser().run(f32) : f32);
      return;
    }
    case 'stop': {
      if (active === null || active.sessionId !== message.sessionId) {
        post({ t: 'stopped', sessionId: message.sessionId });
        return;
      }
      const { segmenter, sessionId, denoise } = active;
      active = null;
      if (denoise) segmenter.push(getDenoiser().flush());
      segmenter.flush();
      post({ t: 'stopped', sessionId });
      return;
    }
  }
}

parentPort?.on('message', (message: WorkerInbound) => {
  try {
    handle(message);
  } catch (err) {
    post({ t: 'error', sessionId: active?.sessionId, code: 'asr_failed', message: err instanceof Error ? err.message : String(err) });
    active = null;
  }
});
