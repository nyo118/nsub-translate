import type { AsrInfo, SessionMetricsMessage, TranscriptMessage, TranslationInfo } from '@lst/protocol';
import type { Platform } from './platform.js';

/**
 * Messages exchanged *inside* the extension (popup / service worker /
 * offscreen document / content script). Every message carries a `target`
 * because `chrome.runtime.sendMessage` is broadcast to every extension
 * context; each context ignores messages not addressed to it.
 */

export type SessionStatus = 'idle' | 'starting' | 'active' | 'stopping';

export interface SessionSnapshot {
  status: SessionStatus;
  sessionId?: string;
  tabId?: number;
  platform?: Platform;
  backendUrl: string;
  startedAt?: number;
  /** Languages the active session was started with (settings changes apply on next start). */
  sourceLanguage?: string;
  targetLanguage?: string;
  lastError?: string;
  /** 0..1 RMS audio level from the offscreen analyser; undefined when not capturing. */
  audioLevel?: number;
  transcriptCount: number;
  /** Recognizer in use for the active session. */
  asr?: AsrInfo;
  /** Translator in use for the active session. */
  translation?: TranslationInfo;
  translatePartials?: boolean;
  /** Latest latency statistics from the backend. */
  metrics?: SessionMetricsMessage;
  /** Backend connection state while active: connected, or reconnecting after a drop. */
  connection?: 'connected' | 'reconnecting';
}

// ---- Popup -> Background --------------------------------------------------
/**
 * The popup runs in the context where the user invoked the extension, so it
 * obtains the tabCapture stream id itself and hands it to the worker. When
 * absent, the worker tries to obtain one (fallback path).
 */
export interface PopupCapture {
  tabId: number;
  streamId: string;
}

export type PopupToBackground =
  | { target: 'background'; type: 'popup.getStatus' }
  | { target: 'background'; type: 'popup.start'; capture?: PopupCapture }
  | { target: 'background'; type: 'popup.stop' };

// ---- Content -> Background ------------------------------------------------
export type ContentToBackground = { target: 'background'; type: 'content.hello'; platform: Platform | null; playerFound: boolean };

// ---- Offscreen -> Background ----------------------------------------------
export type OffscreenToBackground =
  | { target: 'background'; type: 'offscreen.transcript'; transcript: TranscriptMessage }
  | { target: 'background'; type: 'offscreen.level'; level: number }
  | { target: 'background'; type: 'offscreen.metrics'; metrics: SessionMetricsMessage }
  /** Wall-clock time (Date.now()) corresponding to audio-clock 0 of the backend session. */
  | { target: 'background'; type: 'offscreen.audioOrigin'; sessionId: string; audioOriginWall: number }
  | { target: 'background'; type: 'offscreen.reconnecting'; attempt: number }
  | { target: 'background'; type: 'offscreen.reconnected'; sessionId: string; asr: AsrInfo; translation: TranslationInfo }
  | { target: 'background'; type: 'offscreen.disconnected'; reason: string };

export type ToBackground = PopupToBackground | ContentToBackground | OffscreenToBackground;

// ---- Background -> Offscreen ----------------------------------------------
export interface OffscreenStartRequest {
  target: 'offscreen';
  type: 'offscreen.start';
  streamId: string;
  backendUrl: string;
  sourceLanguage: string;
  targetLanguage: string;
  translatePartials: boolean;
  translationProvider: string;
}
export interface OffscreenStopRequest {
  target: 'offscreen';
  type: 'offscreen.stop';
}
export interface OffscreenPingRequest {
  target: 'offscreen';
  type: 'offscreen.ping';
}
export type ToOffscreen = OffscreenStartRequest | OffscreenStopRequest | OffscreenPingRequest;

export interface ReleasedResources {
  tracksStopped: number;
  audioContextState: string;
  webSocketState: string;
}
export type OffscreenStartResponse = { ok: true; sessionId: string; asr: AsrInfo; translation: TranslationInfo } | { ok: false; error: string };
export type OffscreenStopResponse = { ok: true; released: ReleasedResources };
export type OffscreenPingResponse = { ok: true; capturing: boolean; sessionId: string | null };

// ---- Background -> Content (chrome.tabs.sendMessage) ----------------------
export type ToContent =
  | { target: 'content'; type: 'content.sessionStarted'; sessionId: string; audioOriginWall?: number }
  | { target: 'content'; type: 'content.audioOrigin'; sessionId: string; audioOriginWall: number }
  | { target: 'content'; type: 'content.transcript'; transcript: TranscriptMessage }
  | { target: 'content'; type: 'content.sessionStopped' }
  | { target: 'content'; type: 'content.detect' };

export interface ContentDetectResponse {
  platform: Platform | null;
  playerFound: boolean;
  overlayMounted: boolean;
}

export interface ContentHelloResponse {
  active: boolean;
  sessionId?: string;
  audioOriginWall?: number;
}

export type OkResponse = { ok: true } | { ok: false; error: string };

export function isTargeted<T extends { target: string }>(message: unknown, target: T['target']): message is T {
  return typeof message === 'object' && message !== null && (message as { target?: unknown }).target === target;
}
