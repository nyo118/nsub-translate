import type { SessionPorts, PersistedSession } from './session-manager.js';
import type {
  ContentDetectResponse,
  OffscreenStartResponse,
  OffscreenStopResponse,
  ToContent,
  ToOffscreen,
} from '../shared/messages.js';
import { detectPlatformFromUrl } from '../shared/platform.js';
import { describeCaptureError } from '../shared/capture-error.js';
import { SettingsStore } from '../shared/settings-store.js';

/**
 * Real Chrome implementations of the SessionPorts. This file is the only
 * place in the background that touches chrome.tabCapture / chrome.offscreen.
 */

const STORAGE_KEY = 'session';
const OFFSCREEN_URL = 'offscreen.html';

let offscreenCreation: Promise<void> | null = null;

async function hasOffscreen(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });
  return contexts.length > 0;
}

async function ensureOffscreen(): Promise<void> {
  if (await hasOffscreen()) return;
  if (offscreenCreation === null) {
    offscreenCreation = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: [chrome.offscreen.Reason.USER_MEDIA],
        justification: 'Capture tab audio and keep playing it to the user while a translation session is active.',
      })
      .finally(() => {
        offscreenCreation = null;
      });
  }
  await offscreenCreation;
}

async function sendToOffscreen<R>(message: ToOffscreen): Promise<R> {
  return (await chrome.runtime.sendMessage(message)) as R;
}

function log(level: 'info' | 'warn' | 'error', message: string, data?: unknown): void {
  const line = `[LST/background] ${message}`;
  if (level === 'error') console.error(line, data ?? '');
  else if (level === 'warn') console.warn(line, data ?? '');
  else console.info(line, data ?? '');
}

const settingsStore = new SettingsStore();

export const chromePorts: SessionPorts = {
  async loadLanguages() {
    const s = await settingsStore.load();
    return {
      sourceLanguage: s.sourceLanguage,
      targetLanguage: s.targetLanguage,
      translatePartials: s.translatePartials,
      translationProvider: s.translationEngine,
      sessionLimitMs: Math.round(s.sessionLimitHours * 3_600_000),
      backendUrl: s.backendUrl,
    };
  },
  async loadState() {
    const result = await chrome.storage.session.get(STORAGE_KEY);
    return result[STORAGE_KEY] as PersistedSession | undefined;
  },
  async saveState(state) {
    await chrome.storage.session.set({ [STORAGE_KEY]: state });
  },
  async clearState() {
    await chrome.storage.session.remove(STORAGE_KEY);
  },
  async getActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab || tab.id === undefined) throw new Error('No active tab.');
    return tab.url === undefined ? { tabId: tab.id } : { tabId: tab.id, url: tab.url };
  },
  async detectPlayer(tabId) {
    const tab = await chrome.tabs.get(tabId);
    const platform = detectPlatformFromUrl(tab.url);
    if (platform === null) return { platform: null, playerFound: false };
    try {
      const message: ToContent = { target: 'content', type: 'content.detect' };
      const response = (await chrome.tabs.sendMessage(tabId, message)) as ContentDetectResponse | undefined;
      if (!response) return { platform, playerFound: false };
      return { platform: response.platform ?? platform, playerFound: response.playerFound };
    } catch (err) {
      // No content script in this tab (page opened before the extension was installed/reloaded).
      throw new Error(`Content script is not loaded in this tab. Reload the page and try again. (${String(err)})`);
    }
  },
  async getStreamId(tabId) {
    // Fallback path (the popup normally obtains the stream id itself).
    try {
      return await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    } catch (err) {
      throw new Error(describeCaptureError(err, tabId, 'service worker'));
    }
  },
  ensureOffscreen,
  hasOffscreen,
  async closeOffscreen() {
    await chrome.offscreen.closeDocument();
  },
  async startOffscreen(req) {
    const response = await sendToOffscreen<OffscreenStartResponse | undefined>({ target: 'offscreen', type: 'offscreen.start', ...req });
    if (!response) return { ok: false, error: 'Offscreen document did not respond to start.' };
    return response;
  },
  async stopOffscreen() {
    const response = await sendToOffscreen<OffscreenStopResponse | undefined>({ target: 'offscreen', type: 'offscreen.stop' });
    return response?.released;
  },
  async notifyContent(tabId, message) {
    await chrome.tabs.sendMessage(tabId, { target: 'content', ...message } satisfies ToContent);
  },
  log,
};
