import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TranscriptMessage } from '@lst/protocol';
import { TranslationPipeline, type TranslationPipelineOptions } from './pipeline.js';
import type { AsrTranscript } from '../asr/types.js';
import type { TranslationAdapter, TranslationRequest } from './types.js';

/** Adapter whose translations resolve when the test says so. */
class ManualAdapter implements TranslationAdapter {
  readonly provider = 'manual';
  calls: Array<{ req: TranslationRequest; resolve: (s: string) => void; reject: (e: unknown) => void }> = [];
  supportsTarget() {
    return true;
  }
  translate(req: TranslationRequest): Promise<string> {
    return new Promise((resolve, reject) => {
      this.calls.push({ req, resolve, reject });
      req.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    });
  }
  async dispose() {}
}

function make(options: Partial<TranslationPipelineOptions> = {}) {
  const adapter = new ManualAdapter();
  const out: TranscriptMessage[] = [];
  const errors: string[] = [];
  const pipeline = new TranslationPipeline({ sessionId: 's', targetLanguage: 'zh-CN', adapter, emit: (m) => out.push(m), onError: (c, m) => errors.push(`${c}: ${m}`), ...options });
  return { adapter, out, errors, pipeline };
}

const t = (segmentId: string, revision: number, status: 'partial' | 'final', text: string): AsrTranscript => ({
  segmentId,
  revision,
  status,
  startMs: 0,
  ...(status === 'final' ? { endMs: 1000 } : {}),
  text,
  language: 'en',
});

async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe('TranslationPipeline', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('forwards source text immediately and appends the translation as a higher revision', async () => {
    const { adapter, out, pipeline } = make();
    pipeline.onTranscript(t('a', 0, 'partial', 'Hello'));
    pipeline.onTranscript(t('a', 1, 'final', 'Hello world.'));
    expect(out.map((m) => [m.revision, m.status, m.translatedText])).toEqual([
      [0, 'partial', undefined],
      [1, 'final', undefined],
    ]);
    expect(adapter.calls).toHaveLength(1);
    expect(adapter.calls[0]!.req).toMatchObject({ text: 'Hello world.', sourceLanguage: 'en', targetLanguage: 'zh-CN', context: [] });
    adapter.calls[0]!.resolve(' 你好，世界。 ');
    await flush();
    expect(out.at(-1)).toMatchObject({ segmentId: 'a', revision: 2, status: 'final', sourceText: 'Hello world.', translatedText: '你好，世界。', endMs: 1000 });
    expect(pipeline.translated).toBe(1);
  });

  it('translates one final at a time, in order, and passes previous finals as context', async () => {
    const { adapter, out, pipeline } = make({ contextSize: 2, maxBacklog: 3 });
    pipeline.onTranscript(t('a', 0, 'final', 'One.'));
    pipeline.onTranscript(t('b', 0, 'final', 'Two.'));
    pipeline.onTranscript(t('c', 0, 'final', 'Three.'));
    expect(adapter.calls).toHaveLength(1);
    expect(pipeline.backlog).toBe(3);
    adapter.calls[0]!.resolve('一。');
    await flush();
    expect(adapter.calls).toHaveLength(2);
    expect(adapter.calls[1]!.req.context).toEqual([{ source: 'One.', translated: '一。' }]);
    adapter.calls[1]!.resolve('二。');
    await flush();
    adapter.calls[2]!.resolve('三。');
    await flush();
    expect(out.filter((m) => m.translatedText).map((m) => m.segmentId)).toEqual(['a', 'b', 'c']);
    expect(pipeline.backlog).toBe(0);
  });

  it('by default keeps only the newest waiting final (freshness over completeness)', async () => {
    const { adapter, out, pipeline } = make();
    for (const id of ['a', 'b', 'c', 'd']) pipeline.onTranscript(t(id, 0, 'final', `${id}.`));
    adapter.calls[0]!.resolve('A');
    await flush();
    expect(adapter.calls).toHaveLength(2);
    expect(adapter.calls[1]!.req.text).toBe('d.');
    adapter.calls[1]!.resolve('D');
    await flush();
    expect(out.filter((m) => m.translatedText).map((m) => m.segmentId)).toEqual(['a', 'd']);
  });

  it('drops the oldest finals beyond maxBacklog (their source text stays visible)', async () => {
    const { adapter, out, pipeline } = make({ maxBacklog: 2 });
    for (const id of ['a', 'b', 'c', 'd']) pipeline.onTranscript(t(id, 0, 'final', `${id}.`));
    // 'a' is in flight; queue holds at most 2 → 'b' was evicted.
    adapter.calls[0]!.resolve('A');
    await flush();
    adapter.calls[1]!.resolve('C');
    await flush();
    adapter.calls[2]!.resolve('D');
    await flush();
    expect(out.filter((m) => m.translatedText).map((m) => m.segmentId)).toEqual(['a', 'c', 'd']);
    expect(out.some((m) => m.segmentId === 'b' && m.translatedText)).toBe(false);
  });

  it('does not translate partials unless enabled; when enabled, throttles and lets a final supersede', async () => {
    const off = make();
    off.pipeline.onTranscript(t('a', 0, 'partial', 'This is a long partial sentence'));
    expect(off.adapter.calls).toHaveLength(0);

    const { adapter, out, pipeline } = make({ translatePartials: true, partialIntervalMs: 2000, partialMinChars: 5 });
    pipeline.onTranscript(t('a', 0, 'partial', 'Hi'));
    expect(adapter.calls).toHaveLength(0); // too short
    pipeline.onTranscript(t('a', 1, 'partial', 'Hi there my'));
    expect(adapter.calls).toHaveLength(1);
    adapter.calls[0]!.resolve('嗨，你好');
    await flush();
    expect(out.at(-1)).toMatchObject({ segmentId: 'a', status: 'partial', revision: 2, translatedText: '嗨，你好' });
    // Within the interval: no new partial translation.
    pipeline.onTranscript(t('a', 2, 'partial', 'Hi there my friend'));
    expect(adapter.calls).toHaveLength(1);
    vi.advanceTimersByTime(2000);
    vi.setSystemTime(Date.now());
    pipeline.onTranscript(t('a', 3, 'partial', 'Hi there my friend how'));
    expect(adapter.calls).toHaveLength(2);
    // Final arrives while the partial translation is in flight → partial aborted, final translated.
    pipeline.onTranscript(t('a', 4, 'final', 'Hi there my friend, how are you?'));
    await flush();
    expect(adapter.calls).toHaveLength(3);
    expect(adapter.calls[2]!.req.text).toBe('Hi there my friend, how are you?');
    adapter.calls[2]!.resolve('嗨朋友，你好吗？');
    await flush();
    const last = out.at(-1)!;
    expect(last).toMatchObject({ status: 'final', translatedText: '嗨朋友，你好吗？' });
    // Revisions strictly increase for the segment.
    const revs = out.filter((m) => m.segmentId === 'a').map((m) => m.revision);
    revs.forEach((r, i) => i > 0 && expect(r).toBeGreaterThan(revs[i - 1]!));
  });

  it('discards a stale translation result when the source changed meanwhile', async () => {
    const { adapter, out, pipeline } = make({ translatePartials: true, partialMinChars: 1, partialIntervalMs: 0 });
    pipeline.onTranscript(t('a', 0, 'partial', 'first text'));
    pipeline.onTranscript(t('a', 1, 'partial', 'first text second'));
    adapter.calls[0]!.resolve('旧译文');
    await flush();
    expect(out.some((m) => m.translatedText === '旧译文')).toBe(false);
  });

  it('times out slow translations, and after repeated failures gives up with one error', async () => {
    const { adapter, errors, pipeline } = make({ timeoutMs: 1000, failureThreshold: 2, maxBacklog: 3 });
    pipeline.onTranscript(t('a', 0, 'final', 'A.'));
    pipeline.onTranscript(t('b', 0, 'final', 'B.'));
    pipeline.onTranscript(t('c', 0, 'final', 'C.'));
    vi.advanceTimersByTime(1000); // 'a' times out
    await flush();
    expect(errors).toEqual([]);
    expect(adapter.calls).toHaveLength(2);
    adapter.calls[1]!.reject(new Error('boom'));
    await flush();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/translation_failed: translation failed 2 times/);
    // Pipeline keeps forwarding source text but stops translating.
    pipeline.onTranscript(t('d', 0, 'final', 'D.'));
    expect(adapter.calls).toHaveLength(2);
    expect(pipeline.backlog).toBe(0);
  });

  it('a success resets the failure counter', async () => {
    const { adapter, errors, pipeline } = make({ failureThreshold: 2 });
    pipeline.onTranscript(t('a', 0, 'final', 'A.'));
    adapter.calls[0]!.reject(new Error('x'));
    await flush();
    pipeline.onTranscript(t('b', 0, 'final', 'B.'));
    adapter.calls[1]!.resolve('乙');
    await flush();
    pipeline.onTranscript(t('c', 0, 'final', 'C.'));
    adapter.calls[2]!.reject(new Error('y'));
    await flush();
    expect(errors).toEqual([]);
  });

  it('stop() aborts in-flight work and ignores later results', async () => {
    const { adapter, out, pipeline } = make();
    pipeline.onTranscript(t('a', 0, 'final', 'A.'));
    pipeline.stop();
    expect(adapter.calls[0]!.req.signal?.aborted).toBe(true);
    adapter.calls[0]!.resolve('甲');
    await flush();
    expect(out.some((m) => m.translatedText)).toBe(false);
    pipeline.onTranscript(t('b', 0, 'final', 'B.'));
    expect(out).toHaveLength(1);
  });
});
