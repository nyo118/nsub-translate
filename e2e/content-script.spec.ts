import { expect, test } from './fixtures.js';
import type { Page, Worker } from '@playwright/test';

/**
 * Regression tests for the content script on a YouTube-lookalike fixture.
 * The service worker is driven directly (chrome.tabs.sendMessage) so no
 * tab-capture or backend is needed; what is verified is everything from the
 * worker → content script boundary down to the DOM.
 */

async function tabIdFor(sw: Worker, urlPattern: string): Promise<number> {
  return sw.evaluate(async (pattern) => {
    for (let i = 0; i < 40; i++) {
      const tabs = await chrome.tabs.query({ url: pattern });
      if (tabs[0]?.id !== undefined) return tabs[0].id;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('no tab');
  }, urlPattern);
}

async function sendToContent(sw: Worker, tabId: number, message: Record<string, unknown>): Promise<unknown> {
  return sw.evaluate(([id, msg]) => chrome.tabs.sendMessage(id as number, msg), [tabId, { target: 'content', ...message }] as const);
}

const overlayLines = (page: Page) =>
  page.evaluate(() => {
    const host = document.getElementById('lst-subtitle-overlay');
    if (!host || !host.shadowRoot) return null;
    return Array.from(host.shadowRoot.querySelectorAll('.lst-line')).map((el) => ({
      source: el.querySelector('.lst-source')?.textContent ?? null,
      translated: el.querySelector('.lst-translated')?.textContent ?? null,
      partial: el.classList.contains('lst-partial'),
    }));
  });

async function waitForContentScript(sw: Worker, tabId: number): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      const r = (await sendToContent(sw, tabId, { type: 'content.detect' })) as { playerFound?: boolean } | undefined;
      if (r?.playerFound) return;
    } catch {
      /* not injected yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('content script did not answer');
}

const transcript = (segmentId: string, revision: number, status: 'partial' | 'final', sourceText: string, startMs: number, endMs?: number, translatedText?: string) => ({
  type: 'content.transcript',
  transcript: { type: 'transcript', sessionId: 'e2e', segmentId, revision, status, startMs, ...(endMs === undefined ? {} : { endMs }), sourceText, ...(translatedText === undefined ? {} : { translatedText }) },
});

test.describe('content script on a YouTube-like page', () => {
  test('detects the player, mounts the overlay for a session and removes it on stop', async ({ context, serviceWorker, youtubeUrl }) => {
    const page = await context.newPage();
    await page.goto(youtubeUrl);
    const tabId = await tabIdFor(serviceWorker, '*://www.youtube.com/*');
    await waitForContentScript(serviceWorker, tabId);
    expect(await sendToContent(serviceWorker, tabId, { type: 'content.detect' })).toMatchObject({ platform: 'youtube', playerFound: true, overlayMounted: false });

    await sendToContent(serviceWorker, tabId, { type: 'content.sessionStarted', sessionId: 'e2e', audioOriginWall: Date.now() });
    await expect(page.locator('#movie_player #lst-subtitle-overlay')).toHaveCount(1);
    await sendToContent(serviceWorker, tabId, transcript('s1', 0, 'partial', 'Hello there', 0));
    await sendToContent(serviceWorker, tabId, transcript('s1', 1, 'final', 'Hello there, friend.', 0, 1500));
    await sendToContent(serviceWorker, tabId, transcript('s1', 2, 'final', 'Hello there, friend.', 0, 1500, '你好，朋友。'));
    await expect.poll(() => overlayLines(page)).toEqual([{ source: 'Hello there, friend.', translated: '你好，朋友。', partial: false }]);

    await sendToContent(serviceWorker, tabId, { type: 'content.sessionStopped' });
    await expect(page.locator('#lst-subtitle-overlay')).toHaveCount(0);
    expect(await sendToContent(serviceWorker, tabId, { type: 'content.detect' })).toMatchObject({ overlayMounted: false });
  });

  test('a seek clears the screen and late pre-seek transcripts are dropped', async ({ context, serviceWorker, youtubeUrl }) => {
    const page = await context.newPage();
    await page.goto(youtubeUrl);
    const tabId = await tabIdFor(serviceWorker, '*://www.youtube.com/*');
    await waitForContentScript(serviceWorker, tabId);
    await page.evaluate(() => (window as unknown as { __fixture: { video: HTMLVideoElement } }).__fixture.video.play());
    const origin = Date.now();
    await sendToContent(serviceWorker, tabId, { type: 'content.sessionStarted', sessionId: 'e2e', audioOriginWall: origin });
    await sendToContent(serviceWorker, tabId, transcript('a', 0, 'final', 'Before the seek.', 0, 800, '跳转前。'));
    await expect.poll(() => overlayLines(page)).toEqual([{ source: 'Before the seek.', translated: '跳转前。', partial: false }]);

    // Jump far ahead in the video.
    await page.evaluate(() => {
      const v = (window as unknown as { __fixture: { video: HTMLVideoElement } }).__fixture.video;
      v.currentTime = 300;
    });
    await page.waitForFunction(() => (window as unknown as { __fixture: { video: HTMLVideoElement } }).__fixture.video.currentTime >= 299);
    await expect.poll(() => overlayLines(page)).toEqual([]);

    // A transcript whose audio predates the seek (endMs well before now) must not come back...
    const staleEnd = Date.now() - origin - 3000;
    await sendToContent(serviceWorker, tabId, transcript('a', 1, 'final', 'Before the seek.', 0, Math.max(1, staleEnd), '跳转前（迟到）。'));
    await page.waitForTimeout(300);
    expect(await overlayLines(page)).toEqual([]);
    // ...while audio after the seek is shown.
    const freshStart = Date.now() - origin + 200;
    await sendToContent(serviceWorker, tabId, transcript('b', 0, 'partial', 'After the seek', freshStart));
    await expect.poll(() => overlayLines(page)).toEqual([{ source: 'After the seek', translated: null, partial: true }]);
    await sendToContent(serviceWorker, tabId, { type: 'content.sessionStopped' });
  });

  test('replaying a watched range shows cached finals immediately', async ({ context, serviceWorker, youtubeUrl }) => {
    const page = await context.newPage();
    await page.goto(youtubeUrl);
    const tabId = await tabIdFor(serviceWorker, '*://www.youtube.com/*');
    await waitForContentScript(serviceWorker, tabId);
    const video = () => (window as unknown as { __fixture: { video: HTMLVideoElement } }).__fixture.video;
    await page.evaluate(() => {
      const v = (window as unknown as { __fixture: { video: HTMLVideoElement } }).__fixture.video;
      v.currentTime = 100;
      return v.play();
    });
    await page.waitForFunction(() => (window as unknown as { __fixture: { video: HTMLVideoElement } }).__fixture.video.currentTime > 100.2);
    const origin = Date.now();
    await sendToContent(serviceWorker, tabId, { type: 'content.sessionStarted', sessionId: 'e2e', audioOriginWall: origin });
    // Let the tracker take a sample, then deliver a final covering "now" (video ≈ 100–103 s).
    await page.waitForTimeout(1200);
    const nowMs = Date.now() - origin;
    await sendToContent(serviceWorker, tabId, transcript('c', 0, 'final', 'Cached sentence.', Math.max(0, nowMs - 1000), nowMs + 1500, '缓存的句子。'));
    await expect.poll(() => overlayLines(page)).toEqual([{ source: 'Cached sentence.', translated: '缓存的句子。', partial: false }]);

    // Move far away (screen clears), then back into the cached range.
    await page.evaluate(() => { (window as unknown as { __fixture: { video: HTMLVideoElement } }).__fixture.video.currentTime = 400; });
    await page.waitForFunction(() => (window as unknown as { __fixture: { video: HTMLVideoElement } }).__fixture.video.currentTime >= 399);
    await expect.poll(() => overlayLines(page)).toEqual([]);
    await page.evaluate(() => { (window as unknown as { __fixture: { video: HTMLVideoElement } }).__fixture.video.currentTime = 101; });
    await expect.poll(() => overlayLines(page), { timeout: 5000 }).toEqual([{ source: 'Cached sentence.', translated: '缓存的句子。', partial: false }]);
    expect(await page.evaluate(video)).toBeTruthy();
    await sendToContent(serviceWorker, tabId, { type: 'content.sessionStopped' });
  });

  test('style changes in storage apply to the overlay immediately', async ({ context, serviceWorker, youtubeUrl, extensionId }) => {
    const page = await context.newPage();
    await page.goto(youtubeUrl);
    const tabId = await tabIdFor(serviceWorker, '*://www.youtube.com/*');
    await waitForContentScript(serviceWorker, tabId);
    await sendToContent(serviceWorker, tabId, { type: 'content.sessionStarted', sessionId: 'e2e', audioOriginWall: Date.now() });
    await sendToContent(serviceWorker, tabId, transcript('s', 0, 'final', 'Styled.', 0, 500, '样式。'));
    await expect.poll(() => overlayLines(page)).toHaveLength(1);
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await popup.evaluate(async () => {
      const { settings } = await chrome.storage.local.get('settings');
      await chrome.storage.local.set({ settings: { ...(settings ?? {}), style: { fontSize: 33, position: 22, backgroundOpacity: 0.5, showSource: false, showTranslated: true } } });
    });
    await expect
      .poll(() =>
        page.evaluate(() => {
          const root = document.getElementById('lst-subtitle-overlay')?.shadowRoot?.querySelector<HTMLElement>('.lst-root');
          return root ? [root.style.getPropertyValue('--lst-font-size'), root.style.getPropertyValue('--lst-bottom'), root.shadowRoot === null] : null;
        }),
      )
      .toEqual(['33px', '22%', true]);
    await expect.poll(() => overlayLines(page)).toEqual([{ source: null, translated: '样式。', partial: false }]);
    await sendToContent(serviceWorker, tabId, { type: 'content.sessionStopped' });
  });
});
