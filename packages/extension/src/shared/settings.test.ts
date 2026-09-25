import { describe, expect, it } from 'vitest';
import { AUTO_DETECT, DEFAULT_SETTINGS, DEFAULT_STYLE, SOURCE_LANGUAGES, TARGET_LANGUAGES, languageLabel, normalizeSettings } from './settings.js';
import { SettingsStore, type StorageAreaLike } from './settings-store.js';
import { DEFAULT_BACKEND_URL, backendHealthUrl, backendPermissionOrigins, normalizeBackendUrl } from './settings.js';

function fakeArea(initial: Record<string, unknown> = {}): StorageAreaLike & { data: Record<string, unknown> } {
  const data = { ...initial };
  const listeners = new Set<(changes: Record<string, { newValue?: unknown }>) => void>();
  return {
    data,
    get: async (key) => (key in data ? { [key]: data[key] } : {}),
    set: async (items) => {
      const changes: Record<string, { newValue?: unknown }> = {};
      for (const [k, v] of Object.entries(items)) {
        data[k] = v;
        changes[k] = { newValue: v };
      }
      for (const l of listeners) l(changes);
    },
    onChanged: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

describe('normalizeSettings', () => {
  it('returns defaults for undefined / garbage input', () => {
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings('nope')).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings({ style: 5 })).toEqual(DEFAULT_SETTINGS);
  });
  it('keeps valid values and clamps out-of-range numbers', () => {
    const s = normalizeSettings({ sourceLanguage: 'ja', targetLanguage: 'en', style: { fontSize: 999, position: -5, backgroundOpacity: 0.5, showSource: false } });
    expect(s.sourceLanguage).toBe('ja');
    expect(s.targetLanguage).toBe('en');
    expect(s.style).toEqual({ ...DEFAULT_STYLE, fontSize: 48, position: 0, backgroundOpacity: 0.5, showSource: false, showTranslated: true });
    expect(normalizeSettings({ style: { fontFamily: 'serif', maxLines: 9, outline: true, autoScale: false } }).style).toMatchObject({ fontFamily: 'serif', maxLines: 3, outline: true, autoScale: false });
    expect(normalizeSettings({ style: { fontFamily: 'comic' } }).style.fontFamily).toBe('system');
  });
  it('normalises the translation engine', () => {
    expect(normalizeSettings({ translationEngine: 'google' }).translationEngine).toBe('google');
    expect(normalizeSettings({ translationEngine: 'gemini' }).translationEngine).toBe('gemini');
    expect(normalizeSettings({ translationEngine: 'deepl' }).translationEngine).toBe('hy-mt2');
  });
  it('normalises the session limit to a known choice', () => {
    expect(normalizeSettings({ sessionLimitHours: 6 }).sessionLimitHours).toBe(6);
    expect(normalizeSettings({ sessionLimitHours: 0 }).sessionLimitHours).toBe(0);
    expect(normalizeSettings({ sessionLimitHours: 5 }).sessionLimitHours).toBe(3);
  });
  it('normalises backend URLs and derives permission origins / health URL', () => {
    expect(normalizeBackendUrl('192.168.50.2:8787')).toBe('ws://192.168.50.2:8787/ws');
    expect(normalizeBackendUrl('ws://192.168.50.2:8787/ws')).toBe('ws://192.168.50.2:8787/ws');
    expect(normalizeBackendUrl('wss://sub.example.com')).toBe('wss://sub.example.com/ws');
    expect(normalizeBackendUrl('http://x:1')).toBeNull();
    expect(normalizeBackendUrl('')).toBeNull();
    expect(normalizeSettings({ backendUrl: 'nonsense://' }).backendUrl).toBe(DEFAULT_BACKEND_URL);
    expect(backendPermissionOrigins('ws://192.168.50.2:8787/ws')).toEqual(['http://192.168.50.2:8787/*', 'ws://192.168.50.2:8787/*']);
    expect(backendHealthUrl('ws://192.168.50.2:8787/ws')).toBe('http://192.168.50.2:8787/healthz');
    expect(backendHealthUrl('wss://h.example/ws')).toBe('https://h.example/healthz');
  });
  it('normalises translatePartials to a boolean', () => {
    expect(normalizeSettings({ translatePartials: true }).translatePartials).toBe(true);
    expect(normalizeSettings({ translatePartials: 'yes' }).translatePartials).toBe(false);
  });
  it('rejects unknown languages and never allows auto as a target', () => {
    expect(normalizeSettings({ sourceLanguage: 'xx' }).sourceLanguage).toBe(AUTO_DETECT);
    expect(normalizeSettings({ targetLanguage: AUTO_DETECT }).targetLanguage).toBe(DEFAULT_SETTINGS.targetLanguage);
  });
  it('language lists: source has Auto Detect first, target does not', () => {
    expect(SOURCE_LANGUAGES[0]?.code).toBe(AUTO_DETECT);
    expect(TARGET_LANGUAGES.some((l) => l.code === AUTO_DETECT)).toBe(false);
    expect(languageLabel('zh-CN')).toMatch(/简体中文/);
    expect(languageLabel('zz')).toBe('zz');
  });
});

describe('SettingsStore', () => {
  it('loads defaults from empty storage and persists updates', async () => {
    const area = fakeArea();
    const store = new SettingsStore(area);
    expect(await store.load()).toEqual(DEFAULT_SETTINGS);
    const next = await store.update({ targetLanguage: 'ja', style: { fontSize: 30 } });
    expect(next.targetLanguage).toBe('ja');
    expect(next.style).toEqual({ ...DEFAULT_STYLE, fontSize: 30 });
    expect(await new SettingsStore(area).load()).toEqual(next);
  });
  it('merges style one level deep and validates the result', async () => {
    const store = new SettingsStore(fakeArea());
    await store.update({ style: { showSource: false } });
    const next = await store.update({ style: { fontSize: 1 } });
    expect(next.style.showSource).toBe(false);
    expect(next.style.fontSize).toBe(12);
  });
  it('reset restores defaults and subscribers see every change', async () => {
    const area = fakeArea();
    const store = new SettingsStore(area);
    const seen: number[] = [];
    const unsubscribe = store.subscribe((s) => seen.push(s.style.fontSize));
    await store.update({ style: { fontSize: 20 } });
    await store.reset();
    unsubscribe();
    await store.update({ style: { fontSize: 25 } });
    expect(seen).toEqual([20, DEFAULT_STYLE.fontSize]);
  });
  it('normalizes corrupt stored data on load', async () => {
    const store = new SettingsStore(fakeArea({ settings: { version: 0, targetLanguage: 'bogus', style: { fontSize: 'big' } } }));
    expect(await store.load()).toEqual(DEFAULT_SETTINGS);
  });
});
