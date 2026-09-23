/**
 * Live Subtitle Translator — extension <-> local backend control protocol.
 *
 * Protocol version 1 (Phase 0). Any change to message shapes must bump
 * PROTOCOL_VERSION and be documented in ARCHITECTURE.md.
 */

export const PROTOCOL_VERSION = 2 as const;

/**
 * v2 (Phase 2): audio is streamed from the extension to the backend as raw
 * PCM in *binary* WebSocket frames; `session.start` declares the format;
 * `session.ready` reports the ASR provider; `session.metrics` carries
 * latency statistics. Control messages stay JSON text frames.
 */
export interface AudioFormat {
  encoding: 'pcm_s16le';
  sampleRate: 16000;
  channels: 1;
}

export const AUDIO_FORMAT: AudioFormat = { encoding: 'pcm_s16le', sampleRate: 16000, channels: 1 };

/** Maximum size of one binary audio frame (bytes). 64 KB = 2 s of 16 kHz PCM16. */
export const MAX_AUDIO_FRAME_BYTES = 64 * 1024;
export type ProtocolVersion = typeof PROTOCOL_VERSION;

export type TranscriptStatus = 'partial' | 'final';

// ---------------------------------------------------------------------------
// Client -> Server
// ---------------------------------------------------------------------------

export interface SessionStartMessage {
  type: 'session.start';
  protocolVersion: ProtocolVersion;
  sourceLanguage: string;
  targetLanguage: string;
  audio: AudioFormat;
}

export interface SessionStopMessage {
  type: 'session.stop';
  sessionId: string;
}

export interface SessionPingMessage {
  type: 'session.ping';
  sessionId: string;
}

export type ClientMessage = SessionStartMessage | SessionStopMessage | SessionPingMessage;

// ---------------------------------------------------------------------------
// Server -> Client
// ---------------------------------------------------------------------------

export interface AsrInfo {
  /** e.g. "sensevoice", "mock" */
  provider: string;
  /** Language actually used by the recognizer ("auto" = in-model detection). */
  language: string;
}

export interface SessionReadyMessage {
  type: 'session.ready';
  sessionId: string;
  asr: AsrInfo;
}

export interface SessionMetricsMessage {
  type: 'session.metrics';
  sessionId: string;
  /** Seconds of audio received so far. */
  audioSeconds: number;
  partials: number;
  finals: number;
  /** Mean recognizer decode time over the last window (ms). */
  avgDecodeMs: number;
  /** Mean time from the last audio sample of a segment arriving to its transcript being emitted (ms). */
  avgLatencyMs: number;
}

export interface TranscriptMessage {
  type: 'transcript';
  sessionId: string;
  /** Stable across revisions of the same subtitle segment. */
  segmentId: string;
  /** Monotonically increasing per segment. Receivers must drop older revisions. */
  revision: number;
  status: TranscriptStatus;
  startMs: number;
  endMs?: number;
  sourceText: string;
  translatedText?: string;
}

export interface SessionPongMessage {
  type: 'session.pong';
  sessionId: string;
}

export interface SessionStoppedMessage {
  type: 'session.stopped';
  sessionId: string;
}

export interface SessionErrorMessage {
  type: 'session.error';
  /** Machine-readable code. Known server codes are listed in SessionErrorCode. */
  code: string;
  /** Human-readable. Must never contain API keys or raw audio. */
  message: string;
}

export type SessionErrorCode =
  | 'invalid_message'
  | 'invalid_audio'
  | 'unsupported_protocol_version'
  | 'unsupported_audio_format'
  | 'session_not_found'
  | 'session_already_started'
  | 'asr_unavailable'
  | 'asr_failed'
  | 'internal_error';

export type ServerMessage =
  | SessionReadyMessage
  | TranscriptMessage
  | SessionMetricsMessage
  | SessionPongMessage
  | SessionStoppedMessage
  | SessionErrorMessage;

export * from './validate.js';
