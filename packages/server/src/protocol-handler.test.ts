import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerMessage } from '@lst/protocol';
import { ConnectionHandler } from './protocol-handler.js';

const log = { info: () => {}, warn: () => {} };

function make() {
  const sent: ServerMessage[] = [];
  const handler = new ConnectionHandler({ send: (m) => sent.push(m), tickMs: 50, log, newSessionId: () => 'sid-1' });
  return { sent, handler };
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

  it('flags unsupported protocol versions with a dedicated code', () => {
    const { sent, handler } = make();
    handler.handleFrame(JSON.stringify({ type: 'session.start', protocolVersion: 99, sourceLanguage: 'en', targetLanguage: 'zh-CN' }));
    expect(sent[0]).toMatchObject({ type: 'session.error', code: 'unsupported_protocol_version' });
  });

  it('starts a session, streams transcripts, answers ping and stops cleanly', () => {
    const { sent, handler } = make();
    handler.handleFrame(JSON.stringify({ type: 'session.start', protocolVersion: 1, sourceLanguage: 'en', targetLanguage: 'zh-CN' }));
    expect(sent[0]).toEqual({ type: 'session.ready', sessionId: 'sid-1' });
    expect(handler.activeSessionId).toBe('sid-1');

    vi.advanceTimersByTime(50 * 3);
    const transcripts = sent.filter((m) => m.type === 'transcript');
    expect(transcripts).toHaveLength(3);
    expect(transcripts.every((m) => m.type === 'transcript' && m.sessionId === 'sid-1')).toBe(true);

    handler.handleFrame(JSON.stringify({ type: 'session.ping', sessionId: 'sid-1' }));
    expect(sent.at(-1)).toEqual({ type: 'session.pong', sessionId: 'sid-1' });

    handler.handleFrame(JSON.stringify({ type: 'session.stop', sessionId: 'sid-1' }));
    expect(sent.at(-1)).toEqual({ type: 'session.stopped', sessionId: 'sid-1' });
    expect(handler.activeSessionId).toBeNull();

    const before = sent.length;
    vi.advanceTimersByTime(5000);
    expect(sent.length).toBe(before);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects a second session.start on the same connection', () => {
    const { sent, handler } = make();
    const start = JSON.stringify({ type: 'session.start', protocolVersion: 1, sourceLanguage: 'en', targetLanguage: 'zh-CN' });
    handler.handleFrame(start);
    handler.handleFrame(start);
    expect(sent.at(-1)).toMatchObject({ type: 'session.error', code: 'session_already_started' });
    handler.dispose('test');
  });

  it('rejects stop/ping for an unknown sessionId', () => {
    const { sent, handler } = make();
    handler.handleFrame(JSON.stringify({ type: 'session.stop', sessionId: 'nope' }));
    handler.handleFrame(JSON.stringify({ type: 'session.ping', sessionId: 'nope' }));
    expect(sent.map((m) => m.type === 'session.error' && m.code)).toEqual(['session_not_found', 'session_not_found']);
  });

  it('dispose() stops the timer so a closed socket never receives more events', () => {
    const { sent, handler } = make();
    handler.handleFrame(JSON.stringify({ type: 'session.start', protocolVersion: 1, sourceLanguage: 'en', targetLanguage: 'zh-CN' }));
    handler.dispose('socket closed');
    vi.advanceTimersByTime(1000);
    expect(sent).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('turns an unexpected exception into session.error internal_error instead of throwing', () => {
    const sent: ServerMessage[] = [];
    const handler = new ConnectionHandler({ send: (m) => sent.push(m), tickMs: 50, log, newSessionId: () => { throw new Error('boom'); } });
    expect(() => handler.handleFrame(JSON.stringify({ type: 'session.start', protocolVersion: 1, sourceLanguage: 'en', targetLanguage: 'zh-CN' }))).not.toThrow();
    expect(sent).toEqual([{ type: 'session.error', code: 'internal_error', message: 'boom' }]);
    expect(handler.activeSessionId).toBeNull();
  });
});
