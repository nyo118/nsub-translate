import type { OverlapMode, TranscriptStatus } from '@lst/protocol';

/** One recognition result for a speech segment (no sessionId; the Session adds it). */
export interface AsrTranscript {
  segmentId: string;
  revision: number;
  status: TranscriptStatus;
  startMs: number;
  endMs?: number;
  text: string;
  /** Language detected by the recognizer, if any (e.g. "en", "ja", "zh"). */
  language?: string;
  /** Session-stable speaker label ("A", "B", …) when diarization is on. */
  speaker?: string;
  /** Several voices overlapped in this segment. */
  overlap?: boolean;
}

export interface AsrMetricsSample {
  /** Recognizer compute time for this decode (ms). */
  decodeMs: number;
  /** Wall time between the newest audio sample used and the result being available (ms). */
  latencyMs: number;
  status: TranscriptStatus;
}

export interface AsrStartOptions {
  sessionId: string;
  /** Popup language code ("auto", "en", "ja", "zh-CN", ...). Adapters map it to what they support. */
  sourceLanguage: string;
  /** Multi-voice options (protocol v6); adapters that cannot honour them ignore them. */
  denoise?: boolean;
  diarize?: boolean;
  overlap?: OverlapMode;
}

export interface AsrAdapterEvents {
  transcript: (t: AsrTranscript) => void;
  metrics: (m: AsrMetricsSample) => void;
  error: (code: 'asr_unavailable' | 'asr_failed', message: string) => void;
}

/**
 * Streaming speech-recognition adapter. One instance per session. Audio is
 * 16 kHz mono PCM16. Implementations must never throw from pushAudio.
 */
export interface AsrAdapter {
  readonly provider: string;
  /** Resolves with what is actually active (a denoiser that failed to load reports denoise: false). */
  start(options: AsrStartOptions): Promise<{ language: string; denoise?: boolean; diarize?: boolean }>;
  pushAudio(pcm: Int16Array): void;
  /** Flush pending speech (emit remaining finals) and release resources. Idempotent. */
  stop(): Promise<void>;
  on<K extends keyof AsrAdapterEvents>(event: K, listener: AsrAdapterEvents[K]): void;
}

export interface AsrAdapterFactory {
  readonly provider: string;
  /** Called once at startup; may load models. Throws with an actionable message if unusable. */
  prepare(): Promise<void>;
  create(): AsrAdapter;
}
