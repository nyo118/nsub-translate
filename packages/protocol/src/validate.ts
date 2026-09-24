import {
  AUDIO_FORMAT,
  MAX_AUDIO_FRAME_BYTES,
  PROTOCOL_VERSION,
  type AsrInfo,
  type AudioFormat,
  type ClientMessage,
  type ServerMessage,
  type SessionMetricsMessage,
  type SessionOptions,
  type TranscriptMessage,
  type TranslationInfo,
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
      const audio = validateAudioFormat(value['audio']);
      if (!audio.ok) return audio;
      const message: ClientMessage = {
        type: 'session.start',
        protocolVersion: PROTOCOL_VERSION,
        sourceLanguage: value['sourceLanguage'],
        targetLanguage: value['targetLanguage'],
        audio: audio.message,
      };
      if (value['options'] !== undefined) {
        const options = validateOptions(value['options']);
        if (!options.ok) return options;
        message.options = options.message;
      }
      return { ok: true, message };
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

export function validateAudioFormat(value: unknown): ParseResult<AudioFormat> {
  if (!isRecord(value)) return { ok: false, error: 'audio format is required' };
  if (value['encoding'] !== AUDIO_FORMAT.encoding) return { ok: false, error: `audio.encoding must be ${AUDIO_FORMAT.encoding}` };
  if (value['sampleRate'] !== AUDIO_FORMAT.sampleRate) return { ok: false, error: `audio.sampleRate must be ${AUDIO_FORMAT.sampleRate}` };
  if (value['channels'] !== AUDIO_FORMAT.channels) return { ok: false, error: `audio.channels must be ${AUDIO_FORMAT.channels}` };
  return { ok: true, message: { ...AUDIO_FORMAT } };
}

/** Validate a binary audio frame and view it as PCM16 samples (copy-free). */
export function validateAudioFrame(data: unknown): ParseResult<Int16Array> {
  if (!(data instanceof Uint8Array)) return { ok: false, error: 'audio frame must be binary' };
  if (data.byteLength === 0) return { ok: false, error: 'audio frame is empty' };
  if (data.byteLength % 2 !== 0) return { ok: false, error: 'audio frame length must be even (16-bit samples)' };
  if (data.byteLength > MAX_AUDIO_FRAME_BYTES) return { ok: false, error: `audio frame exceeds ${MAX_AUDIO_FRAME_BYTES} bytes` };
  const aligned = data.byteOffset % 2 === 0 ? data : new Uint8Array(data); // Int16Array needs 2-byte alignment
  return { ok: true, message: new Int16Array(aligned.buffer, aligned.byteOffset, aligned.byteLength / 2) };
}

function validateOptions(value: unknown): ParseResult<SessionOptions> {
  if (!isRecord(value)) return { ok: false, error: 'options must be an object' };
  if (value['translatePartials'] !== undefined && typeof value['translatePartials'] !== 'boolean') {
    return { ok: false, error: 'options.translatePartials must be a boolean' };
  }
  const options: SessionOptions = { translatePartials: value['translatePartials'] === true };
  if (value['translationProvider'] !== undefined) {
    if (!isNonEmptyString(value['translationProvider']) || value['translationProvider'].length > 32) {
      return { ok: false, error: 'options.translationProvider must be a short non-empty string' };
    }
    options.translationProvider = value['translationProvider'];
  }
  return { ok: true, message: options };
}

function validateTranslationInfo(value: unknown): ParseResult<TranslationInfo> {
  if (!isRecord(value)) return { ok: false, error: 'translation info is required' };
  if (!isNonEmptyString(value['provider'])) return { ok: false, error: 'translation.provider is required' };
  if (!isNonEmptyString(value['targetLanguage'])) return { ok: false, error: 'translation.targetLanguage is required' };
  return { ok: true, message: { provider: value['provider'], targetLanguage: value['targetLanguage'] } };
}

function validateAsrInfo(value: unknown): ParseResult<AsrInfo> {
  if (!isRecord(value)) return { ok: false, error: 'asr info is required' };
  if (!isNonEmptyString(value['provider'])) return { ok: false, error: 'asr.provider is required' };
  if (!isNonEmptyString(value['language'])) return { ok: false, error: 'asr.language is required' };
  return { ok: true, message: { provider: value['provider'], language: value['language'] } };
}

function validateMetrics(value: UnknownRecord): ParseResult<SessionMetricsMessage> {
  if (!isNonEmptyString(value['sessionId'])) return { ok: false, error: 'sessionId is required' };
  for (const key of ['audioSeconds', 'partials', 'finals', 'avgDecodeMs', 'avgLatencyMs', 'translated', 'avgTranslateMs', 'translationBacklog'] as const) {
    if (!isFiniteNumber(value[key]) || value[key] < 0) return { ok: false, error: `${key} must be a number >= 0` };
  }
  return {
    ok: true,
    message: {
      type: 'session.metrics',
      sessionId: value['sessionId'],
      audioSeconds: value['audioSeconds'] as number,
      partials: value['partials'] as number,
      finals: value['finals'] as number,
      avgDecodeMs: value['avgDecodeMs'] as number,
      avgLatencyMs: value['avgLatencyMs'] as number,
      translated: value['translated'] as number,
      avgTranslateMs: value['avgTranslateMs'] as number,
      translationBacklog: value['translationBacklog'] as number,
    },
  };
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
    case 'session.ready': {
      if (!isNonEmptyString(value['sessionId'])) return { ok: false, error: 'sessionId is required' };
      const asr = validateAsrInfo(value['asr']);
      if (!asr.ok) return asr;
      const translation = validateTranslationInfo(value['translation']);
      if (!translation.ok) return translation;
      return { ok: true, message: { type: 'session.ready', sessionId: value['sessionId'], asr: asr.message, translation: translation.message } };
    }
    case 'session.pong':
    case 'session.stopped': {
      if (!isNonEmptyString(value['sessionId'])) return { ok: false, error: 'sessionId is required' };
      return { ok: true, message: { type: value['type'], sessionId: value['sessionId'] } };
    }
    case 'session.metrics':
      return validateMetrics(value);
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
