import type { TranslationAdapter, TranslationAdapterFactory, TranslationRequest } from './types.js';

/**
 * Google Cloud Translation (v2 REST). The API key lives only in the backend
 * environment (GOOGLE_TRANSLATE_API_KEY) and is never sent to the extension.
 * Free tier: 500k characters / month.
 */
export interface GoogleTranslateConfig {
  apiKey: string;
  fetchImpl?: typeof fetch;
  endpoint?: string;
}

/** Popup codes → Google language codes. */
export function toGoogleLanguage(code: string): string | null {
  const map: Record<string, string> = { 'zh-CN': 'zh-CN', 'zh-TW': 'zh-TW', zh: 'zh-CN', yue: 'zh-TW', en: 'en', ja: 'ja', ko: 'ko', es: 'es', fr: 'fr', de: 'de', pt: 'pt', ru: 'ru', ar: 'ar', hi: 'hi', id: 'id', ms: 'ms', th: 'th', vi: 'vi' };
  return map[code] ?? null;
}

export class GoogleTranslationAdapter implements TranslationAdapter {
  readonly provider = 'google';
  private readonly fetchImpl: typeof fetch;
  private readonly endpoint: string;

  constructor(private readonly config: GoogleTranslateConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.endpoint = config.endpoint ?? 'https://translation.googleapis.com/language/translate/v2';
  }

  supportsTarget(targetLanguage: string): boolean {
    return toGoogleLanguage(targetLanguage) !== null;
  }

  async translate(request: TranslationRequest): Promise<string> {
    const target = toGoogleLanguage(request.targetLanguage);
    if (target === null) throw new Error(`unsupported target language ${request.targetLanguage}`);
    const body: Record<string, unknown> = { q: request.text, target, format: 'text' };
    const source = request.sourceLanguage === 'auto' ? null : toGoogleLanguage(request.sourceLanguage);
    if (source !== null) body['source'] = source;
    const init: RequestInit = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    };
    if (request.signal !== undefined) init.signal = request.signal;
    const res = await this.fetchImpl(`${this.endpoint}?key=${encodeURIComponent(this.config.apiKey)}`, init);
    if (!res.ok) {
      // Never echo the URL (it carries the key) — status text only.
      throw new Error(`Google Translate HTTP ${res.status}`);
    }
    const json = (await res.json()) as { data?: { translations?: Array<{ translatedText?: string }> } };
    const text = json.data?.translations?.[0]?.translatedText;
    if (typeof text !== 'string') throw new Error('Google Translate: unexpected response shape');
    return text;
  }

  async dispose(): Promise<void> {}
}

export function createGoogleTranslationFactory(config: GoogleTranslateConfig): TranslationAdapterFactory {
  return {
    provider: 'google',
    async prepare() {
      if (!config.apiKey) throw new Error('TRANSLATION_PROVIDER=google requires GOOGLE_TRANSLATE_API_KEY in the backend environment (.env)');
    },
    create: () => new GoogleTranslationAdapter(config),
  };
}
