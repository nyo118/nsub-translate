import { describe, expect, it } from 'vitest';
import type { TranscriptMessage } from '@lst/protocol';
import { SubtitleStore } from './subtitle-state.js';

function t(partial: Partial<TranscriptMessage> & { segmentId: string; revision: number }): TranscriptMessage {
  return { type: 'transcript', sessionId: 's', status: 'partial', startMs: 0, sourceText: `${partial.segmentId}:${partial.revision}`, ...partial };
}

describe('SubtitleStore', () => {
  it('applies growing revisions of the same segment in place', () => {
    const store = new SubtitleStore();
    expect(store.apply(t({ segmentId: 'a', revision: 0 }))).toBe(true);
    expect(store.apply(t({ segmentId: 'a', revision: 1, sourceText: 'more' }))).toBe(true);
    expect(store.visible()).toEqual([{ sourceText: 'more', translatedText: undefined, status: 'partial' }]);
    expect(store.size).toBe(1);
  });

  it('keeps the longer text when a partial shrinks on the same prefix, but accepts real corrections', () => {
    const store = new SubtitleStore();
    store.apply(t({ segmentId: 'a', revision: 0, sourceText: 'The tribal chief' }));
    expect(store.apply(t({ segmentId: 'a', revision: 1, sourceText: 'The tribal' }))).toBe(true);
    expect(store.visible()[0]?.sourceText).toBe('The tribal chief'); // no shrink
    store.apply(t({ segmentId: 'a', revision: 2, sourceText: 'The tribe' })); // different prefix → real correction
    expect(store.visible()[0]?.sourceText).toBe('The tribe');
    store.apply(t({ segmentId: 'a', revision: 3, status: 'final', sourceText: 'The' })); // finals always win
    expect(store.visible()[0]?.sourceText).toBe('The');
  });

  it('ignores stale or duplicate revisions', () => {
    const store = new SubtitleStore();
    store.apply(t({ segmentId: 'a', revision: 2, sourceText: 'v2' }));
    expect(store.apply(t({ segmentId: 'a', revision: 1, sourceText: 'v1' }))).toBe(false);
    expect(store.apply(t({ segmentId: 'a', revision: 2, sourceText: 'dup' }))).toBe(false);
    expect(store.visible()[0]?.sourceText).toBe('v2');
  });

  it('never lets a partial overwrite a final, even with a higher revision', () => {
    const store = new SubtitleStore();
    store.apply(t({ segmentId: 'a', revision: 1, status: 'final', sourceText: 'done', translatedText: '完成' }));
    expect(store.apply(t({ segmentId: 'a', revision: 5, status: 'partial', sourceText: 'late partial' }))).toBe(false);
    expect(store.visible()).toEqual([{ sourceText: 'done', translatedText: '完成', status: 'final' }]);
  });

  it('allows a newer final to replace an older final', () => {
    const store = new SubtitleStore();
    store.apply(t({ segmentId: 'a', revision: 1, status: 'final', sourceText: 'v1' }));
    expect(store.apply(t({ segmentId: 'a', revision: 2, status: 'final', sourceText: 'v2' }))).toBe(true);
    expect(store.visible()[0]?.sourceText).toBe('v2');
  });

  it('shows only the most recent N segments in arrival order', () => {
    const store = new SubtitleStore({ visibleCount: 2 });
    store.apply(t({ segmentId: 'a', revision: 0 }));
    store.apply(t({ segmentId: 'b', revision: 0 }));
    store.apply(t({ segmentId: 'c', revision: 0 }));
    expect(store.visible().map((l) => l.sourceText)).toEqual(['b:0', 'c:0']);
  });

  it('keeps the latest translated final on screen while newer segments are still untranslated', () => {
    const store = new SubtitleStore({ visibleCount: 2 });
    store.apply(t({ segmentId: 'a', revision: 0, status: 'final', sourceText: 'A', translatedText: '甲' }));
    store.apply(t({ segmentId: 'b', revision: 0, status: 'final', sourceText: 'B' }));
    store.apply(t({ segmentId: 'c', revision: 0, status: 'partial', sourceText: 'C' }));
    expect(store.visible().map((l) => l.sourceText)).toEqual(['A', 'B', 'C']);
    // Once a visible segment gets its translation, the pinned line goes away.
    store.apply(t({ segmentId: 'b', revision: 1, status: 'final', sourceText: 'B', translatedText: '乙' }));
    expect(store.visible().map((l) => l.sourceText)).toEqual(['B', 'C']);
    // An untranslated older final is never pinned; lookback is bounded.
    const s2 = new SubtitleStore({ visibleCount: 2 });
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) s2.apply(t({ segmentId: id, revision: 0, status: 'final', sourceText: id, ...(id === 'a' ? { translatedText: '甲' } : {}) }));
    expect(s2.visible().map((l) => l.sourceText)).toEqual(['f', 'g']);
  });

  it('evicts the oldest segments beyond maxSegments and clear() empties everything', () => {
    const store = new SubtitleStore({ maxSegments: 3 });
    for (const id of ['a', 'b', 'c', 'd']) store.apply(t({ segmentId: id, revision: 0 }));
    expect(store.size).toBe(3);
    expect(store.apply(t({ segmentId: 'a', revision: 1 }))).toBe(true); // 'a' was evicted, so it is new again
    store.clear();
    expect(store.size).toBe(0);
    expect(store.visible()).toEqual([]);
  });
});
