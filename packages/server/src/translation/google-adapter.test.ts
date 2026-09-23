import { describe, expect, it } from 'vitest';
import { GoogleTranslationAdapter, createGoogleTranslationFactory, toGoogleLanguage } from './google-adapter.js';

function fakeFetch(handler: (url: string, init: RequestInit) => { status: number; body: unknown }): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const r = handler(String(url), init ?? {});
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

describe('GoogleTranslationAdapter', () => {
  it('posts q/target/source and returns translatedText; the key goes in the query string only', async () => {
    let seen: { url: string; body: Record<string, unknown> } | null = null;
    const adapter = new GoogleTranslationAdapter({
      apiKey: 'SECRET',
      fetchImpl: fakeFetch((url, init) => {
        seen = { url, body: JSON.parse(String(init.body)) as Record<string, unknown> };
        return { status: 200, body: { data: { translations: [{ translatedText: '你好' }] } } };
      }),
    });
    const out = await adapter.translate({ text: 'Hello', sourceLanguage: 'en', targetLanguage: 'zh-CN', context: [] });
    expect(out).toBe('你好');
    expect(seen!.url).toContain('key=SECRET');
    expect(seen!.body).toEqual({ q: 'Hello', target: 'zh-CN', format: 'text', source: 'en' });
  });

  it('omits source for auto, maps codes, and fails on unsupported targets', async () => {
    let body: Record<string, unknown> = {};
    const adapter = new GoogleTranslationAdapter({
      apiKey: 'k',
      fetchImpl: fakeFetch((_u, init) => {
        body = JSON.parse(String(init.body)) as Record<string, unknown>;
        return { status: 200, body: { data: { translations: [{ translatedText: 'x' }] } } };
      }),
    });
    await adapter.translate({ text: 'こんにちは', sourceLanguage: 'auto', targetLanguage: 'zh-TW', context: [] });
    expect(body).toEqual({ q: 'こんにちは', target: 'zh-TW', format: 'text' });
    expect(adapter.supportsTarget('zh-CN')).toBe(true);
    expect(adapter.supportsTarget('xx')).toBe(false);
    await expect(adapter.translate({ text: 'a', sourceLanguage: 'en', targetLanguage: 'xx', context: [] })).rejects.toThrow(/unsupported target/);
    expect(toGoogleLanguage('yue')).toBe('zh-TW');
  });

  it('turns HTTP errors into exceptions without leaking the key', async () => {
    const adapter = new GoogleTranslationAdapter({ apiKey: 'SECRET', fetchImpl: fakeFetch(() => ({ status: 403, body: { error: 'nope' } })) });
    await expect(adapter.translate({ text: 'a', sourceLanguage: 'en', targetLanguage: 'ja', context: [] })).rejects.toThrow(/HTTP 403/);
    await expect(adapter.translate({ text: 'a', sourceLanguage: 'en', targetLanguage: 'ja', context: [] })).rejects.not.toThrow(/SECRET/);
  });

  it('factory refuses to prepare without an API key', async () => {
    await expect(createGoogleTranslationFactory({ apiKey: '' }).prepare()).rejects.toThrow(/GOOGLE_TRANSLATE_API_KEY/);
    await expect(createGoogleTranslationFactory({ apiKey: 'k' }).prepare()).resolves.toBeUndefined();
  });
});
