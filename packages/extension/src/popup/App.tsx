import { useCallback, useEffect, useState } from 'react';
import type { ContentDetectResponse, OkResponse, PopupCapture, PopupToBackground, SessionSnapshot, ToContent } from '../shared/messages.js';
import { detectPlatformFromUrl, type Platform } from '../shared/platform.js';
import { describeCaptureError } from '../shared/capture-error.js';
import { SettingsStore } from '../shared/settings-store.js';
import { DEFAULT_SETTINGS, SOURCE_LANGUAGES, STYLE_LIMITS, TARGET_LANGUAGES, languageLabel, normalizeSettings, type Settings, type SubtitleStyle } from '../shared/settings.js';

const POLL_MS = 250;
const settingsStore = new SettingsStore();

async function askBackground<R>(message: PopupToBackground): Promise<R> {
  return (await chrome.runtime.sendMessage(message)) as R;
}

interface TabInfo {
  platform: Platform | null;
  playerFound: boolean;
  contentLoaded: boolean;
}

async function inspectActiveTab(): Promise<TabInfo> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const platform = detectPlatformFromUrl(tab?.url);
  if (platform === null || tab?.id === undefined) return { platform: null, playerFound: false, contentLoaded: false };
  try {
    const message: ToContent = { target: 'content', type: 'content.detect' };
    const response = (await chrome.tabs.sendMessage(tab.id, message)) as ContentDetectResponse | undefined;
    return { platform, playerFound: response?.playerFound ?? false, contentLoaded: response !== undefined };
  } catch {
    return { platform, playerFound: false, contentLoaded: false };
  }
}

/** The popup is where the user invoked the extension, so the tabCapture stream id is requested here. */
async function obtainCapture(): Promise<PopupCapture> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id === undefined) throw new Error('No active tab in this window.');
  try {
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    return { tabId: tab.id, streamId };
  } catch (err) {
    throw new Error(`${describeCaptureError(err, tab.id, 'popup')} [tab url: ${tab.url ?? 'unknown'}, window ${tab.windowId}]`);
  }
}

type StatusKind = 'ready' | 'translating' | 'busy' | 'error';

function statusOf(snapshot: SessionSnapshot | null, error: string | null): { kind: StatusKind; label: string } {
  const status = snapshot?.status ?? 'idle';
  if (status === 'active') return { kind: 'translating', label: 'Translating' };
  if (status === 'starting') return { kind: 'busy', label: 'Starting' };
  if (status === 'stopping') return { kind: 'busy', label: 'Stopping' };
  if (error || snapshot?.lastError) return { kind: 'error', label: 'Error' };
  return { kind: 'ready', label: 'Ready' };
}

function tabHint(tab: TabInfo | null): string {
  if (tab === null) return '正在检测当前标签页…';
  if (tab.platform === null) return '打开 YouTube · Twitch 的影片页后按开始字幕。';
  if (!tab.contentLoaded) return '页面需要刷新一次，扩展才能在这个标签页工作。';
  if (!tab.playerFound) return `已在 ${tab.platform} 页面，但没有找到播放器，请先打开一个影片。`;
  return tab.platform === 'twitch' ? 'Twitch 播放器已检测到（音频捕获将在后续阶段验证）。' : 'YouTube 播放器已就绪，可以开始字幕。';
}

export function App() {
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  const [tab, setTab] = useState<TabInfo | null>(null);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [styleOpen, setStyleOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setSnapshot(await askBackground<SessionSnapshot>({ target: 'background', type: 'popup.getStatus' }));
    } catch (err) {
      setError(`Background unreachable: ${String(err)}`);
    }
  }, []);

  useEffect(() => {
    let ticks = 0;
    const tick = () => {
      void refresh();
      if (ticks++ % 4 === 0) void inspectActiveTab().then(setTab);
    };
    const initial = setTimeout(() => {
      tick();
      void settingsStore.load().then(setSettings);
    }, 0);
    const timer = setInterval(tick, POLL_MS);
    const unsubscribe = settingsStore.subscribe(setSettings);
    return () => {
      clearTimeout(initial);
      clearInterval(timer);
      unsubscribe();
    };
  }, [refresh]);

  // Optimistic: reflect the change in the UI at once, then persist; the
  // storage.onChanged subscription reconciles with what was actually stored.
  const updateSettings = (patch: Parameters<SettingsStore['update']>[0]) => {
    setSettings((current) => normalizeSettings({ ...current, ...patch, style: { ...current.style, ...(patch.style ?? {}) } }));
    void settingsStore.update(patch).then(setSettings);
  };
  const updateStyle = (patch: Partial<SubtitleStyle>) => updateSettings({ style: patch });

  const run = async (type: 'popup.start' | 'popup.stop') => {
    setBusy(true);
    setError(null);
    try {
      const result =
        type === 'popup.start'
          ? await askBackground<OkResponse>({ target: 'background', type, capture: await obtainCapture() })
          : await askBackground<OkResponse>({ target: 'background', type });
      if (!result.ok) setError(result.error);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      void refresh();
      void inspectActiveTab().then(setTab);
    }
  };

  const sessionStatus = snapshot?.status ?? 'idle';
  const isActive = sessionStatus === 'active';
  const status = statusOf(snapshot, error);
  const canStart = sessionStatus === 'idle' && !busy && tab?.platform !== null && tab?.playerFound === true;
  const canStop = (isActive || sessionStatus === 'starting') && !busy;
  const shownError = error ?? (sessionStatus === 'idle' ? snapshot?.lastError : undefined);
  const languagesPending =
    isActive &&
    snapshot !== null &&
    (snapshot.sourceLanguage !== settings.sourceLanguage ||
      snapshot.targetLanguage !== settings.targetLanguage ||
      (snapshot.translatePartials !== undefined && snapshot.translatePartials !== settings.translatePartials));
  const providerName = (p: string | undefined) => (p === 'sensevoice' ? 'SenseVoice' : p === 'hy-mt2' ? 'Hy-MT2' : p === 'google' ? 'Google' : p === 'none' ? '无' : p ?? '…');

  return (
    <div className="app">
      <header className="header">
        <img className="logo" src="icons/icon48.png" alt="" />
        <div className="title">
          <h1>N Sub</h1>
          <p>即时双语字幕</p>
        </div>
        <span className={`status ${status.kind}`} aria-live="polite">
          <span className="dot" /> {status.label}
        </span>
      </header>

      <section className="card">
        <div className="languages">
          <div className="field">
            <label htmlFor="source">来源</label>
            <select id="source" value={settings.sourceLanguage} onChange={(e) => updateSettings({ sourceLanguage: e.target.value })}>
              {SOURCE_LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label}
                </option>
              ))}
            </select>
          </div>
          <div className="arrow">→</div>
          <div className="field">
            <label htmlFor="target">翻译成</label>
            <select id="target" value={settings.targetLanguage} onChange={(e) => updateSettings({ targetLanguage: e.target.value })}>
              {TARGET_LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        <label className="check subtle">
          <input type="checkbox" checked={settings.translatePartials} onChange={(e) => updateSettings({ translatePartials: e.target.checked })} /> 边说边翻译（未说完的句子也翻译，较耗 CPU；下次开始时生效）
        </label>
        {languagesPending && snapshot && (
          <div className="pending">
            当前会话仍使用 {languageLabel(snapshot.sourceLanguage ?? '')} → {languageLabel(snapshot.targetLanguage ?? '')}，新语言将在下次开始时生效。
          </div>
        )}
        <div className="actions">
          {isActive ? (
            <button className="btn primary running" disabled>
              ● 正在翻译
            </button>
          ) : (
            <button className="btn primary" disabled={!canStart} onClick={() => void run('popup.start')}>
              ▶ 开始字幕
            </button>
          )}
          {isActive && (
            <>
              <div className="level" aria-label="audio level">
                <div style={{ width: `${Math.min(100, Math.round((snapshot?.audioLevel ?? 0) * 300))}%` }} />
              </div>
              <div className="asr-line">
                {snapshot?.connection === 'reconnecting'
                  ? '正在重新连接本地后端…'
                  : `识别 ${providerName(snapshot?.asr?.provider)} · ${snapshot?.asr?.language === 'auto' ? '自动检测' : snapshot?.asr?.language ?? ''}${
                      snapshot?.metrics ? ` · ${(snapshot.metrics.avgLatencyMs / 1000).toFixed(1)} s` : ''
                    }  ｜  翻译 ${providerName(snapshot?.translation?.provider)}${
                      snapshot?.metrics && snapshot.metrics.translated > 0 ? ` · ${(snapshot.metrics.avgTranslateMs / 1000).toFixed(1)} s` : ''
                    }${snapshot?.metrics && snapshot.metrics.translationBacklog > 1 ? ` · 排队 ${snapshot.metrics.translationBacklog}` : ''}`}
              </div>
            </>
          )}
          <button className="btn secondary" disabled={!canStop} onClick={() => void run('popup.stop')}>
            停止
          </button>
        </div>
      </section>

      {shownError ? <div className="card error-card">{shownError}</div> : <div className="card hint">{tabHint(tab)}</div>}

      <section className="card">
        <button className={`section-toggle ${styleOpen ? 'open' : ''}`} onClick={() => setStyleOpen((o) => !o)} aria-expanded={styleOpen}>
          <span>字幕样式</span>
          <span className="chev">›</span>
        </button>
        {styleOpen && (
          <div className="style-grid">
            <label className="slider">
              <span>字体大小</span>
              <input type="range" min={STYLE_LIMITS.fontSize.min} max={STYLE_LIMITS.fontSize.max} step={STYLE_LIMITS.fontSize.step} value={settings.style.fontSize} onChange={(e) => updateStyle({ fontSize: Number(e.target.value) })} />
              <span className="val">{settings.style.fontSize}px</span>
            </label>
            <label className="slider">
              <span>字幕位置</span>
              <input type="range" min={STYLE_LIMITS.position.min} max={STYLE_LIMITS.position.max} step={STYLE_LIMITS.position.step} value={settings.style.position} onChange={(e) => updateStyle({ position: Number(e.target.value) })} />
              <span className="val">{settings.style.position}%</span>
            </label>
            <label className="slider">
              <span>背景透明度</span>
              <input type="range" min={STYLE_LIMITS.backgroundOpacity.min} max={STYLE_LIMITS.backgroundOpacity.max} step={STYLE_LIMITS.backgroundOpacity.step} value={settings.style.backgroundOpacity} onChange={(e) => updateStyle({ backgroundOpacity: Number(e.target.value) })} />
              <span className="val">{Math.round(settings.style.backgroundOpacity * 100)}%</span>
            </label>
            <label className="check">
              <input type="checkbox" checked={settings.style.showSource} onChange={(e) => updateStyle({ showSource: e.target.checked })} /> 显示原文
            </label>
            <label className="check">
              <input type="checkbox" checked={settings.style.showTranslated} onChange={(e) => updateStyle({ showTranslated: e.target.checked })} /> 显示翻译
            </label>
            <button className="btn reset" onClick={() => void settingsStore.reset().then(setSettings)}>
              恢复默认
            </button>
          </div>
        )}
      </section>

      <div className="footer">本地后端 · 本机语音识别与翻译</div>
    </div>
  );
}
