import type { TranslationAdapter, TranslationAdapterFactory, TranslationRequest } from './types.js';

/** Deterministic pseudo-translation for tests and ASR_PROVIDER=mock setups. */
export class MockTranslationAdapter implements TranslationAdapter {
  readonly provider = 'mock';
  constructor(private readonly delayMs = 50) {}
  supportsTarget(): boolean {
    return true;
  }
  translate(request: TranslationRequest): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(`[${request.targetLanguage}] ${request.text}`), this.delayMs);
      request.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new Error('aborted'));
      });
    });
  }
  async dispose(): Promise<void> {}
}

export function createMockTranslationFactory(delayMs = 50): TranslationAdapterFactory {
  return { provider: 'mock', prepare: async () => {}, create: () => new MockTranslationAdapter(delayMs) };
}

/** No translation at all: `session.ready.translation.provider === 'none'`. */
export function createNoneTranslationFactory(): TranslationAdapterFactory {
  return {
    provider: 'none',
    prepare: async () => {},
    create: () => ({
      provider: 'none',
      supportsTarget: () => true,
      translate: async () => '',
      dispose: async () => {},
    }),
  };
}
