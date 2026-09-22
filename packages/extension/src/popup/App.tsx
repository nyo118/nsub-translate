import { useCallback, useEffect, useState } from 'react';
import type { ContentDetectResponse, OkResponse, PopupToBackground, SessionSnapshot, ToContent } from '../shared/messages.js';
import { detectPlatformFromUrl, type Platform } from '../shared/platform.js';

const POLL_MS = 250;

async function askBackground<R>(message: PopupToBackground): Promise<R> {
  return (await chrome.runtime.sendMessage(message)) as R;
}

interface TabInfo {
  platform: Platform | null;
  playerFound: boolean;
  contentLoaded: boolean;
}

async function inspectActiveTab(): Promise<TabInfo> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
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

export function App() {
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  const [tab, setTab] = useState<TabInfo | null>(null);
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
    // Poll the worker while the popup is open. The first tick is deferred so
    // the effect body itself never sets state synchronously.
    let ticks = 0;
    const tick = () => {
      void refresh();
      if (ticks++ % 4 === 0) void inspectActiveTab().then(setTab);
    };
    const initial = setTimeout(tick, 0);
    const timer = setInterval(tick, POLL_MS);
    return () => {
      clearTimeout(initial);
      clearInterval(timer);
    };
  }, [refresh]);

  const run = async (type: 'popup.start' | 'popup.stop') => {
    setBusy(true);
    setError(null);
    try {
      const result = await askBackground<OkResponse>({ target: 'background', type });
      if (!result.ok) setError(result.error);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
      void refresh();
      void inspectActiveTab().then(setTab);
    }
  };

  const status = snapshot?.status ?? 'idle';
  const canStart = status === 'idle' && !busy && tab?.platform !== null && tab?.playerFound === true;
  const canStop = (status === 'active' || status === 'starting') && !busy;
  const shownError = error ?? (status === 'idle' ? snapshot?.lastError : undefined);

  return (
    <div className="app">
      <h1>
        Live Subtitle Translator <span className="phase">Phase 0</span>
      </h1>
      <div className="row">
        <span className="label">Session</span>
        <span className={`value status-${status}`}>{status}</span>
      </div>
      <div className="row">
        <span className="label">Current tab</span>
        <span className="value">
          {tab === null ? '…' : tab.platform === null ? 'not YouTube / Twitch' : `${tab.platform}${tab.playerFound ? ' · player found' : tab.contentLoaded ? ' · no player' : ' · reload page'}`}
        </span>
      </div>
      {snapshot?.sessionId && (
        <div className="row">
          <span className="label">Session id</span>
          <span className="value">
            <code>{snapshot.sessionId.slice(0, 8)}</code>
          </span>
        </div>
      )}
      {status === 'active' && (
        <>
          <div className="row">
            <span className="label">Subtitles received</span>
            <span className="value">{snapshot?.transcriptCount ?? 0}</span>
          </div>
          <div className="row">
            <span className="label">Tab audio level</span>
            <span className="value">{snapshot?.audioLevel === undefined ? '—' : snapshot.audioLevel.toFixed(3)}</span>
          </div>
          <div className="meter" aria-label="audio level">
            <div style={{ width: `${Math.min(100, Math.round((snapshot?.audioLevel ?? 0) * 300))}%` }} />
          </div>
        </>
      )}
      {shownError && <div className="error">{shownError}</div>}
      <div className="actions">
        <button className="primary" disabled={!canStart} onClick={() => void run('popup.start')}>
          Start Translation
        </button>
        <button disabled={!canStop} onClick={() => void run('popup.stop')}>
          Stop
        </button>
      </div>
      <div className="hint">
        Backend: <code>{snapshot?.backendUrl ?? '…'}</code>
        <br />
        Mock subtitles only (en → zh-CN). Audio is captured for playback and level metering, never sent or stored.
      </div>
    </div>
  );
}
