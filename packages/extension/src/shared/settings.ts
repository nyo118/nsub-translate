/**
 * User settings (Phase 1). Persisted in chrome.storage.local under one key.
 * `normalizeSettings` is the single place that validates, clamps and
 * migrates whatever is found in storage, so the rest of the code can trust
 * the shape.
 */

import { OVERLAP_MODES, type DenoiserName, type OverlapMode } from '@lst/protocol';

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

export type FontFamilyChoice = 'system' | 'sans' | 'serif' | 'rounded' | 'mono';

export const FONT_FAMILIES: ReadonlyArray<{ code: FontFamilyChoice; label: string; css: string }> = [
  { code: 'system', label: '系统默认', css: '"Helvetica Neue", Arial, "PingFang SC", "Hiragino Sans", "Microsoft YaHei", sans-serif' },
  { code: 'sans', label: '无衬线（Noto/思源黑）', css: '"Noto Sans CJK SC", "Source Han Sans SC", "PingFang SC", "Hiragino Sans", sans-serif' },
  { code: 'serif', label: '衬线（宋体/明朝）', css: '"Noto Serif CJK SC", "Source Han Serif SC", "Songti SC", "Hiragino Mincho ProN", serif' },
  { code: 'rounded', label: '圆体', css: '"Yuanti SC", "Hiragino Maru Gothic ProN", "Varela Round", "PingFang SC", sans-serif' },
  { code: 'mono', label: '等宽', css: 'ui-monospace, Menlo, "SF Mono", "PingFang SC", monospace' },
];

export interface SubtitleStyle {
  /** Font size of the translated line in px at a 1280 px wide player; the source line is ~10% smaller. */
  fontSize: number;
  /** Distance from the bottom of the player, in percent of player height. */
  position: number;
  /** 0 = transparent box, 1 = solid black. */
  backgroundOpacity: number;
  showSource: boolean;
  showTranslated: boolean;
  /** Scale the font with the player width (fullscreen bigger, mini-player smaller). */
  autoScale: boolean;
  /** Dark outline around glyphs for busy backgrounds. */
  outline: boolean;
  fontFamily: FontFamilyChoice;
  /** Maximum wrapped lines per text row (source / translated) before clamping. */
  maxLines: number;
  /** Move the subtitles up while the player's control bar is visible. */
  avoidControls: boolean;
}

export type TranslationEngine = 'hy-mt2' | 'gemini' | 'llm' | 'google';

export const TRANSLATION_ENGINES: ReadonlyArray<{ code: TranslationEngine; label: string; hint: string }> = [
  { code: 'gemini', label: 'Gemini（AI Studio 免费层）', hint: '约 1 s 一句、质量好；需在后端 packages/server/.env 设置 GEMINI_API_KEY（AI Studio 免费获取，无需绑卡）。' },
  { code: 'hy-mt2', label: '本机 AI 翻译（Hy-MT2）', hint: '免费、离线，速度取决于电脑性能（约 2–5 s 一句）。' },
  { code: 'llm', label: '自定义 LLM（OpenAI 兼容）', hint: 'Groq / OpenRouter / Ollama 等；需在后端 .env 设置 LLM_BASE_URL、LLM_API_KEY、LLM_MODEL。' },
  { code: 'google', label: 'Google 翻译 API', hint: '需 GCP 账号与 billing；后端 .env 设置 GOOGLE_TRANSLATE_API_KEY。' },
];

export interface Settings {
  version: typeof SETTINGS_VERSION;
  sourceLanguage: string;
  targetLanguage: string;
  /** Translation engine, sent to the backend at start. */
  translationEngine: TranslationEngine;
  /** Also translate in-progress sentences (more CPU). Applies on next start. */
  translatePartials: boolean;
  /** While the player shows an ad, keep recognising but do not translate. Applies immediately. */
  skipAdTranslation: boolean;
  /** Auto-stop after this many hours (0 = never). Applies on next start. */
  sessionLimitHours: number;
  /** Multi-voice handling (0.2.0), all off by default; applies on next start. */
  denoise: boolean;
  /** Denoiser strength (0.3.0): auto = backend default, light = GTCRN, medium/strong = DPDFNet (more CPU). */
  denoiseStrength: DenoiseStrength;
  diarize: boolean;
  overlap: OverlapMode;
  /** WebSocket URL of the backend (default: local). A LAN backend needs an optional host permission. */
  backendUrl: string;
  style: SubtitleStyle;
}

export const DEFAULT_BACKEND_URL = 'ws://127.0.0.1:8787/ws';

export type DenoiseStrength = 'auto' | 'light' | 'medium' | 'strong';
export const DENOISE_STRENGTHS: ReadonlyArray<{ code: DenoiseStrength; label: string; denoiser?: DenoiserName }> = [
  { code: 'auto', label: '后端默认' },
  { code: 'light', label: '轻（GTCRN，最省 CPU）', denoiser: 'gtcrn' },
  { code: 'medium', label: '中（DPDFNet2）', denoiser: 'dpdfnet2' },
  { code: 'strong', label: '强（DPDFNet8，最耗 CPU）', denoiser: 'dpdfnet8' },
];
/** Backend denoiser name for a strength choice; undefined = let the backend pick. */
export function denoiserFor(strength: DenoiseStrength): DenoiserName | undefined {
  return DENOISE_STRENGTHS.find((s) => s.code === strength)?.denoiser;
}

export const OVERLAP_CHOICES: ReadonlyArray<{ code: OverlapMode; label: string }> = [
  { code: 'mark', label: '标记「多人同时说话」' },
  { code: 'skip', label: '跳过不显示' },
  { code: 'recognize', label: '照常识别（文字可能混杂）' },
];

/** True for a backend on this machine (denoise/diarize cost CPU that a laptop may not have). */
export function isLocalBackend(backendUrl: string): boolean {
  try {
    return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(backendUrl).hostname);
  } catch {
    return true;
  }
}

/** Validate/normalise a backend URL: ws:// or wss://, host + optional port, path forced to /ws. */
export function normalizeBackendUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let text = raw.trim();
  if (text === '') return null;
  if (!/^[a-z]+:\/\//i.test(text)) text = `ws://${text}`;
  try {
    const u = new URL(text);
    if (u.protocol !== 'ws:' && u.protocol !== 'wss:') return null;
    if (u.hostname === '') return null;
    return `${u.protocol}//${u.host}/ws`;
  } catch {
    return null;
  }
}

/** http(s) origin pattern + ws(s) pattern the extension must hold to talk to this backend. */
export function backendPermissionOrigins(backendUrl: string): string[] {
  const u = new URL(backendUrl);
  const http = u.protocol === 'wss:' ? 'https' : 'http';
  return [`${http}://${u.host}/*`, `${u.protocol}//${u.host}/*`];
}

/** /healthz endpoint for a backend WebSocket URL. */
export function backendHealthUrl(backendUrl: string): string {
  const u = new URL(backendUrl);
  return `${u.protocol === 'wss:' ? 'https' : 'http'}://${u.host}/healthz`;
}

export const SESSION_LIMIT_CHOICES: ReadonlyArray<{ hours: number; label: string }> = [
  { hours: 1, label: '1 小时' },
  { hours: 2, label: '2 小时' },
  { hours: 3, label: '3 小时' },
  { hours: 6, label: '6 小时' },
  { hours: 0, label: '不限制' },
];

export const STYLE_LIMITS = {
  fontSize: { min: 12, max: 48, step: 1 },
  position: { min: 0, max: 60, step: 1 },
  backgroundOpacity: { min: 0, max: 1, step: 0.05 },
  maxLines: { min: 1, max: 3, step: 1 },
} as const;

export const DEFAULT_STYLE: SubtitleStyle = {
  fontSize: 22,
  position: 10,
  backgroundOpacity: 0.72,
  showSource: true,
  showTranslated: true,
  autoScale: true,
  outline: false,
  fontFamily: 'system',
  maxLines: 2,
  avoidControls: true,
};

export const DEFAULT_SETTINGS: Settings = {
  version: SETTINGS_VERSION,
  sourceLanguage: AUTO_DETECT,
  targetLanguage: 'zh-CN',
  translationEngine: 'hy-mt2',
  translatePartials: false,
  skipAdTranslation: true,
  sessionLimitHours: 3,
  denoise: false,
  denoiseStrength: 'auto',
  diarize: false,
  overlap: 'mark',
  backendUrl: DEFAULT_BACKEND_URL,
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
    translationEngine: TRANSLATION_ENGINES.some((e) => e.code === r['translationEngine']) ? (r['translationEngine'] as TranslationEngine) : DEFAULT_SETTINGS.translationEngine,
    translatePartials: bool(r['translatePartials'], DEFAULT_SETTINGS.translatePartials),
    skipAdTranslation: bool(r['skipAdTranslation'], DEFAULT_SETTINGS.skipAdTranslation),
    sessionLimitHours: SESSION_LIMIT_CHOICES.some((c) => c.hours === r['sessionLimitHours']) ? (r['sessionLimitHours'] as number) : DEFAULT_SETTINGS.sessionLimitHours,
    denoise: bool(r['denoise'], DEFAULT_SETTINGS.denoise),
    denoiseStrength: DENOISE_STRENGTHS.some((s) => s.code === r['denoiseStrength']) ? (r['denoiseStrength'] as DenoiseStrength) : DEFAULT_SETTINGS.denoiseStrength,
    diarize: bool(r['diarize'], DEFAULT_SETTINGS.diarize),
    overlap: OVERLAP_MODES.includes(r['overlap'] as OverlapMode) ? (r['overlap'] as OverlapMode) : DEFAULT_SETTINGS.overlap,
    backendUrl: normalizeBackendUrl(r['backendUrl']) ?? DEFAULT_BACKEND_URL,
    style: {
      fontSize: clamp(s['fontSize'], DEFAULT_STYLE.fontSize, STYLE_LIMITS.fontSize.min, STYLE_LIMITS.fontSize.max),
      position: clamp(s['position'], DEFAULT_STYLE.position, STYLE_LIMITS.position.min, STYLE_LIMITS.position.max),
      backgroundOpacity: clamp(s['backgroundOpacity'], DEFAULT_STYLE.backgroundOpacity, STYLE_LIMITS.backgroundOpacity.min, STYLE_LIMITS.backgroundOpacity.max),
      showSource: bool(s['showSource'], DEFAULT_STYLE.showSource),
      showTranslated: bool(s['showTranslated'], DEFAULT_STYLE.showTranslated),
      autoScale: bool(s['autoScale'], DEFAULT_STYLE.autoScale),
      outline: bool(s['outline'], DEFAULT_STYLE.outline),
      fontFamily: FONT_FAMILIES.some((f) => f.code === s['fontFamily']) ? (s['fontFamily'] as FontFamilyChoice) : DEFAULT_STYLE.fontFamily,
      maxLines: Math.round(clamp(s['maxLines'], DEFAULT_STYLE.maxLines, STYLE_LIMITS.maxLines.min, STYLE_LIMITS.maxLines.max)),
      avoidControls: bool(s['avoidControls'], DEFAULT_STYLE.avoidControls),
    },
  };
}

export function languageLabel(code: string): string {
  return SOURCE_LANGUAGES.find((l) => l.code === code)?.label ?? code;
}
