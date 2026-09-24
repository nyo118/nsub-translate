import type { TranslationAdapter, TranslationAdapterFactory, TranslationRequest } from './types.js';
import { TARGET_NAMES, cleanOutput } from './text-utils.js';
import { RateLimiter } from './rate-limiter.js';

/**
 * Any OpenAI-compatible chat-completions endpoint: Gemini (AI Studio),
 * Groq, OpenRouter, a local Ollama, … One adapter, many free tiers. The key
 * lives only in the backend environment.
 */
export interface OpenAiCompatibleConfig {
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  fetchImpl?: typeof fetch;
  /** Env variable names for error messages. */
  envHint: string;
  log?: { info: (o: Record<string, unknown>, m: string) => void; warn: (o: Record<string, unknown>, m: string) => void };
  /** Requests per minute allowed for this engine (cloud free tiers). 0 = unlimited. */
  requestsPerMinute?: number;
  /** Shared limiter (one per engine, across sessions). */
  limiter?: RateLimiter;
}

const RATE_LIMIT_MAX_WAIT_MS = 4000;
const COOLDOWN_AFTER_429_MS = 15_000;

/** Most OpenAI-compatible servers (LM Studio, Ollama, Groq, OpenRouter) live under `/v1`; add it when the URL has no path. */
export function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  try {
    const u = new URL(trimmed);
    if (u.pathname === '' || u.pathname === '/') return `${trimmed}/v1`;
  } catch {
    /* validated in prepare() */
  }
  return trimmed;
}

/** A translation slower than this at warm-up is flagged: it will not keep up with live subtitles. */
export const SLOW_WARMUP_MS = 6000;

export const GEMINI_OPENAI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';
export const GEMINI_DEFAULT_MODEL = 'gemini-3.5-flash-lite';

export function buildSystemPrompt(targetLanguage: string): string {
  const target = TARGET_NAMES[targetLanguage] ?? targetLanguage;
  return `You are a live subtitle translator. Translate the user's text into ${target}. Keep names and terminology consistent with the previous lines when given. Output only the translation: no quotes, no notes, no explanations.`;
}

export class OpenAiCompatibleAdapter implements TranslationAdapter {
  readonly provider: string;
  readonly preferredContextSize = 2;
  private readonly fetchImpl: typeof fetch;

  private readonly baseUrl: string;

  constructor(private readonly config: OpenAiCompatibleConfig) {
    this.provider = config.provider;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.baseUrl = normalizeBaseUrl(config.baseUrl);
  }

  supportsTarget(targetLanguage: string): boolean {
    return targetLanguage in TARGET_NAMES;
  }

  async translate(request: TranslationRequest): Promise<string> {
    if (this.config.limiter) await this.config.limiter.acquire(RATE_LIMIT_MAX_WAIT_MS);
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [{ role: 'system', content: buildSystemPrompt(request.targetLanguage) }];
    for (const c of request.context) {
      messages.push({ role: 'user', content: c.source }, { role: 'assistant', content: c.translated });
    }
    messages.push({ role: 'user', content: request.text });
    const body = JSON.stringify({ model: this.config.model, temperature: this.config.temperature ?? 0.2, max_tokens: this.config.maxTokens ?? 128, messages });
    const url = `${this.baseUrl}/chat/completions`;
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const init: RequestInit = { method: 'POST', headers: { authorization: `Bearer ${this.config.apiKey}`, 'content-type': 'application/json' }, body };
      if (request.signal !== undefined) init.signal = request.signal;
      const res = await this.fetchImpl(url, init);
      if (res.status === 429 || res.status >= 500) {
        // Transient: rate limit / overload. One short retry, then give up on this sentence.
        if (res.status === 429) this.config.limiter?.penalize(COOLDOWN_AFTER_429_MS);
        lastError = new Error(`${this.provider} HTTP ${res.status}`);
        if (attempt === 0) {
          await new Promise((r) => setTimeout(r, 800));
          continue;
        }
        throw lastError;
      }
      if (!res.ok) throw new Error(`${this.provider} HTTP ${res.status}`); // never echo the URL/key
      const json = (await res.json()) as { choices?: Array<{ message?: { content?: string | null } }> };
      const content = json.choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw new Error(`${this.provider}: unexpected response shape`);
      return cleanOutput(content);
    }
    throw lastError ?? new Error(`${this.provider}: failed`);
  }

  async dispose(): Promise<void> {}
}

export function createOpenAiCompatibleFactory(config: OpenAiCompatibleConfig): TranslationAdapterFactory {
  if (config.limiter === undefined && (config.requestsPerMinute ?? 0) > 0) {
    config = { ...config, limiter: new RateLimiter(config.requestsPerMinute ?? 0) };
  }
  return {
    provider: config.provider,
    async prepare() {
      if (!config.apiKey) throw new Error(`translation provider "${config.provider}" requires ${config.envHint} in the backend environment (packages/server/.env)`);
      if (!config.baseUrl || !config.model) throw new Error(`translation provider "${config.provider}" needs a base URL and a model (${config.envHint})`);
      try {
        new URL(config.baseUrl);
      } catch {
        throw new Error(`translation provider "${config.provider}": base URL "${config.baseUrl}" is not a valid URL`);
      }
      // Warm-up doubles as validation: wrong model names, unreachable servers
      // and "thinking" models that take 20 s per sentence show up here, not as
      // silent timeouts during a session.
      const adapter = new OpenAiCompatibleAdapter(config);
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 20_000);
      const t0 = Date.now();
      try {
        const sample = await adapter.translate({ text: 'Hello, welcome.', sourceLanguage: 'en', targetLanguage: 'zh-CN', context: [], signal: ac.signal });
        const ms = Date.now() - t0;
        config.log?.info({ provider: config.provider, model: config.model, ms, sample }, 'translation engine warm-up done');
        if (ms > SLOW_WARMUP_MS) {
          config.log?.warn({ provider: config.provider, model: config.model, ms }, `warm-up took ${ms} ms: this model is too slow for live subtitles; pick a faster model (${config.envHint})`);
        }
        if (sample.length === 0) throw new Error('empty translation');
      } catch (err) {
        const reason = ac.signal.aborted ? 'no answer within 20 s' : err instanceof Error ? err.message : String(err);
        throw new Error(`translation provider "${config.provider}" (model ${config.model}) failed its warm-up: ${reason}. Check ${config.envHint}.`);
      } finally {
        clearTimeout(timer);
      }
    },
    create: () => new OpenAiCompatibleAdapter(config),
  };
}
