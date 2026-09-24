import { describe, expect, it } from 'vitest';
import { GEMINI_OPENAI_BASE_URL, OpenAiCompatibleAdapter, buildSystemPrompt, createOpenAiCompatibleFactory } from './openai-compatible-adapter.js';

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
    await expect(createOpenAiCompatibleFactory(base).prepare()).resolves.toBeUndefined();
  });
});
