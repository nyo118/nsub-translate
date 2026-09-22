import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type ServerMessage,
  type TranscriptMessage,
} from './index.js';

/**
 * Hand-written validators. The protocol is tiny, so we avoid a schema
 * library dependency. Each validator narrows `unknown` to a message type
 * and never throws.
 */

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export type ParseResult<T> = { ok: true; message: T } | { ok: false; error: string };

/** Safely parse a raw WebSocket frame into a JSON object. */
export function parseJsonObject(raw: unknown): ParseResult<UnknownRecord> {
  let text: string;
  if (typeof raw === 'string') {
    text = raw;
  } else if (raw instanceof Uint8Array) {
    text = new TextDecoder().decode(raw);
  } else {
    return { ok: false, error: 'frame is not text' };
  }
  try {
    const value: unknown = JSON.parse(text);
    if (!isRecord(value)) return { ok: false, error: 'payload is not a JSON object' };
    return { ok: true, message: value };
  } catch {
    return { ok: false, error: 'payload is not valid JSON' };
  }
}

export function validateClientMessage(value: unknown): ParseResult<ClientMessage> {
  if (!isRecord(value)) return { ok: false, error: 'message is not an object' };
  switch (value['type']) {
    case 'session.start': {
      if (value['protocolVersion'] !== PROTOCOL_VERSION) {
        return { ok: false, error: `unsupported protocolVersion (expected ${PROTOCOL_VERSION})` };
      }
      if (!isNonEmptyString(value['sourceLanguage'])) return { ok: false, error: 'sourceLanguage is required' };
      if (!isNonEmptyString(value['targetLanguage'])) return { ok: false, error: 'targetLanguage is required' };
      return {
        ok: true,
        message: {
          type: 'session.start',
          protocolVersion: PROTOCOL_VERSION,
          sourceLanguage: value['sourceLanguage'],
          targetLanguage: value['targetLanguage'],
        },
      };
    }
    case 'session.stop':
    case 'session.ping': {
      if (!isNonEmptyString(value['sessionId'])) return { ok: false, error: 'sessionId is required' };
      return { ok: true, message: { type: value['type'], sessionId: value['sessionId'] } };
    }
    default:
      return { ok: false, error: 'unknown client message type' };
  }
}

export function validateTranscript(value: UnknownRecord): ParseResult<TranscriptMessage> {
  if (!isNonEmptyString(value['sessionId'])) return { ok: false, error: 'sessionId is required' };
  if (!isNonEmptyString(value['segmentId'])) return { ok: false, error: 'segmentId is required' };
  if (!isFiniteNumber(value['revision']) || value['revision'] < 0) return { ok: false, error: 'revision must be >= 0' };
  if (value['status'] !== 'partial' && value['status'] !== 'final') return { ok: false, error: 'status must be partial|final' };
  if (!isFiniteNumber(value['startMs']) || value['startMs'] < 0) return { ok: false, error: 'startMs must be >= 0' };
  if (value['endMs'] !== undefined && !isFiniteNumber(value['endMs'])) return { ok: false, error: 'endMs must be a number' };
  if (typeof value['sourceText'] !== 'string') return { ok: false, error: 'sourceText is required' };
  if (value['translatedText'] !== undefined && typeof value['translatedText'] !== 'string') {
    return { ok: false, error: 'translatedText must be a string' };
  }
  const message: TranscriptMessage = {
    type: 'transcript',
    sessionId: value['sessionId'],
    segmentId: value['segmentId'],
    revision: value['revision'],
    status: value['status'],
    startMs: value['startMs'],
    sourceText: value['sourceText'],
  };
  if (value['endMs'] !== undefined) message.endMs = value['endMs'];
  if (value['translatedText'] !== undefined) message.translatedText = value['translatedText'];
  return { ok: true, message };
}

export function validateServerMessage(value: unknown): ParseResult<ServerMessage> {
  if (!isRecord(value)) return { ok: false, error: 'message is not an object' };
  switch (value['type']) {
    case 'session.ready':
    case 'session.pong':
    case 'session.stopped': {
      if (!isNonEmptyString(value['sessionId'])) return { ok: false, error: 'sessionId is required' };
      return { ok: true, message: { type: value['type'], sessionId: value['sessionId'] } };
    }
    case 'transcript':
      return validateTranscript(value);
    case 'session.error': {
      if (!isNonEmptyString(value['code'])) return { ok: false, error: 'code is required' };
      if (typeof value['message'] !== 'string') return { ok: false, error: 'message is required' };
      return {
        ok: true,
        message: {
          type: 'session.error',
          code: value['code'],
          message: value['message'],
        },
      };
    }
    default:
      return { ok: false, error: 'unknown server message type' };
  }
}
