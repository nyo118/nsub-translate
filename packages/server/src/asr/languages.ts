/** SenseVoice-Small supports these; anything else falls back to in-model auto detection. */
export const SENSEVOICE_LANGUAGES = ['auto', 'zh', 'en', 'ja', 'ko', 'yue'] as const;
export type SenseVoiceLanguage = (typeof SENSEVOICE_LANGUAGES)[number];

/** Map a popup language code (BCP-47-ish) to a SenseVoice language id. */
export function toSenseVoiceLanguage(code: string): SenseVoiceLanguage {
  const lower = code.toLowerCase();
  if (lower === 'auto') return 'auto';
  if (lower === 'yue' || lower === 'zh-hk') return 'yue';
  const base = lower.split('-')[0] ?? lower;
  return (SENSEVOICE_LANGUAGES as readonly string[]).includes(base) ? (base as SenseVoiceLanguage) : 'auto';
}

/** SenseVoice reports "<|en|>" style tags; normalise to plain codes. */
export function normalizeDetectedLanguage(tag: string | undefined): string | undefined {
  if (!tag) return undefined;
  const m = /^<\|([a-z]+)\|>$/i.exec(tag.trim());
  return (m?.[1] ?? tag).toLowerCase();
}
