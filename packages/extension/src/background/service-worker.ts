import { SessionManager } from './session-manager.js';
import { chromePorts } from './chrome-ports.js';
import { BACKEND_WS_URL } from '../shared/config.js';
import { isTargeted, type ContentHelloResponse, type ToBackground } from '../shared/messages.js';

/**
 * MV3 service worker: the extension's coordinator. It holds no audio or
 * network resources itself; it only orchestrates the popup, the offscreen
 * document and the content script.
 */

const manager = new SessionManager({ ports: chromePorts, backendUrl: BACKEND_WS_URL });

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (!isTargeted<ToBackground>(message, 'background')) return false;

  const respond = (promise: Promise<unknown>) => {
    promise
      .then((value) => sendResponse(value))
      .catch((err: unknown) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    return true; // keep the message channel open for the async response
  };

  switch (message.type) {
    case 'popup.getStatus':
      return respond(manager.snapshot());
    case 'popup.start':
      return respond(manager.start(message.capture));
    case 'popup.stop':
      return respond(manager.stop('user'));
    case 'content.hello': {
      const tabId = sender.tab?.id;
      if (tabId === undefined) {
        sendResponse({ active: false } satisfies ContentHelloResponse);
        return false;
      }
      return respond(manager.sessionForTab(tabId));
    }
    case 'offscreen.transcript':
      return respond(manager.onTranscript(message.transcript).then(() => ({ ok: true })));
    case 'offscreen.level':
      manager.onAudioLevel(message.level);
      sendResponse({ ok: true });
      return false;
    case 'offscreen.metrics':
      manager.onMetrics(message.metrics);
      sendResponse({ ok: true });
      return false;
    case 'offscreen.reconnecting':
      manager.onReconnecting();
      sendResponse({ ok: true });
      return false;
    case 'offscreen.reconnected':
      return respond(manager.onReconnected(message.sessionId, message.asr).then(() => ({ ok: true })));
    case 'offscreen.disconnected':
      return respond(manager.onOffscreenDisconnected(message.reason).then(() => ({ ok: true })));
    default:
      return false;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void manager.onTabRemoved(tabId);
});

chrome.runtime.onInstalled.addListener((details) => {
  console.info('[LST/background] installed', details.reason);
  // Make sure a reload of the extension never leaves a session marked active
  // without the offscreen document that backs it.
  void manager.stop('extension installed/updated');
});

chrome.runtime.onStartup.addListener(() => {
  void manager.stop('browser startup');
});
