/**
 * Live Subtitle Translator — extension <-> local backend control protocol.
 *
 * Protocol version 1 (Phase 0). Any change to message shapes must bump
 * PROTOCOL_VERSION and be documented in ARCHITECTURE.md.
 */

export const PROTOCOL_VERSION = 1 as const;
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

export interface SessionReadyMessage {
  type: 'session.ready';
  sessionId: string;
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
  | 'unsupported_protocol_version'
  | 'session_not_found'
  | 'session_already_started'
  | 'internal_error';

export type ServerMessage =
  | SessionReadyMessage
  | TranscriptMessage
  | SessionPongMessage
  | SessionStoppedMessage
  | SessionErrorMessage;

export * from './validate.js';
