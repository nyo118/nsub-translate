import { describe, expect, it } from 'vitest';
import { friendlyError } from './friendly-error.js';

describe('friendlyError', () => {
  it('maps known failures to actionable Chinese', () => {
    expect(friendlyError('Could not connect to the local backend at ws://127.0.0.1:8787/ws. Is it running? (close code 1006)')).toMatch(/npm run dev:server/);
    expect(friendlyError('Backend connection lost: code 1006; reconnect failed after 5 attempts')).toMatch(/重连失败/);
    expect(friendlyError('translation_unavailable: translation provider "gemini" requires GEMINI_API_KEY')).toMatch(/翻译引擎不可用/);
    expect(friendlyError('Tab capture failed in popup for tab 3: Extension has not been invoked for the current page (see activeTab permission).')).toMatch(/点击扩展图标/);
    expect(friendlyError('Content script is not loaded in this tab. Reload the page')).toMatch(/刷新/);
    expect(friendlyError('The current tab is not a YouTube or Twitch page.')).toMatch(/YouTube 或 Twitch/);
  });
  it('passes unknown text through unchanged', () => {
    expect(friendlyError('something odd')).toBe('something odd');
  });
});
