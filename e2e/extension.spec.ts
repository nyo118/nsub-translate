import { expect, test } from './fixtures.js';

/**
 * Phase 0 smoke tests. What these prove:
 *  - the built MV3 extension loads and its service worker starts;
 *  - the popup renders and talks to the service worker;
 *  - a start attempt on an unsupported page fails gracefully;
 *  - an extension page can open a WebSocket to the local backend and
 *    complete the protocol handshake.
 * Real tab-audio capture cannot be driven by Playwright (it needs the user
 * to invoke the extension); that stays a manual test.
 */

test('service worker starts and no offscreen document exists at rest', async ({ serviceWorker }) => {
  expect(serviceWorker.url()).toMatch(/background\.js$/);
  const contexts = await serviceWorker.evaluate(async () =>
    chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] }),
  );
  expect(contexts).toHaveLength(0);
});

test('popup renders, reports Ready and refuses to start on an unsupported page', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(page.getByRole('heading', { name: 'N Sub' })).toBeVisible();
  await expect(page.locator('.status')).toHaveText(/Ready/);
  await expect(page.getByText(/打开 YouTube · Twitch/)).toBeVisible();
  await expect(page.getByRole('button', { name: /开始字幕/ })).toBeDisabled();

  // Bypass the disabled button and ask the worker directly, as the popup would.
  const result = await page.evaluate(() => chrome.runtime.sendMessage({ target: 'background', type: 'popup.start' }));
  expect(result).toEqual({ ok: false, error: 'The current tab is not a YouTube or Twitch page.' });
  await expect(page.locator('.status')).toHaveText(/Ready/);
});

test('popup settings persist to chrome.storage.local and survive a reload of the popup', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.locator('#target').selectOption('ja');
  await page.locator('#source').selectOption('en');
  await page.getByRole('button', { name: '字幕样式' }).click();
  const fontSize = page.locator('.slider input[type="range"]').first();
  await fontSize.fill('30');
  await expect(page.getByText('30px')).toBeVisible();
  await page.getByLabel('显示原文').uncheck();

  const stored = await page.evaluate(() => chrome.storage.local.get('settings'));
  expect(stored).toEqual({
    settings: {
      version: 1,
      sourceLanguage: 'en',
      targetLanguage: 'ja',
      translationEngine: 'hy-mt2',
      translatePartials: false,
      sessionLimitHours: 3,
      style: { fontSize: 30, position: 10, backgroundOpacity: 0.72, showSource: false, showTranslated: true, autoScale: true, outline: false, fontFamily: 'system', maxLines: 2, avoidControls: true },
    },
  });

  await page.reload();
  await expect(page.locator('#target')).toHaveValue('ja');
  await expect(page.locator('#source')).toHaveValue('en');
  await page.getByRole('button', { name: '字幕样式' }).click();
  await expect(page.getByLabel('显示原文')).not.toBeChecked();

  await page.getByRole('button', { name: '恢复默认' }).click();
  await expect(page.locator('#target')).toHaveValue('zh-CN');
  await expect(page.locator('#source')).toHaveValue('auto');
});

test('an extension page can complete the protocol handshake with the local backend', async ({ context, extensionId }) => {
  // Against the test backend (mock providers on :8797): handshake, one binary
  // audio frame accepted without error, and a clean stop.
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  const messages = await page.evaluate(
    (url) =>
      new Promise<string[]>((resolve, reject) => {
        const received: string[] = [];
        const ws = new WebSocket(url);
        ws.binaryType = 'arraybuffer';
        const timer = setTimeout(() => reject(new Error(`timeout; received: ${received.join(' | ')}`)), 8000);
        ws.onopen = () =>
          ws.send(JSON.stringify({ type: 'session.start', protocolVersion: 5, sourceLanguage: 'en', targetLanguage: 'zh-CN', audio: { encoding: 'pcm_s16le', sampleRate: 16000, channels: 1 } }));
        ws.onmessage = (ev) => {
          const msg = JSON.parse(String(ev.data)) as { type: string; sessionId?: string; code?: string };
          received.push(msg.type === 'session.error' ? `session.error:${msg.code}` : msg.type);
          if (msg.type === 'session.ready' && msg.sessionId) {
            ws.send(new Int16Array(1600).buffer); // one 100 ms binary audio frame
            setTimeout(() => ws.send(JSON.stringify({ type: 'session.stop', sessionId: msg.sessionId })), 300);
          }
          if (msg.type === 'session.stopped') {
            clearTimeout(timer);
            ws.close();
            resolve(received);
          }
        };
        ws.onerror = () => reject(new Error('websocket error'));
      }),
    'ws://127.0.0.1:8797/ws',
  );
  expect(messages[0]).toBe('session.ready');
  expect(messages.at(-1)).toBe('session.stopped');
  expect(messages.some((m) => m.startsWith('session.error'))).toBe(false);
});
