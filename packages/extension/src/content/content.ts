import { detectPlatform } from '../shared/platform.js';
import { isTargeted, type ContentDetectResponse, type ContentHelloResponse, type ContentToBackground, type ToContent } from '../shared/messages.js';
import { SettingsStore } from '../shared/settings-store.js';
import type { TranscriptMessage } from '@lst/protocol';
import { adapterFor } from './players/index.js';
import { SubtitleOverlay } from './overlay.js';
import { OverlayBinder } from './overlay-binder.js';
import { SubtitleStore } from './subtitle-state.js';
import { PlaybackTimeline } from './playback-timeline.js';
import { PlaybackTracker } from './playback-tracker.js';
import { SubtitleCache } from './subtitle-cache.js';

/**
 * Content script for youtube.com / twitch.tv. It never touches the
 * player's own UI; it only appends one overlay host inside the player
 * container while a session is active, keeps it there across SPA
 * navigations, and keeps subtitles in step with playback:
 *   - seek  → clear the screen, drop late transcripts of pre-seek audio
 *   - replay → show cached finals for the position at once
 *   - pause → keep the last lines (nothing new is spoken anyway)
 */
(function main() {
  const platform = detectPlatform(location.hostname);
  const adapter = adapterFor(platform);
  const overlay = new SubtitleOverlay(document);
  const store = new SubtitleStore({ visibleCount: 2 });
  const cache = new SubtitleCache();
  const timeline = new PlaybackTimeline();
  const settings = new SettingsStore();
  const binder = adapter === null ? null : new OverlayBinder(document, adapter, overlay, () => linesToShow());
  const tracker = new PlaybackTracker(timeline, {
    onSeek: (to, from) => {
      log('seek', { from, to });
      store.clear();
      renderNow();
    },
  });
  let active = false;
  let sessionId: string | null = null;
  /** Wall time of the backend audio clock's zero; null until audio flows. */
  let audioOriginWall: number | null = null;
  let unsubscribeSettings: (() => void) | null = null;
  let ticker: ReturnType<typeof setInterval> | null = null;
  let droppedStale = 0;

  function log(message: string, data?: unknown): void {
    console.info(`[LST/content] ${message}`, data ?? '');
  }

  function isContextAlive(): boolean {
    try {
      return typeof chrome !== 'undefined' && !!chrome.runtime?.id;
    } catch {
      return false;
    }
  }

  function isLive(): boolean {
    return adapter?.isLive(document, tracker.video) ?? false;
  }

  /** Attach the tracker to whatever <video> the player currently uses. */
  function syncTracker(): void {
    const video = adapter?.findVideo(document) ?? null;
    if (video !== null && tracker.video !== video) {
      tracker.attach(video);
      log('tracking video element');
    }
  }

  /** Live lines when there are any; otherwise cached lines for the current position (VOD only). */
  function linesToShow() {
    const live = store.visible();
    if (live.length > 0) return live;
    if (isLive()) return live;
    const t = tracker.currentTime();
    return t === null ? live : cache.at(t);
  }

  function renderNow(): void {
    if (!active) return;
    if (binder?.ensureMounted()) overlay.render(linesToShow());
  }

  /** Wall-clock span of a transcript, once the audio origin is known. */
  function wallSpan(t: TranscriptMessage): { start: number; end: number } | null {
    if (audioOriginWall === null) return null;
    return { start: audioOriginWall + t.startMs, end: audioOriginWall + (t.endMs ?? t.startMs + 1500) };
  }

  function onTranscript(t: TranscriptMessage): void {
    if (!active) return;
    const span = wallSpan(t);
    // Finals get cached by video position (VOD only) — even stale ones, so a replay shows them.
    if (span !== null && t.status === 'final' && !isLive()) {
      const startTime = timeline.videoTimeAt(span.start);
      const endTime = timeline.videoTimeAt(span.end);
      if (startTime !== null && endTime !== null) {
        const seg = { segmentId: t.segmentId, startTime, endTime, sourceText: t.sourceText };
        cache.upsert(t.translatedText === undefined ? seg : { ...seg, translatedText: t.translatedText });
      }
    }
    if (span !== null && timeline.isStale(span.end)) {
      droppedStale += 1;
      if (droppedStale % 10 === 1) log('dropped stale transcript (pre-seek audio)', { total: droppedStale });
      return;
    }
    if (store.apply(t)) renderNow();
  }

  async function startSession(id: string, origin?: number): Promise<void> {
    active = true;
    sessionId = id;
    audioOriginWall = origin ?? null;
    store.clear();
    cache.clear();
    timeline.clear();
    droppedStale = 0;
    try {
      overlay.setStyle((await settings.load()).style);
      unsubscribeSettings?.();
      // Style changes from the popup apply immediately, even mid-session.
      unsubscribeSettings = settings.subscribe((s) => overlay.setStyle(s.style));
    } catch (err) {
      log('could not load settings, using defaults', String(err));
    }
    syncTracker();
    tracker.sample();
    if (ticker === null) {
      let tick = 0;
      ticker = setInterval(() => {
        tick += 1;
        // Keep the subtitles clear of the control bar (cheap DOM read, 4×/s).
        if (adapter !== null) overlay.setLift(adapter.controlsLift(document));
        if (tick % 2 !== 0) return;
        syncTracker();
        tracker.sample();
        // Re-render cached lines while playing through a replayed range.
        if (store.visible().length === 0 && !isLive()) renderNow();
      }, 250);
    }
    if (binder?.bind()) {
      overlay.renderNotice(`N Sub: ${isLive() ? '直播' : '影片'}会话已开始，等待字幕…`);
    } else {
      log('session started but no player container found yet');
    }
  }

  function stopSession(): void {
    active = false;
    sessionId = null;
    audioOriginWall = null;
    store.clear();
    cache.clear();
    timeline.clear();
    if (ticker !== null) {
      clearInterval(ticker);
      ticker = null;
    }
    tracker.detach();
    unsubscribeSettings?.();
    unsubscribeSettings = null;
    binder?.unbind();
    overlay.unmount();
  }

  function detect(): ContentDetectResponse {
    const container = adapter?.findContainer(document) ?? null;
    return { platform, playerFound: container !== null, overlayMounted: overlay.mounted };
  }

  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if (!isTargeted<ToContent>(message, 'content')) return false;
    switch (message.type) {
      case 'content.detect':
        sendResponse(detect());
        return false;
      case 'content.sessionStarted':
        // A reconnect re-sends this with a new session id: keep the cache (same video), reset the live state.
        if (active && sessionId !== null && sessionId !== message.sessionId) {
          sessionId = message.sessionId;
          audioOriginWall = message.audioOriginWall ?? null;
          store.clear();
          renderNow();
          sendResponse({ ok: true });
          return false;
        }
        void startSession(message.sessionId, message.audioOriginWall).then(() => sendResponse({ ok: true }));
        return true;
      case 'content.audioOrigin':
        if (active && message.sessionId === sessionId) audioOriginWall = message.audioOriginWall;
        sendResponse({ ok: true });
        return false;
      case 'content.transcript':
        onTranscript(message.transcript);
        sendResponse({ ok: true });
        return false;
      case 'content.sessionStopped':
        stopSession();
        sendResponse({ ok: true });
        return false;
      case 'content.reconnecting':
        if (active && binder?.ensureMounted()) overlay.renderNotice(`N Sub: 正在重新连接本地后端（第 ${message.attempt} 次）…`);
        sendResponse({ ok: true });
        return false;
      default:
        return false;
    }
  });

  // Ask the worker whether this tab already has a session (page refresh
  // during a session, or the extension was reloaded).
  async function hello(): Promise<void> {
    if (!isContextAlive()) return;
    const message: ContentToBackground = { target: 'background', type: 'content.hello', ...detect() };
    try {
      const response = (await chrome.runtime.sendMessage(message)) as ContentHelloResponse | undefined;
      if (response?.active && response.sessionId) {
        log('re-attaching to active session', response.sessionId);
        await startSession(response.sessionId, response.audioOriginWall);
      }
    } catch (err) {
      // Extension reloaded → this script instance is orphaned. Clean up quietly.
      log('background unreachable, cleaning up', String(err));
      stopSession();
    }
  }

  void hello();
  log('loaded', { platform, playerFound: detect().playerFound });
})();
