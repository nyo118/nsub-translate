import { describe, expect, it, vi } from 'vitest';
import { TranslationRegistry } from './registry.js';
import type { TranslationAdapterFactory } from './types.js';

function factory(provider: string, prepare = vi.fn(async () => {})): TranslationAdapterFactory & { prepare: typeof prepare } {
  return { provider, prepare, create: () => ({ provider, supportsTarget: () => true, translate: async () => '', dispose: async () => {} }) };
}

describe('TranslationRegistry', () => {
  it('prepares each engine once, lazily, and uses the default when no name is given', async () => {
    const a = factory('a');
    const b = factory('b');
    const built: string[] = [];
    const reg = new TranslationRegistry('a').register('a', () => (built.push('a'), a)).register('b', () => (built.push('b'), b));
    expect(built).toEqual([]);
    expect((await reg.get()).provider).toBe('a');
    expect((await reg.get('a')).provider).toBe('a');
    expect(a.prepare).toHaveBeenCalledTimes(1);
    expect(b.prepare).not.toHaveBeenCalled();
    expect((await reg.get('b')).provider).toBe('b');
    expect(built).toEqual(['a', 'b']);
    expect(reg.providers).toEqual(['a', 'b']);
  });

  it('rejects unknown names and retries a failed prepare next time', async () => {
    let attempts = 0;
    const flaky = factory('g', vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('GOOGLE_TRANSLATE_API_KEY missing');
    }));
    const reg = new TranslationRegistry('g').register('g', () => flaky);
    await expect(reg.get('nope')).rejects.toThrow(/unknown translation provider "nope"/);
    await expect(reg.get('g')).rejects.toThrow(/API_KEY/);
    await expect(reg.get('g')).resolves.toBe(flaky);
    expect(attempts).toBe(2);
  });
});
