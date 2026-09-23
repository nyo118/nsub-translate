import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUDIO_FORMAT, type ServerMessage } from '@lst/protocol';
import { ConnectionHandler } from './protocol-handler.js';
import { createMockFactory } from './asr/mock-adapter.js';

const log = { info: () => {}, warn: () => {} };
const START = JSON.stringify({ type: 'session.start', protocolVersion: 2, sourceLanguage: 'en', targetLanguage: 'zh-CN', audio: AUDIO_FORMAT });

function make() {
  const sent: ServerMessage[] = [];
  const handler = new ConnectionHandler({ send: (m) => sent.push(m), asr: createMockFactory(50), log, newSessionId: () => 'sid-1', metricsIntervalMs: 0 });
  return { sent, handler };
}

/** session.start resolves asynchronously (adapter.start is a promise); flush microtasks. */
async function settle() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
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
    handler.handleFrame(JSON.stringify({ type: 'session.start', protocolVersion: 2, sourceLanguage: 'en', targetLanguage: 'zh-CN', audio: { ...AUDIO_FORMAT, sampleRate: 44100 } }));
    expect(sent[1]).toMatchObject({ type: 'session.error', code: 'unsupported_audio_format' });
  });

  it('starts a session, streams transcripts, answers ping and stops cleanly', async () => {
    const { sent, handler } = make();
    handler.handleFrame(START);
    await settle();
    expect(sent[0]).toEqual({ type: 'session.ready', sessionId: 'sid-1', asr: { provider: 'mock', language: 'en' } });
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

  it('reports asr_unavailable when the adapter cannot start', async () => {
    const sent: ServerMessage[] = [];
    const handler = new ConnectionHandler({
      send: (m) => sent.push(m),
      asr: { provider: 'broken', prepare: async () => {}, create: () => ({ provider: 'broken', on: () => {}, start: async () => { throw new Error('model missing'); }, pushAudio: () => {}, stop: async () => {} }) },
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

  it('turns an unexpected exception into session.error internal_error instead of throwing', () => {
    const sent: ServerMessage[] = [];
    const handler = new ConnectionHandler({ send: (m) => sent.push(m), asr: createMockFactory(50), log, newSessionId: () => { throw new Error('boom'); } });
    expect(() => handler.handleFrame(START)).not.toThrow();
    expect(sent).toEqual([{ type: 'session.error', code: 'internal_error', message: 'boom' }]);
    expect(handler.activeSessionId).toBeNull();
  });
});
