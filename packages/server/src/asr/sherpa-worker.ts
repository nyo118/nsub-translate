import { parentPort, workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Segmenter, type Recognizer, type VadSegment, type VoiceActivityDetector } from './segmenter.js';
import { normalizeDetectedLanguage, type SenseVoiceLanguage } from './languages.js';
import type { WorkerInbound, WorkerOutbound } from './sherpa-messages.js';

/**
 * Worker thread that owns the native sherpa-onnx objects. Recognition is
 * synchronous and CPU-heavy, so it must not run on the server's main thread.
 * One worker serves one session at a time (personal-use tool).
 */

interface WorkerInit {
  modelDir: string;
  vadModel: string;
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
        minSilenceDuration: 0.45,
        maxSpeechDuration: 15,
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

let active: { sessionId: string; segmenter: Segmenter; partialsPaused: boolean } | null = null;

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
      const segmenter = new Segmenter({
        sampleRate: SAMPLE_RATE,
        vad: createVad(),
        recognizer,
        onTranscript: (transcript) => post({ t: 'transcript', sessionId: message.sessionId, transcript }),
        onMetrics: (sample) => post({ t: 'metrics', sessionId: message.sessionId, sample }),
      });
      active = { sessionId: message.sessionId, segmenter, partialsPaused: false };
      post({ t: 'started', sessionId: message.sessionId, language: message.language });
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
      active.segmenter.push(f32);
      return;
    }
    case 'stop': {
      if (active === null || active.sessionId !== message.sessionId) {
        post({ t: 'stopped', sessionId: message.sessionId });
        return;
      }
      const { segmenter, sessionId } = active;
      active = null;
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
