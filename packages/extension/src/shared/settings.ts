/**
 * User settings (Phase 1). Persisted in chrome.storage.local under one key.
 * `normalizeSettings` is the single place that validates, clamps and
 * migrates whatever is found in storage, so the rest of the code can trust
 * the shape.
 */

export const SETTINGS_VERSION = 1 as const;
export const SETTINGS_STORAGE_KEY = 'settings';

export const AUTO_DETECT = 'auto';

export interface LanguageOption {
  code: string;
  /** Native name + code, e.g. "简体中文 (zh-CN)"; kept short so it fits the popup selects. */
  label: string;
}

/** Curated list. Providers in later phases filter it by their capabilities. */
export const TARGET_LANGUAGES: readonly LanguageOption[] = [
  { code: 'zh-CN', label: '简体中文 (zh-CN)' },
  { code: 'zh-TW', label: '繁體中文 (zh-TW)' },
  { code: 'en', label: 'English (en)' },
  { code: 'ja', label: '日本語 (ja)' },
  { code: 'ko', label: '한국어 (ko)' },
  { code: 'es', label: 'Español (es)' },
  { code: 'fr', label: 'Français (fr)' },
  { code: 'de', label: 'Deutsch (de)' },
  { code: 'pt', label: 'Português (pt)' },
  { code: 'ru', label: 'Русский (ru)' },
  { code: 'ar', label: 'العربية (ar)' },
  { code: 'hi', label: 'हिन्दी (hi)' },
  { code: 'id', label: 'Indonesia (id)' },
  { code: 'ms', label: 'Melayu (ms)' },
  { code: 'th', label: 'ไทย (th)' },
  { code: 'vi', label: 'Tiếng Việt (vi)' },
];

export const SOURCE_LANGUAGES: readonly LanguageOption[] = [
  { code: AUTO_DETECT, label: '自动检测 (auto)' },
  ...TARGET_LANGUAGES,
];

export interface SubtitleStyle {
  /** Font size of the translated line in px; the source line is ~10% smaller. */
  fontSize: number;
  /** Distance from the bottom of the player, in percent of player height. */
  position: number;
  /** 0 = transparent box, 1 = solid black. */
  backgroundOpacity: number;
  showSource: boolean;
  showTranslated: boolean;
}

export interface Settings {
  version: typeof SETTINGS_VERSION;
  sourceLanguage: string;
  targetLanguage: string;
  /** Also translate in-progress sentences (more CPU). Applies on next start. */
  translatePartials: boolean;
  style: SubtitleStyle;
}

export const STYLE_LIMITS = {
  fontSize: { min: 12, max: 48, step: 1 },
  position: { min: 0, max: 60, step: 1 },
  backgroundOpacity: { min: 0, max: 1, step: 0.05 },
} as const;

export const DEFAULT_STYLE: SubtitleStyle = {
  fontSize: 22,
  position: 10,
  backgroundOpacity: 0.72,
  showSource: true,
  showTranslated: true,
};

export const DEFAULT_SETTINGS: Settings = {
  version: SETTINGS_VERSION,
  sourceLanguage: AUTO_DETECT,
  targetLanguage: 'zh-CN',
  translatePartials: false,
  style: { ...DEFAULT_STYLE },
};

function clamp(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function language(value: unknown, allowed: readonly LanguageOption[], fallback: string): string {
  return typeof value === 'string' && allowed.some((l) => l.code === value) ? value : fallback;
}

/** Accepts anything (undefined, partial, old versions) and returns valid settings. */
export function normalizeSettings(raw: unknown): Settings {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const s = (typeof r['style'] === 'object' && r['style'] !== null ? r['style'] : {}) as Record<string, unknown>;
  return {
    version: SETTINGS_VERSION,
    sourceLanguage: language(r['sourceLanguage'], SOURCE_LANGUAGES, DEFAULT_SETTINGS.sourceLanguage),
    targetLanguage: language(r['targetLanguage'], TARGET_LANGUAGES, DEFAULT_SETTINGS.targetLanguage),
    translatePartials: bool(r['translatePartials'], DEFAULT_SETTINGS.translatePartials),
    style: {
      fontSize: clamp(s['fontSize'], DEFAULT_STYLE.fontSize, STYLE_LIMITS.fontSize.min, STYLE_LIMITS.fontSize.max),
      position: clamp(s['position'], DEFAULT_STYLE.position, STYLE_LIMITS.position.min, STYLE_LIMITS.position.max),
      backgroundOpacity: clamp(s['backgroundOpacity'], DEFAULT_STYLE.backgroundOpacity, STYLE_LIMITS.backgroundOpacity.min, STYLE_LIMITS.backgroundOpacity.max),
      showSource: bool(s['showSource'], DEFAULT_STYLE.showSource),
      showTranslated: bool(s['showTranslated'], DEFAULT_STYLE.showTranslated),
    },
  };
}

export function languageLabel(code: string): string {
  return SOURCE_LANGUAGES.find((l) => l.code === code)?.label ?? code;
}
