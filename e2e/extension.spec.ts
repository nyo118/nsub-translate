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

test('popup renders, reports idle and refuses to start on an unsupported page', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(page.getByRole('heading', { name: /Live Subtitle Translator/ })).toBeVisible();
  await expect(page.locator('.status-idle')).toHaveText('idle');
  await expect(page.getByText('not YouTube / Twitch')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start Translation' })).toBeDisabled();

  // Bypass the disabled button and ask the worker directly, as the popup would.
  const result = await page.evaluate(() => chrome.runtime.sendMessage({ target: 'background', type: 'popup.start' }));
  expect(result).toEqual({ ok: false, error: 'The current tab is not a YouTube or Twitch page.' });
  await expect(page.locator('.status-idle')).toHaveText('idle');
});

test('an extension page can complete the protocol handshake with the local backend', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  const messages = await page.evaluate(
    (url) =>
      new Promise<string[]>((resolve, reject) => {
        const received: string[] = [];
        const ws = new WebSocket(url);
        const timer = setTimeout(() => reject(new Error(`timeout; received: ${received.join(' | ')}`)), 8000);
        ws.onopen = () => ws.send(JSON.stringify({ type: 'session.start', protocolVersion: 1, sourceLanguage: 'en', targetLanguage: 'zh-CN' }));
        ws.onmessage = (ev) => {
          const msg = JSON.parse(String(ev.data)) as { type: string; sessionId?: string };
          received.push(msg.type);
          if (msg.type === 'transcript' && msg.sessionId) ws.send(JSON.stringify({ type: 'session.stop', sessionId: msg.sessionId }));
          if (msg.type === 'session.stopped') {
            clearTimeout(timer);
            ws.close();
            resolve(received);
          }
        };
        ws.onerror = () => reject(new Error('websocket error'));
      }),
    'ws://127.0.0.1:8787/ws',
  );
  expect(messages[0]).toBe('session.ready');
  expect(messages).toContain('transcript');
  expect(messages.at(-1)).toBe('session.stopped');
});
