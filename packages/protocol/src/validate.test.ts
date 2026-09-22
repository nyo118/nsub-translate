import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, parseJsonObject, validateClientMessage, validateServerMessage } from './index.js';

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
    const result = validateClientMessage({
      type: 'session.start',
      protocolVersion: PROTOCOL_VERSION,
      sourceLanguage: 'en',
      targetLanguage: 'zh-CN',
      extra: 'ignored',
    });
    expect(result).toEqual({
      ok: true,
      message: { type: 'session.start', protocolVersion: 1, sourceLanguage: 'en', targetLanguage: 'zh-CN' },
    });
  });
  it('rejects a wrong protocol version', () => {
    const result = validateClientMessage({ type: 'session.start', protocolVersion: 2, sourceLanguage: 'en', targetLanguage: 'zh' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/protocolVersion/);
  });
  it('rejects missing languages', () => {
    expect(validateClientMessage({ type: 'session.start', protocolVersion: 1, targetLanguage: 'zh' }).ok).toBe(false);
    expect(validateClientMessage({ type: 'session.start', protocolVersion: 1, sourceLanguage: 'en', targetLanguage: '' }).ok).toBe(false);
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
  it('accepts ready/pong/stopped/error', () => {
    expect(validateServerMessage({ type: 'session.ready', sessionId: 's1' }).ok).toBe(true);
    expect(validateServerMessage({ type: 'session.pong', sessionId: 's1' }).ok).toBe(true);
    expect(validateServerMessage({ type: 'session.stopped', sessionId: 's1' }).ok).toBe(true);
    expect(validateServerMessage({ type: 'session.error', code: 'invalid_message', message: 'bad' })).toEqual({
      ok: true,
      message: { type: 'session.error', code: 'invalid_message', message: 'bad' },
    });
    expect(validateServerMessage({ type: 'session.error', code: '' }).ok).toBe(false);
  });
});
