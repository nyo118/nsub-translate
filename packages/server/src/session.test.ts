import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionMetricsMessage, TranscriptMessage } from '@lst/protocol';
import { Session } from './session.js';
import { MockAsrAdapter } from './asr/mock-adapter.js';
import type { AsrAdapter, AsrAdapterEvents } from './asr/types.js';
import { MockTranslationAdapter } from './translation/mock-adapter.js';

function make(adapter: AsrAdapter = new MockAsrAdapter(100), metricsIntervalMs = 0, translatePartials = false) {
  const sent: Array<TranscriptMessage | SessionMetricsMessage> = [];
  const errors: string[] = [];
  const session = new Session({
    sessionId: 's1',
    sourceLanguage: 'auto',
    targetLanguage: 'zh-CN',
    adapter,
    translation: new MockTranslationAdapter(30),
    translatePartials,
    send: (m) => sent.push(m),
    onError: (c) => errors.push(c),
    metricsIntervalMs,
  });
  return { session, sent, errors };
}

describe('Session', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('starts the adapter, reports asr info and forwards transcripts with the sessionId', async () => {
    const { session, sent } = make();
    const info = await session.start();
    expect(info).toEqual({ provider: 'mock', language: 'auto' });
    expect(session.translationInfo).toEqual({ provider: 'mock', targetLanguage: 'zh-CN' });
    expect(session.state).toBe('running');
    vi.advanceTimersByTime(250);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({ type: 'transcript', sessionId: 's1', segmentId: 'seg-001', revision: 0, status: 'partial' });
    expect((sent[0] as TranscriptMessage).translatedText).toBeUndefined();
    await session.stop();
  });

  it('appends translations to finals as a later revision of the same segment', async () => {
    const { session, sent } = make();
    await session.start();
    // Mock script: two partials then a final for seg-001 (100 ms each), translation takes 30 ms.
    await vi.advanceTimersByTimeAsync(300 + 50);
    const seg = sent.filter((m): m is TranscriptMessage => m.type === 'transcript' && m.segmentId === 'seg-001');
    const finals = seg.filter((m) => m.status === 'final');
    expect(finals).toHaveLength(2);
    expect(finals[0]!.translatedText).toBeUndefined();
    expect(finals[1]!.translatedText).toBe('[zh-CN] Welcome to the live subtitle demo.');
    expect(finals[1]!.revision).toBeGreaterThan(finals[0]!.revision);
    expect(session.metrics()).toMatchObject({ translated: 1, translationBacklog: 0 });
    expect(session.metrics().avgTranslateMs).toBeGreaterThanOrEqual(30);
    await session.stop();
  });

  it('never forwards after stop() and clears the adapter timer', async () => {
    const { session, sent } = make();
    await session.start();
    vi.advanceTimersByTime(100);
    await session.stop();
    const n = sent.length;
    vi.advanceTimersByTime(2000);
    expect(sent).toHaveLength(n);
    expect(vi.getTimerCount()).toBe(0);
    expect(session.state).toBe('stopped');
    await session.stop(); // idempotent
  });

  it('counts audio and aggregates metrics, emitting session.metrics periodically', async () => {
    const { session, sent } = make(new MockAsrAdapter(100), 1000);
    await session.start();
    session.pushAudio(new Int16Array(16000)); // 1 s
    session.pushAudio(new Int16Array(8000)); // 0.5 s
    await vi.advanceTimersByTimeAsync(1000); // async so mock translations (setTimeout + promises) complete
    const metrics = sent.filter((m): m is SessionMetricsMessage => m.type === 'session.metrics');
    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatchObject({ sessionId: 's1', audioSeconds: 1.5, avgDecodeMs: 1, avgLatencyMs: 100, translationBacklog: 0 });
    expect(metrics[0]!.partials + metrics[0]!.finals).toBeGreaterThan(0);
    await session.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores audio before start and after stop', async () => {
    const adapter = new MockAsrAdapter(100);
    const push = vi.spyOn(adapter, 'pushAudio');
    const { session } = make(adapter);
    session.pushAudio(new Int16Array(10));
    await session.start();
    session.pushAudio(new Int16Array(10));
    await session.stop();
    session.pushAudio(new Int16Array(10));
    expect(push).toHaveBeenCalledTimes(1);
  });

  it('surfaces adapter errors while running and start failures as rejections', async () => {
    const handlers: Partial<AsrAdapterEvents> = {};
    const failing: AsrAdapter = {
      provider: 'fake',
      on: (e, l) => {
        (handlers as Record<string, unknown>)[e] = l;
      },
      start: async () => ({ language: 'en' }),
      pushAudio: () => {},
      stop: async () => {},
    };
    const { session, errors } = make(failing);
    await session.start();
    handlers.error?.('asr_failed', 'boom');
    expect(errors).toEqual(['asr_failed']);
    await session.stop();
    handlers.error?.('asr_failed', 'late');
    expect(errors).toEqual(['asr_failed']);

    const broken: AsrAdapter = { ...failing, start: async () => { throw new Error('no model'); } };
    const { session: s2 } = make(broken);
    await expect(s2.start()).rejects.toThrow('no model');
    expect(s2.state).toBe('stopped');
  });
});
