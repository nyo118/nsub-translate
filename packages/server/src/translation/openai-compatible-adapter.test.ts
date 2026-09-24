import { describe, expect, it } from 'vitest';
import { GEMINI_OPENAI_BASE_URL, OpenAiCompatibleAdapter, buildSystemPrompt, createOpenAiCompatibleFactory, normalizeBaseUrl } from './openai-compatible-adapter.js';
import { cleanOutput } from './text-utils.js';

function fakeFetch(handler: (url: string, init: RequestInit, n: number) => { status: number; body: unknown }): typeof fetch & { calls: number } {
  let calls = 0;
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    const r = handler(String(url), init ?? {}, calls);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch & { calls: number };
  Object.defineProperty(f, 'calls', { get: () => calls });
  return f;
}

const base = { provider: 'gemini', baseUrl: GEMINI_OPENAI_BASE_URL, apiKey: 'SECRET', model: 'gemini-3.5-flash-lite', envHint: 'GEMINI_API_KEY' };

describe('OpenAiCompatibleAdapter', () => {
  it('posts a chat completion with system prompt, context as prior turns, and bearer auth', async () => {
    let seen: { url: string; headers: Record<string, string>; body: Record<string, unknown> } | null = null;
    const adapter = new OpenAiCompatibleAdapter({
      ...base,
      fetchImpl: fakeFetch((url, init) => {
        seen = { url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) as Record<string, unknown> };
        return { status: 200, body: { choices: [{ message: { content: '“你好，欢迎。”' } }] } };
      }),
    });
    const out = await adapter.translate({ text: 'Hello, welcome.', sourceLanguage: 'en', targetLanguage: 'zh-CN', context: [{ source: 'Hi.', translated: '嗨。' }] });
    expect(out).toBe('你好，欢迎。');
    expect(seen!.url).toBe(`${GEMINI_OPENAI_BASE_URL}/chat/completions`);
    expect(seen!.headers['authorization']).toBe('Bearer SECRET');
    expect(seen!.body['model']).toBe('gemini-3.5-flash-lite');
    expect(seen!.body['messages']).toEqual([
      { role: 'system', content: buildSystemPrompt('zh-CN') },
      { role: 'user', content: 'Hi.' },
      { role: 'assistant', content: '嗨。' },
      { role: 'user', content: 'Hello, welcome.' },
    ]);
    expect(buildSystemPrompt('zh-CN')).toContain('简体中文');
  });

  it('retries once on 429/5xx, then fails without leaking the key', async () => {
    const f = fakeFetch((_u, _i, n) => (n === 1 ? { status: 429, body: {} } : { status: 200, body: { choices: [{ message: { content: 'ok' } }] } }));
    const adapter = new OpenAiCompatibleAdapter({ ...base, fetchImpl: f });
    await expect(adapter.translate({ text: 'x', sourceLanguage: 'en', targetLanguage: 'ja', context: [] })).resolves.toBe('ok');
    expect(f.calls).toBe(2);
    const always503 = new OpenAiCompatibleAdapter({ ...base, fetchImpl: fakeFetch(() => ({ status: 503, body: {} })) });
    await expect(always503.translate({ text: 'x', sourceLanguage: 'en', targetLanguage: 'ja', context: [] })).rejects.toThrow(/HTTP 503/);
    const forbidden = new OpenAiCompatibleAdapter({ ...base, fetchImpl: fakeFetch(() => ({ status: 403, body: {} })) });
    await expect(forbidden.translate({ text: 'x', sourceLanguage: 'en', targetLanguage: 'ja', context: [] })).rejects.not.toThrow(/SECRET/);
  }, 10_000);

  it('supports the curated target list and the factory refuses to prepare without a key', async () => {
    const adapter = new OpenAiCompatibleAdapter(base);
    expect(adapter.supportsTarget('zh-TW')).toBe(true);
    expect(adapter.supportsTarget('xx')).toBe(false);
    await expect(createOpenAiCompatibleFactory({ ...base, apiKey: '' }).prepare()).rejects.toThrow(/GEMINI_API_KEY/);
  });

  it('prepare() warms up through the endpoint and reports unusable models clearly', async () => {
    const ok = fakeFetch(() => ({ status: 200, body: { choices: [{ message: { content: '你好，欢迎。' } }] } }));
    await expect(createOpenAiCompatibleFactory({ ...base, fetchImpl: ok }).prepare()).resolves.toBeUndefined();
    expect(ok.calls).toBe(1);
    const notFound = fakeFetch(() => ({ status: 404, body: { error: { message: 'model not found' } } }));
    await expect(createOpenAiCompatibleFactory({ ...base, model: 'gemma-4-31b-it', fetchImpl: notFound }).prepare()).rejects.toThrow(/gemma-4-31b-it.*warm-up.*HTTP 404/);
    await expect(createOpenAiCompatibleFactory({ ...base, baseUrl: 'not a url' }).prepare()).rejects.toThrow(/not a valid URL/);
  });

  it('normalises base URLs (adds /v1 for bare hosts like LM Studio) and strips thinking blocks', () => {
    expect(normalizeBaseUrl('http://192.168.50.2:1234')).toBe('http://192.168.50.2:1234/v1');
    expect(normalizeBaseUrl('http://192.168.50.2:1234/')).toBe('http://192.168.50.2:1234/v1');
    expect(normalizeBaseUrl('http://192.168.50.2:1234/v1/')).toBe('http://192.168.50.2:1234/v1');
    expect(normalizeBaseUrl(GEMINI_OPENAI_BASE_URL)).toBe(GEMINI_OPENAI_BASE_URL);
    expect(cleanOutput('<thought>reasoning…</thought>并赠予他五十枚金币。')).toBe('并赠予他五十枚金币。');
    expect(cleanOutput('<thought>*   Source: "')).toBe('');
  });
});
