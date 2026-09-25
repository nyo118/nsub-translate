import { useCallback, useEffect, useRef, useState } from 'react';
import type { ContentDetectResponse, OkResponse, PopupCapture, PopupToBackground, SessionSnapshot, ToContent } from '../shared/messages.js';
import { detectPlatformFromUrl, type Platform } from '../shared/platform.js';
import { describeCaptureError } from '../shared/capture-error.js';
import { SettingsStore } from '../shared/settings-store.js';
import { DEFAULT_SETTINGS, FONT_FAMILIES, SESSION_LIMIT_CHOICES, SOURCE_LANGUAGES, STYLE_LIMITS, TARGET_LANGUAGES, TRANSLATION_ENGINES, languageLabel, normalizeSettings, type FontFamilyChoice, type Settings, type SubtitleStyle, type TranslationEngine } from '../shared/settings.js';
import { friendlyError } from '../shared/friendly-error.js';
import { BACKEND_WS_URL } from '../shared/config.js';

/** /healthz of the local backend (host permission: http://127.0.0.1:8787/*). */
const HEALTHZ_URL = BACKEND_WS_URL.replace(/^ws:/, 'http:').replace(/\/ws$/, '/healthz');
const HEALTH_POLL_MS = 3000;

interface EngineStatus {
  configured: boolean;
  ready: boolean;
  hint?: string;
}
interface BackendHealth {
  ok: boolean;
  uptimeSec?: number;
  activeSessions?: number;
  asrProvider?: string;
  translationProvider?: string;
  engines?: Record<string, EngineStatus>;
}
type BackendState = { kind: 'unknown' } | { kind: 'down'; error: string } | { kind: 'up'; health: BackendHealth };

async function fetchHealth(): Promise<BackendState> {
  try {
    const res = await fetch(HEALTHZ_URL, { cache: 'no-store' });
    if (!res.ok) return { kind: 'down', error: `HTTP ${res.status}` };
    return { kind: 'up', health: (await res.json()) as BackendHealth };
  } catch (err) {
    return { kind: 'down', error: err instanceof Error ? err.message : String(err) };
  }
}

function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

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
  const [diagOpen, setDiagOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [backend, setBackend] = useState<BackendState>({ kind: 'unknown' });
  const [copied, setCopied] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  // The service worker may still be waking up when the popup opens; only
  // report it as unreachable after several consecutive failures.
  const failures = useRef(0);
  const refresh = useCallback(async () => {
    try {
      setSnapshot(await askBackground<SessionSnapshot>({ target: 'background', type: 'popup.getStatus' }));
      failures.current = 0;
    } catch (err) {
      failures.current += 1;
      if (failures.current >= 3) setError(`Background unreachable: ${String(err)}`);
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
      void fetchHealth().then(setBackend);
    }, 0);
    const timer = setInterval(tick, POLL_MS);
    const health = setInterval(() => {
      void fetchHealth().then(setBackend);
      setNowMs(Date.now());
    }, HEALTH_POLL_MS);
    const unsubscribe = settingsStore.subscribe(setSettings);
    return () => {
      clearTimeout(initial);
      clearInterval(timer);
      clearInterval(health);
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
  const backendDown = backend.kind === 'down';
  const canStart = sessionStatus === 'idle' && !busy && tab?.platform !== null && tab?.playerFound === true && !backendDown;
  const canStop = (isActive || sessionStatus === 'starting') && !busy;
  const rawError = error ?? (sessionStatus === 'idle' ? snapshot?.lastError : undefined);
  const shownError = rawError === undefined ? undefined : friendlyError(rawError);
  const engineStatus = backend.kind === 'up' ? backend.health.engines?.[settings.translationEngine] : undefined;
  const engineUnavailable = engineStatus !== undefined && !engineStatus.configured;
  const uptime = snapshot?.startedAt !== undefined && isActive ? formatDuration(nowMs - snapshot.startedAt) : null;
  // Real-world hints: the local translator cannot keep up / auto-detect keeps flipping.
  const slowTranslation = isActive && snapshot?.metrics !== undefined && snapshot.metrics.finals >= 5 && (snapshot.metrics.translationCoverage < 0.6 || snapshot.metrics.avgTranslateMs > 5000) && snapshot.translation?.provider === 'hy-mt2';
  const languageFlipping = isActive && (snapshot?.sourceLanguage === 'auto') && (snapshot?.detectedLanguages?.length ?? 0) >= 2;

  const diagnostics = {
    time: new Date().toISOString(),
    extension: chrome.runtime.getManifest().version,
    backend: backend.kind === 'up' ? { ...backend.health } : backend,
    session: snapshot,
    settings: { ...settings, style: undefined },
    tab,
    lastError: rawError ?? null,
    userAgent: navigator.userAgent,
  };
  const copyDiagnostics = () => {
    void navigator.clipboard.writeText(JSON.stringify(diagnostics, null, 2)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  const languagesPending =
    isActive &&
    snapshot !== null &&
    (snapshot.sourceLanguage !== settings.sourceLanguage ||
      snapshot.targetLanguage !== settings.targetLanguage ||
      (snapshot.translatePartials !== undefined && snapshot.translatePartials !== settings.translatePartials) ||
      (snapshot.translation !== undefined && snapshot.translation.provider !== settings.translationEngine));
  const providerName = (p: string | undefined) =>
    p === 'sensevoice' ? 'SenseVoice' : p === 'hy-mt2' ? 'Hy-MT2' : p === 'gemini' ? 'Gemini' : p === 'llm' ? 'LLM' : p === 'google' ? 'Google' : p === 'none' ? '无' : p ?? '…';

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
        <div className="field">
          <label htmlFor="engine">翻译引擎</label>
          <select id="engine" value={settings.translationEngine} onChange={(e) => updateSettings({ translationEngine: e.target.value as TranslationEngine })}>
            {TRANSLATION_ENGINES.map((e) => (
              <option key={e.code} value={e.code}>
                {e.label}
              </option>
            ))}
          </select>
          <div className={`field-hint ${engineUnavailable ? 'warn' : ''}`}>
            {engineUnavailable ? `后端未配置此引擎：${engineStatus?.hint ?? ''}` : TRANSLATION_ENGINES.find((e) => e.code === settings.translationEngine)?.hint}
          </div>
        </div>
        <label className="check subtle">
          <input type="checkbox" checked={settings.translatePartials} onChange={(e) => updateSettings({ translatePartials: e.target.checked })} /> 边说边翻译（未说完的句子也翻译，较耗 CPU；翻译跟不上时自动只翻整句；下次开始时生效）
        </label>
        {languagesPending && snapshot && (
          <div className="pending">
            当前会话仍使用 {languageLabel(snapshot.sourceLanguage ?? '')} → {languageLabel(snapshot.targetLanguage ?? '')}（{providerName(snapshot.translation?.provider)}），新设置将在下次开始时生效。
          </div>
        )}
        <div className="actions">
          {isActive ? (
            <button className="btn primary running" disabled>
              ● 正在翻译
            </button>
          ) : sessionStatus === 'starting' || busy ? (
            <button className="btn primary running" disabled>
              正在启动…{settings.translationEngine !== 'hy-mt2' ? '（首次选用的引擎需要加载，最多 1 分钟）' : ''}
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

      {slowTranslation && (
        <div className="card hint warn-card">本机翻译跟不上（覆盖率 {Math.round((snapshot?.metrics?.translationCoverage ?? 0) * 100)}%，平均 {((snapshot?.metrics?.avgTranslateMs ?? 0) / 1000).toFixed(1)} s/句）。建议在「翻译引擎」改用 LM Studio 或 Gemini，下次开始时生效。</div>
      )}
      {languageFlipping && (
        <div className="card hint warn-card">自动检测到多种语言（{snapshot?.detectedLanguages?.join(' / ')}）。如果这个视频只有一种语言，在「来源」里指定它可以提高识别准确率。</div>
      )}
      {shownError ? (
        <div className="card error-card">{shownError}</div>
      ) : backendDown ? (
        <div className="card error-card">本地后端未运行（{HEALTHZ_URL} 无响应）。请在终端执行 npm run dev:server，等待「Server listening」后再开始。</div>
      ) : (
        <div className="card hint">{tabHint(tab)}</div>
      )}

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
            <label className="check">
              <input type="checkbox" checked={settings.style.autoScale} onChange={(e) => updateStyle({ autoScale: e.target.checked })} /> 字号随播放器大小自动缩放
            </label>
            <label className="check">
              <input type="checkbox" checked={settings.style.avoidControls} onChange={(e) => updateStyle({ avoidControls: e.target.checked })} /> 控制条出现时自动上移
            </label>
            <label className="check">
              <input type="checkbox" checked={settings.style.outline} onChange={(e) => updateStyle({ outline: e.target.checked })} /> 文字描边
            </label>
            <label className="slider">
              <span>字体</span>
              <select className="inline-select" value={settings.style.fontFamily} onChange={(e) => updateStyle({ fontFamily: e.target.value as FontFamilyChoice })}>
                {FONT_FAMILIES.map((f) => (
                  <option key={f.code} value={f.code}>
                    {f.label}
                  </option>
                ))}
              </select>
              <span className="val" />
            </label>
            <label className="slider">
              <span>每行最多</span>
              <input type="range" min={STYLE_LIMITS.maxLines.min} max={STYLE_LIMITS.maxLines.max} step={STYLE_LIMITS.maxLines.step} value={settings.style.maxLines} onChange={(e) => updateStyle({ maxLines: Number(e.target.value) })} />
              <span className="val">{settings.style.maxLines} 行</span>
            </label>
            <label className="slider">
              <span>会话上限</span>
              <select className="inline-select" value={settings.sessionLimitHours} onChange={(e) => updateSettings({ sessionLimitHours: Number(e.target.value) })}>
                {SESSION_LIMIT_CHOICES.map((c) => (
                  <option key={c.hours} value={c.hours}>
                    {c.label}
                  </option>
                ))}
              </select>
              <span className="val" />
            </label>
            <button className="btn reset" onClick={() => void settingsStore.reset().then(setSettings)}>
              恢复默认
            </button>
          </div>
        )}
      </section>

      <section className="card">
        <button className={`section-toggle ${diagOpen ? 'open' : ''}`} onClick={() => setDiagOpen((o) => !o)} aria-expanded={diagOpen}>
          <span>诊断</span>
          <span className="chev">›</span>
        </button>
        {diagOpen && (
          <div className="diag">
            <div className="row">
              <span className="label">本地后端</span>
              <span className="value">{backend.kind === 'up' ? `运行中 · ${formatDuration((backend.health.uptimeSec ?? 0) * 1000)}` : backend.kind === 'down' ? '未运行' : '…'}</span>
            </div>
            {backend.kind === 'up' && (
              <div className="row">
                <span className="label">引擎</span>
                <span className="value">
                  {Object.entries(backend.health.engines ?? {})
                    .filter(([name]) => name !== 'mock' && name !== 'none')
                    .map(([name, st]) => `${providerName(name)} ${st.ready ? '✓' : st.configured ? '○' : '✗'}`)
                    .join('  ')}
                </span>
              </div>
            )}
            {isActive && (
              <>
                <div className="row">
                  <span className="label">会话时长</span>
                  <span className="value">
                    {uptime}
                    {snapshot?.sessionLimitMs ? ` / ${formatDuration(snapshot.sessionLimitMs)}` : ''}
                  </span>
                </div>
                <div className="row">
                  <span className="label">字幕 / 重连</span>
                  <span className="value">
                    {snapshot?.transcriptCount ?? 0} 条 · 重连 {snapshot?.reconnects ?? 0} 次
                  </span>
                </div>
                {snapshot?.metrics && (
                  <>
                    <div className="row">
                      <span className="label">音频 / 延迟</span>
                      <span className="value">
                        {snapshot.metrics.audioSeconds}s · 识别 {snapshot.metrics.avgLatencyMs}ms (p95 {snapshot.metrics.asrLatencyP95Ms}) · 翻译 {snapshot.metrics.avgTranslateMs}ms (p95 {snapshot.metrics.translateP95Ms})
                      </span>
                    </div>
                    <div className="row">
                      <span className="label">翻译覆盖 / 语种</span>
                      <span className="value">
                        {Math.round(snapshot.metrics.translationCoverage * 100)}% · {snapshot.detectedLanguages?.join('/') || '—'}
                      </span>
                    </div>
                  </>
                )}
              </>
            )}
            {rawError && <div className="diag-raw">{rawError}</div>}
            <button className="btn reset" onClick={copyDiagnostics}>
              {copied ? '已复制' : '复制诊断信息'}
            </button>
            <div className="field-hint">✓ 已加载 · ○ 已配置未加载 · ✗ 未配置。诊断信息不含密钥。</div>
          </div>
        )}
      </section>

      <div className="footer">本地后端 · 音频与字幕不离开本机（云端翻译引擎除外）</div>
    </div>
  );
}
