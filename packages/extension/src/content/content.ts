import { detectPlatform } from '../shared/platform.js';
import { isTargeted, type ContentDetectResponse, type ContentHelloResponse, type ContentToBackground, type ToContent } from '../shared/messages.js';
import { findPlayer } from './player-detect.js';
import { SubtitleOverlay } from './overlay.js';
import { SubtitleStore } from './subtitle-state.js';

/**
 * Content script for youtube.com / twitch.tv. It never touches the
 * player's own UI; it only appends one overlay host inside the player
 * container while a session is active.
 */
(function main() {
  const platform = detectPlatform(location.hostname);
  const overlay = new SubtitleOverlay(document);
  const store = new SubtitleStore({ visibleCount: 2 });
  let active = false;

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

  function ensureMounted(): boolean {
    if (platform === null) return false;
    if (overlay.mounted && overlay.container?.isConnected) return true;
    const player = findPlayer(document, platform);
    if (player === null) return false;
    overlay.mount(player.container);
    return true;
  }

  function startSession(): void {
    active = true;
    store.clear();
    if (ensureMounted()) {
      overlay.renderNotice(platform === 'twitch' ? 'LST: Twitch player detected (audio capture validated in a later phase)' : 'LST: session started, waiting for subtitles…');
    } else {
      log('session started but no player container found yet');
    }
  }

  function stopSession(): void {
    active = false;
    store.clear();
    overlay.unmount();
  }

  function detect(): ContentDetectResponse {
    const player = platform === null ? null : findPlayer(document, platform);
    return { platform, playerFound: player !== null, overlayMounted: overlay.mounted };
  }

  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if (!isTargeted<ToContent>(message, 'content')) return false;
    switch (message.type) {
      case 'content.detect':
        sendResponse(detect());
        return false;
      case 'content.sessionStarted':
        startSession();
        sendResponse({ ok: true });
        return false;
      case 'content.transcript':
        if (active && store.apply(message.transcript) && ensureMounted()) overlay.render(store.visible());
        sendResponse({ ok: true });
        return false;
      case 'content.sessionStopped':
        stopSession();
        sendResponse({ ok: true });
        return false;
      default:
        return false;
    }
  });

  // YouTube is a single-page app: the player container can be replaced when
  // the user navigates between videos without a page load.
  document.addEventListener('yt-navigate-finish', () => {
    if (active && ensureMounted()) overlay.render(store.visible());
  });

  // Ask the worker whether this tab already has a session (page refresh
  // during a session, or the extension was reloaded).
  async function hello(): Promise<void> {
    if (!isContextAlive()) return;
    const message: ContentToBackground = { target: 'background', type: 'content.hello', ...detect() };
    try {
      const response = (await chrome.runtime.sendMessage(message)) as ContentHelloResponse | undefined;
      if (response?.active) {
        log('re-attaching to active session', response.sessionId);
        startSession();
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
