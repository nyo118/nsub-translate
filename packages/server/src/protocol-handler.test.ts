import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUDIO_FORMAT, type ServerMessage } from '@lst/protocol';
import { ConnectionHandler } from './protocol-handler.js';
import { createMockFactory } from './asr/mock-adapter.js';
import { createMockTranslationFactory } from './translation/mock-adapter.js';
import { TranslationRegistry } from './translation/registry.js';
import type { TranslationAdapterFactory } from './translation/types.js';

const log = { info: () => {}, warn: () => {} };
const START = JSON.stringify({ type: 'session.start', protocolVersion: 4, sourceLanguage: 'en', targetLanguage: 'zh-CN', audio: AUDIO_FORMAT });
const READY = { type: 'session.ready', sessionId: 'sid-1', asr: { provider: 'mock', language: 'en' }, translation: { provider: 'mock', targetLanguage: 'zh-CN' } };

function mockRegistry(extra: Record<string, () => TranslationAdapterFactory> = {}) {
  const reg = new TranslationRegistry('mock').register('mock', () => createMockTranslationFactory(10));
  for (const [name, b] of Object.entries(extra)) reg.register(name, b);
  return reg;
}

function make() {
  const sent: ServerMessage[] = [];
  const handler = new ConnectionHandler({ send: (m) => sent.push(m), asr: createMockFactory(50), translation: mockRegistry(), log, newSessionId: () => 'sid-1', metricsIntervalMs: 0 });
  return { sent, handler };
}

/** session.start resolves asynchronously (adapter.start is a promise); flush microtasks. */
async function settle() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

describe('ConnectionHandler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('replies session.error for non-JSON, non-object and unknown messages', () => {
    const { sent, handler } = make();
    handler.handleFrame('not json');
    handler.handleFrame('[1]');
    handler.handleFrame(JSON.stringify({ type: 'bogus' }));
    expect(sent.map((m) => m.type)).toEqual(['session.error', 'session.error', 'session.error']);
    expect(sent.every((m) => m.type === 'session.error' && m.code === 'invalid_message')).toBe(true);
  });

  it('flags unsupported protocol versions and audio formats with dedicated codes', () => {
    const { sent, handler } = make();
    handler.handleFrame(JSON.stringify({ type: 'session.start', protocolVersion: 99, sourceLanguage: 'en', targetLanguage: 'zh-CN', audio: AUDIO_FORMAT }));
    expect(sent[0]).toMatchObject({ type: 'session.error', code: 'unsupported_protocol_version' });
    handler.handleFrame(JSON.stringify({ type: 'session.start', protocolVersion: 4, sourceLanguage: 'en', targetLanguage: 'zh-CN', audio: { ...AUDIO_FORMAT, sampleRate: 44100 } }));
    expect(sent[1]).toMatchObject({ type: 'session.error', code: 'unsupported_audio_format' });
  });

  it('starts a session, streams transcripts, answers ping and stops cleanly', async () => {
    const { sent, handler } = make();
    handler.handleFrame(START);
    await settle();
    expect(sent[0]).toEqual(READY);
    expect(handler.activeSessionId).toBe('sid-1');

    vi.advanceTimersByTime(50 * 3);
    const transcripts = sent.filter((m) => m.type === 'transcript');
    expect(transcripts).toHaveLength(3);
    expect(transcripts.every((m) => m.type === 'transcript' && m.sessionId === 'sid-1')).toBe(true);

    handler.handleFrame(JSON.stringify({ type: 'session.ping', sessionId: 'sid-1' }));
    expect(sent.at(-1)).toEqual({ type: 'session.pong', sessionId: 'sid-1' });

    handler.handleFrame(JSON.stringify({ type: 'session.stop', sessionId: 'sid-1' }));
    await settle();
    expect(sent.at(-1)).toEqual({ type: 'session.stopped', sessionId: 'sid-1' });
    expect(handler.activeSessionId).toBeNull();

    const before = sent.length;
    vi.advanceTimersByTime(5000);
    expect(sent.length).toBe(before);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects a second session.start on the same connection', async () => {
    const { sent, handler } = make();
    handler.handleFrame(START);
    handler.handleFrame(START);
    await settle();
    expect(sent.some((m) => m.type === 'session.error' && m.code === 'session_already_started')).toBe(true);
    await handler.dispose('test');
  });

  it('accepts binary audio only for a running session and rejects malformed frames', async () => {
    const { sent, handler } = make();
    handler.handleAudio(new Uint8Array(4)); // no session yet → dropped quietly
    expect(sent).toHaveLength(0);
    handler.handleFrame(START);
    await settle();
    handler.handleAudio(new Uint8Array(3));
    expect(sent.at(-1)).toMatchObject({ type: 'session.error', code: 'invalid_audio' });
    handler.handleAudio('text');
    expect(sent.at(-1)).toMatchObject({ type: 'session.error', code: 'invalid_audio' });
    const before = sent.length;
    handler.handleAudio(new Uint8Array(3200));
    expect(sent.length).toBe(before);
    await handler.dispose('test');
  });

  it('rejects a target language the translator does not support', async () => {
    const sent: ServerMessage[] = [];
    const reg = new TranslationRegistry('t').register('t', () => ({ provider: 't', prepare: async () => {}, create: () => ({ provider: 't', supportsTarget: (l) => l === 'en', translate: async () => '', dispose: async () => {} }) }));
    const handler = new ConnectionHandler({ send: (m) => sent.push(m), asr: createMockFactory(50), translation: reg, log });
    handler.handleFrame(START);
    await settle();
    expect(sent[0]).toMatchObject({ type: 'session.error', code: 'unsupported_language' });
    expect(handler.activeSessionId).toBeNull();
  });

  it('lets the client choose the translation engine and reports unavailable ones', async () => {
    const sent: ServerMessage[] = [];
    const reg = mockRegistry({
      other: () => ({ provider: 'other', prepare: async () => {}, create: () => ({ provider: 'other', supportsTarget: () => true, translate: async () => 'x', dispose: async () => {} }) }),
      google: () => ({ provider: 'google', prepare: async () => { throw new Error('TRANSLATION_PROVIDER=google requires GOOGLE_TRANSLATE_API_KEY'); }, create: () => { throw new Error('unreachable'); } }),
    });
    const handler = new ConnectionHandler({ send: (m) => sent.push(m), asr: createMockFactory(50), translation: reg, log, newSessionId: () => 'sid-1', metricsIntervalMs: 0 });
    handler.handleFrame(JSON.stringify({ ...JSON.parse(START), options: { translationProvider: 'other' } }));
    await settle();
    expect(sent[0]).toMatchObject({ type: 'session.ready', translation: { provider: 'other', targetLanguage: 'zh-CN' } });
    await handler.dispose('test');

    const sent2: ServerMessage[] = [];
    const h2 = new ConnectionHandler({ send: (m) => sent2.push(m), asr: createMockFactory(50), translation: reg, log });
    h2.handleFrame(JSON.stringify({ ...JSON.parse(START), options: { translationProvider: 'google' } }));
    await settle();
    expect(sent2[0]).toMatchObject({ type: 'session.error', code: 'translation_unavailable' });
    expect(sent2[0]).not.toMatchObject({ message: expect.stringContaining('secret') });

    const sent3: ServerMessage[] = [];
    const h3 = new ConnectionHandler({ send: (m) => sent3.push(m), asr: createMockFactory(50), translation: reg, log });
    h3.handleFrame(JSON.stringify({ ...JSON.parse(START), options: { translationProvider: 'nope' } }));
    await settle();
    expect(sent3[0]).toMatchObject({ type: 'session.error', code: 'translation_unavailable' });
  });

  it('reports asr_unavailable when the adapter cannot start', async () => {
    const sent: ServerMessage[] = [];
    const handler = new ConnectionHandler({
      send: (m) => sent.push(m),
      asr: { provider: 'broken', prepare: async () => {}, create: () => ({ provider: 'broken', on: () => {}, start: async () => { throw new Error('model missing'); }, pushAudio: () => {}, stop: async () => {} }) },
      translation: mockRegistry(),
      log,
    });
    handler.handleFrame(START);
    await settle();
    expect(sent[0]).toEqual({ type: 'session.error', code: 'asr_unavailable', message: 'model missing' });
    expect(handler.activeSessionId).toBeNull();
  });

  it('rejects stop/ping for an unknown sessionId', () => {
    const { sent, handler } = make();
    handler.handleFrame(JSON.stringify({ type: 'session.stop', sessionId: 'nope' }));
    handler.handleFrame(JSON.stringify({ type: 'session.ping', sessionId: 'nope' }));
    expect(sent.map((m) => m.type === 'session.error' && m.code)).toEqual(['session_not_found', 'session_not_found']);
  });

  it('dispose() stops the adapter so a closed socket never receives more events', async () => {
    const { sent, handler } = make();
    handler.handleFrame(START);
    await settle();
    await handler.dispose('socket closed');
    vi.advanceTimersByTime(1000);
    expect(sent).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('turns an unexpected exception during start into a session.error instead of throwing', async () => {
    const sent: ServerMessage[] = [];
    const handler = new ConnectionHandler({ send: (m) => sent.push(m), asr: createMockFactory(50), translation: mockRegistry(), log, newSessionId: () => { throw new Error('boom'); } });
    expect(() => handler.handleFrame(START)).not.toThrow();
    await settle();
    expect(sent).toEqual([{ type: 'session.error', code: 'asr_unavailable', message: 'boom' }]);
    expect(handler.activeSessionId).toBeNull();
  });
});
