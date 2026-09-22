import { describe, expect, it } from 'vitest';
import { MOCK_SEGMENTS, buildScriptEvents } from './mock-script.js';

describe('buildScriptEvents', () => {
  const events = buildScriptEvents();

  it('is deterministic', () => {
    expect(buildScriptEvents()).toEqual(events);
  });

  it('emits revisions that increase monotonically per segment and end with exactly one final', () => {
    const bySegment = new Map<string, typeof events>();
    for (const e of events) {
      const list = bySegment.get(e.segmentId) ?? [];
      list.push(e);
      bySegment.set(e.segmentId, list);
    }
    expect(bySegment.size).toBe(MOCK_SEGMENTS.length);
    for (const list of bySegment.values()) {
      list.forEach((e, i) => expect(e.revision).toBe(i));
      const finals = list.filter((e) => e.status === 'final');
      expect(finals).toHaveLength(1);
      expect(list.at(-1)?.status).toBe('final');
      expect(list.at(-1)?.translatedText).toBeTruthy();
      expect(list.at(-1)?.endMs).toBeGreaterThan(list.at(-1)!.startMs);
    }
  });

  it('partials never carry a translation (bilingual text arrives with final)', () => {
    for (const e of events.filter((e) => e.status === 'partial')) {
      expect(e.translatedText).toBeUndefined();
    }
  });
});
