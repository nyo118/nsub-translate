import { detectPlatform } from '../shared/platform.js';
import { isTargeted, type ContentDetectResponse, type ContentHelloResponse, type ContentToBackground, type ToContent } from '../shared/messages.js';
import { SettingsStore } from '../shared/settings-store.js';
import { adapterFor } from './players/index.js';
import { SubtitleOverlay } from './overlay.js';
import { OverlayBinder } from './overlay-binder.js';
import { SubtitleStore } from './subtitle-state.js';

/**
 * Content script for youtube.com / twitch.tv. It never touches the
 * player's own UI; it only appends one overlay host inside the player
 * container while a session is active, and keeps it there across SPA
 * navigations via the platform's PlayerAdapter.
 */
(function main() {
  const platform = detectPlatform(location.hostname);
  const adapter = adapterFor(platform);
  const overlay = new SubtitleOverlay(document);
  const store = new SubtitleStore({ visibleCount: 2 });
  const settings = new SettingsStore();
  const binder = adapter === null ? null : new OverlayBinder(document, adapter, overlay, () => store.visible());
  let active = false;
  let unsubscribeSettings: (() => void) | null = null;

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

  async function startSession(): Promise<void> {
    active = true;
    store.clear();
    try {
      overlay.setStyle((await settings.load()).style);
      unsubscribeSettings?.();
      // Style changes from the popup apply immediately, even mid-session.
      unsubscribeSettings = settings.subscribe((s) => overlay.setStyle(s.style));
    } catch (err) {
      log('could not load settings, using defaults', String(err));
    }
    if (binder?.bind()) {
      overlay.renderNotice(platform === 'twitch' ? 'N Sub: Twitch player detected (audio capture validated in a later phase)' : 'N Sub: session started, waiting for subtitles…');
    } else {
      log('session started but no player container found yet');
    }
  }

  function stopSession(): void {
    active = false;
    store.clear();
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
        void startSession().then(() => sendResponse({ ok: true }));
        return true;
      case 'content.transcript':
        if (active && store.apply(message.transcript) && binder?.ensureMounted()) overlay.render(store.visible());
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

  // Ask the worker whether this tab already has a session (page refresh
  // during a session, or the extension was reloaded).
  async function hello(): Promise<void> {
    if (!isContextAlive()) return;
    const message: ContentToBackground = { target: 'background', type: 'content.hello', ...detect() };
    try {
      const response = (await chrome.runtime.sendMessage(message)) as ContentHelloResponse | undefined;
      if (response?.active) {
        log('re-attaching to active session', response.sessionId);
        await startSession();
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
