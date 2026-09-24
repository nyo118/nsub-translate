import type { TranslationAdapter, TranslationAdapterFactory, TranslationRequest } from './types.js';
import { TARGET_NAMES, cleanOutput } from './text-utils.js';

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
}

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

  constructor(private readonly config: OpenAiCompatibleConfig) {
    this.provider = config.provider;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  supportsTarget(targetLanguage: string): boolean {
    return targetLanguage in TARGET_NAMES;
  }

  async translate(request: TranslationRequest): Promise<string> {
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [{ role: 'system', content: buildSystemPrompt(request.targetLanguage) }];
    for (const c of request.context) {
      messages.push({ role: 'user', content: c.source }, { role: 'assistant', content: c.translated });
    }
    messages.push({ role: 'user', content: request.text });
    const body = JSON.stringify({ model: this.config.model, temperature: this.config.temperature ?? 0.2, max_tokens: this.config.maxTokens ?? 128, messages });
    const url = `${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`;
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const init: RequestInit = { method: 'POST', headers: { authorization: `Bearer ${this.config.apiKey}`, 'content-type': 'application/json' }, body };
      if (request.signal !== undefined) init.signal = request.signal;
      const res = await this.fetchImpl(url, init);
      if (res.status === 429 || res.status >= 500) {
        // Transient: rate limit / overload. One short retry, then give up on this sentence.
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
  return {
    provider: config.provider,
    async prepare() {
      if (!config.apiKey) throw new Error(`translation provider "${config.provider}" requires ${config.envHint} in the backend environment (packages/server/.env)`);
      if (!config.baseUrl || !config.model) throw new Error(`translation provider "${config.provider}" needs a base URL and a model (${config.envHint})`);
    },
    create: () => new OpenAiCompatibleAdapter(config),
  };
}
