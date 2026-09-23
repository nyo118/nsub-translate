export interface TranslationContextItem {
  source: string;
  translated: string;
}

export interface TranslationRequest {
  text: string;
  /** "auto" or a language code detected by the recognizer (e.g. "en", "ja"). */
  sourceLanguage: string;
  /** Popup target code, e.g. "zh-CN", "zh-TW", "en". */
  targetLanguage: string;
  /** Previous finals (source + translation), oldest first, for consistency. */
  context: TranslationContextItem[];
  signal?: AbortSignal;
}

/**
 * Text translation provider. One instance per session. Must be safe to call
 * sequentially; the pipeline never issues concurrent translate() calls to
 * the same adapter.
 */
export interface TranslationAdapter {
  readonly provider: string;
  /** Whether this target language is supported; unsupported targets fail the session start. */
  supportsTarget(targetLanguage: string): boolean;
  translate(request: TranslationRequest): Promise<string>;
  dispose(): Promise<void>;
}

export interface TranslationAdapterFactory {
  readonly provider: string;
  /** Called at startup; may load a model. Throws with an actionable message if unusable. */
  prepare(): Promise<void>;
  create(): TranslationAdapter;
}
