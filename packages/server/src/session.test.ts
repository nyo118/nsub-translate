import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TranscriptMessage } from '@lst/protocol';
import { MockSession } from './session.js';
import type { ScriptEvent } from './mock-script.js';

const script: ScriptEvent[] = [
  { type: 'transcript', segmentId: 'a', revision: 0, status: 'partial', startMs: 0, sourceText: 'x' },
  { type: 'transcript', segmentId: 'a', revision: 1, status: 'final', startMs: 0, endMs: 10, sourceText: 'xy', translatedText: 't' },
];

describe('MockSession', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('emits script events on a timer with the sessionId attached', () => {
    const emitted: TranscriptMessage[] = [];
    const session = new MockSession({ sessionId: 's1', sourceLanguage: 'en', targetLanguage: 'zh-CN', tickMs: 100, emit: (m) => emitted.push(m), events: script, loop: false });
    session.start();
    expect(emitted).toHaveLength(0);
    vi.advanceTimersByTime(100);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ sessionId: 's1', segmentId: 'a', revision: 0 });
    vi.advanceTimersByTime(100);
    expect(emitted).toHaveLength(2);
    vi.advanceTimersByTime(1000);
    expect(emitted).toHaveLength(2);
    expect(session.state).toBe('stopped');
  });

  it('never emits after stop()', () => {
    const emitted: TranscriptMessage[] = [];
    const session = new MockSession({ sessionId: 's1', sourceLanguage: 'en', targetLanguage: 'zh-CN', tickMs: 100, emit: (m) => emitted.push(m), events: script });
    session.start();
    vi.advanceTimersByTime(100);
    session.stop();
    vi.advanceTimersByTime(5000);
    expect(emitted).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('loops with distinct segment ids so replays are not treated as stale revisions', () => {
    const emitted: TranscriptMessage[] = [];
    const session = new MockSession({ sessionId: 's1', sourceLanguage: 'en', targetLanguage: 'zh-CN', tickMs: 10, emit: (m) => emitted.push(m), events: script, loop: true });
    session.start();
    vi.advanceTimersByTime(10 * 5);
    expect(emitted.map((e) => e.segmentId)).toEqual(['a', 'a', 'a-r1', 'a-r1']);
    session.stop();
  });

  it('start() is idempotent and stop() is idempotent', () => {
    const session = new MockSession({ sessionId: 's1', sourceLanguage: 'en', targetLanguage: 'zh-CN', tickMs: 10, emit: () => {}, events: script });
    session.start();
    session.start();
    expect(vi.getTimerCount()).toBe(1);
    session.stop();
    session.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
