import { describe, expect, it } from 'vitest';
import { SubtitleCache } from './subtitle-cache.js';

describe('SubtitleCache', () => {
  it('returns the covering segment plus the previous one, with slack after the end', () => {
    const c = new SubtitleCache();
    c.upsert({ segmentId: 'a', startTime: 10, endTime: 13, sourceText: 'A', translatedText: '甲' });
    c.upsert({ segmentId: 'b', startTime: 13.5, endTime: 16, sourceText: 'B' });
    c.upsert({ segmentId: 'c', startTime: 20, endTime: 22, sourceText: 'C', translatedText: '丙' });
    expect(c.at(11).map((l) => l.sourceText)).toEqual(['A']);
    expect(c.at(14).map((l) => l.sourceText)).toEqual(['A', 'B']);
    expect(c.at(16.3).map((l) => l.sourceText)).toEqual(['A', 'B']); // within slack
    expect(c.at(17)).toEqual([]);
    expect(c.at(21)).toEqual([
      { sourceText: 'B', translatedText: undefined, status: 'final' },
      { sourceText: 'C', translatedText: '丙', status: 'final' },
    ]);
  });

  it('upsert updates a segment in place (translation arriving later) and ignores empty ranges', () => {
    const c = new SubtitleCache();
    c.upsert({ segmentId: 'a', startTime: 1, endTime: 2, sourceText: 'A' });
    c.upsert({ segmentId: 'a', startTime: 1, endTime: 2, sourceText: 'A', translatedText: '甲' });
    expect(c.size).toBe(1);
    expect(c.at(1.5)[0]?.translatedText).toBe('甲');
    c.upsert({ segmentId: 'x', startTime: 5, endTime: 5, sourceText: 'X' });
    expect(c.size).toBe(1);
  });

  it('evicts the oldest entries beyond the cap and clear() empties it', () => {
    const c = new SubtitleCache(2);
    c.upsert({ segmentId: 'a', startTime: 0, endTime: 1, sourceText: 'A' });
    c.upsert({ segmentId: 'b', startTime: 1, endTime: 2, sourceText: 'B' });
    c.upsert({ segmentId: 'c', startTime: 2, endTime: 3, sourceText: 'C' });
    expect(c.size).toBe(2);
    expect(c.at(0.5)).toEqual([]);
    c.clear();
    expect(c.size).toBe(0);
  });
});
