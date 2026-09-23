import { describe, expect, it } from 'vitest';
import { AUDIO_FORMAT, PROTOCOL_VERSION, parseJsonObject, validateAudioFrame, validateClientMessage, validateServerMessage } from './index.js';

const start = { type: 'session.start', protocolVersion: PROTOCOL_VERSION, sourceLanguage: 'en', targetLanguage: 'zh-CN', audio: AUDIO_FORMAT };

describe('parseJsonObject', () => {
  it('parses a JSON object from a string', () => {
    expect(parseJsonObject('{"type":"x"}')).toEqual({ ok: true, message: { type: 'x' } });
  });
  it('parses a JSON object from bytes', () => {
    const bytes = new TextEncoder().encode('{"a":1}');
    expect(parseJsonObject(bytes)).toEqual({ ok: true, message: { a: 1 } });
  });
  it('rejects invalid JSON, arrays and non-text frames', () => {
    expect(parseJsonObject('{nope').ok).toBe(false);
    expect(parseJsonObject('[1,2]').ok).toBe(false);
    expect(parseJsonObject(42).ok).toBe(false);
  });
});

describe('validateClientMessage', () => {
  it('accepts a valid session.start', () => {
    const result = validateClientMessage({ ...start, extra: 'ignored' });
    expect(result).toEqual({ ok: true, message: start });
  });
  it('accepts and normalises optional session options', () => {
    const r = validateClientMessage({ ...start, options: { translatePartials: true } });
    expect(r.ok && r.message.type === 'session.start' && r.message.options).toEqual({ translatePartials: true });
    expect(validateClientMessage({ ...start, options: {} }).ok).toBe(true);
    expect(validateClientMessage({ ...start, options: { translatePartials: 'yes' } }).ok).toBe(false);
  });
  it('requires the v2 audio format', () => {
    const { audio: _audio, ...noAudio } = start;
    expect(validateClientMessage(noAudio).ok).toBe(false);
    expect(validateClientMessage({ ...start, audio: { ...AUDIO_FORMAT, sampleRate: 48000 } }).ok).toBe(false);
    expect(validateClientMessage({ ...start, audio: { ...AUDIO_FORMAT, encoding: 'opus' } }).ok).toBe(false);
  });
  it('rejects a wrong protocol version', () => {
    const result = validateClientMessage({ ...start, protocolVersion: 2 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/protocolVersion/);
  });
  it('rejects missing languages', () => {
    const { sourceLanguage: _s, ...noSource } = start;
    expect(validateClientMessage(noSource).ok).toBe(false);
    expect(validateClientMessage({ ...start, targetLanguage: '' }).ok).toBe(false);
  });
  it('accepts stop/ping with sessionId and rejects without', () => {
    expect(validateClientMessage({ type: 'session.stop', sessionId: 's1' })).toEqual({ ok: true, message: { type: 'session.stop', sessionId: 's1' } });
    expect(validateClientMessage({ type: 'session.ping', sessionId: 's1' }).ok).toBe(true);
    expect(validateClientMessage({ type: 'session.ping' }).ok).toBe(false);
  });
  it('rejects unknown types and non-objects', () => {
    expect(validateClientMessage({ type: 'nope' }).ok).toBe(false);
    expect(validateClientMessage('session.start').ok).toBe(false);
    expect(validateClientMessage(null).ok).toBe(false);
  });
});

describe('validateServerMessage', () => {
  const transcript = {
    type: 'transcript',
    sessionId: 's1',
    segmentId: 'seg-1',
    revision: 0,
    status: 'partial',
    startMs: 0,
    sourceText: 'Hello',
  };
  it('accepts a minimal transcript and preserves optional fields', () => {
    expect(validateServerMessage(transcript)).toEqual({ ok: true, message: transcript });
    const full = { ...transcript, status: 'final', endMs: 1200, translatedText: '你好' };
    expect(validateServerMessage(full)).toEqual({ ok: true, message: full });
  });
  it('rejects malformed transcripts', () => {
    expect(validateServerMessage({ ...transcript, revision: -1 }).ok).toBe(false);
    expect(validateServerMessage({ ...transcript, status: 'done' }).ok).toBe(false);
    expect(validateServerMessage({ ...transcript, sourceText: 5 }).ok).toBe(false);
    expect(validateServerMessage({ ...transcript, segmentId: '' }).ok).toBe(false);
  });
  it('accepts ready/pong/stopped/error/metrics', () => {
    const ready = { type: 'session.ready', sessionId: 's1', asr: { provider: 'mock', language: 'auto' }, translation: { provider: 'mock', targetLanguage: 'zh-CN' } };
    expect(validateServerMessage(ready)).toEqual({ ok: true, message: ready });
    expect(validateServerMessage({ type: 'session.ready', sessionId: 's1', asr: ready.asr }).ok).toBe(false);
    const metrics = { type: 'session.metrics', sessionId: 's1', audioSeconds: 12.5, partials: 3, finals: 1, avgDecodeMs: 420, avgLatencyMs: 900, translated: 1, avgTranslateMs: 1500, translationBacklog: 0 };
    expect(validateServerMessage(metrics)).toEqual({ ok: true, message: metrics });
    expect(validateServerMessage({ ...metrics, avgLatencyMs: -1 }).ok).toBe(false);
    expect(validateServerMessage({ type: 'session.pong', sessionId: 's1' }).ok).toBe(true);
    expect(validateServerMessage({ type: 'session.stopped', sessionId: 's1' }).ok).toBe(true);
    expect(validateServerMessage({ type: 'session.error', code: 'invalid_message', message: 'bad' })).toEqual({
      ok: true,
      message: { type: 'session.error', code: 'invalid_message', message: 'bad' },
    });
    expect(validateServerMessage({ type: 'session.error', code: '' }).ok).toBe(false);
  });

});

describe('validateAudioFrame', () => {
  it('accepts even-length binary frames and views them as Int16', () => {
    const bytes = new Uint8Array([0x00, 0x01, 0xff, 0x7f]);
    const r = validateAudioFrame(bytes);
    expect(r.ok).toBe(true);
    if (r.ok) expect(Array.from(r.message)).toEqual([256, 32767]);
  });
  it('rejects text, empty, odd-length and oversized frames', () => {
    expect(validateAudioFrame('text').ok).toBe(false);
    expect(validateAudioFrame(new Uint8Array(0)).ok).toBe(false);
    expect(validateAudioFrame(new Uint8Array(3)).ok).toBe(false);
    expect(validateAudioFrame(new Uint8Array(64 * 1024 + 2)).ok).toBe(false);
  });
  it('handles unaligned views', () => {
    const backing = new Uint8Array(5);
    backing.set([0, 1, 2, 3], 1);
    const view = new Uint8Array(backing.buffer, 1, 4);
    const r = validateAudioFrame(view);
    expect(r.ok && r.message.length).toBe(2);
  });
});
