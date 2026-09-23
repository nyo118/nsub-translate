// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OverlayBinder } from './overlay-binder.js';
import { SubtitleOverlay } from './overlay.js';
import { youtubeAdapter } from './players/youtube.js';
import { twitchAdapter } from './players/twitch.js';
import { OVERLAY_HOST_ID } from '../shared/config.js';

const lines = [{ sourceText: 'Hello', translatedText: '你好', status: 'final' as const }];

function overlayCount() {
  return document.querySelectorAll(`#${OVERLAY_HOST_ID}`).length;
}

describe('OverlayBinder (YouTube)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = `<div id="page"><div id="movie_player"><video></video></div></div>`;
  });
  afterEach(() => vi.useRealTimers());

  it('mounts into the player and re-renders the current lines', () => {
    const overlay = new SubtitleOverlay(document);
    const binder = new OverlayBinder(document, youtubeAdapter, overlay, () => lines);
    expect(binder.bind()).toBe(true);
    expect(document.querySelector('#movie_player')!.querySelector(`#${OVERLAY_HOST_ID}`)).not.toBeNull();
    expect(overlay.mounted).toBe(true);
    binder.unbind();
  });

  it('remounts when YouTube replaces the player element (SPA navigation)', () => {
    const overlay = new SubtitleOverlay(document);
    const binder = new OverlayBinder(document, youtubeAdapter, overlay, () => lines);
    binder.bind();
    // Simulate navigation: old player removed, a new one inserted.
    document.querySelector('#movie_player')!.remove();
    document.getElementById('page')!.innerHTML = `<div id="movie_player" class="new"><video></video></div>`;
    expect(overlayCount()).toBe(0);
    document.dispatchEvent(new Event('yt-navigate-finish'));
    expect(overlayCount()).toBe(1);
    const host = document.querySelector('#movie_player.new')!.querySelector(`#${OVERLAY_HOST_ID}`)!;
    expect(host.shadowRoot!.querySelector('.lst-translated')!.textContent).toBe('你好');
    expect(binder.remountCount).toBe(2);
    binder.unbind();
  });

  it('the periodic check also recovers, and does nothing while the container is stable', () => {
    const overlay = new SubtitleOverlay(document);
    const binder = new OverlayBinder(document, youtubeAdapter, overlay, () => lines);
    binder.bind();
    vi.advanceTimersByTime(3000);
    expect(binder.remountCount).toBe(1);
    document.getElementById('page')!.innerHTML = `<div id="movie_player"></div>`;
    vi.advanceTimersByTime(1000);
    expect(binder.remountCount).toBe(2);
    expect(overlayCount()).toBe(1);
    binder.unbind();
  });

  it('removes the overlay when the player disappears and stops reacting after unbind', () => {
    const overlay = new SubtitleOverlay(document);
    const binder = new OverlayBinder(document, youtubeAdapter, overlay, () => lines);
    binder.bind();
    document.getElementById('page')!.innerHTML = `<p>no player here</p>`;
    document.dispatchEvent(new Event('yt-navigate-finish'));
    expect(overlayCount()).toBe(0);
    expect(overlay.mounted).toBe(false);
    binder.unbind();
    document.getElementById('page')!.innerHTML = `<div id="movie_player"></div>`;
    vi.advanceTimersByTime(5000);
    document.dispatchEvent(new Event('yt-navigate-finish'));
    expect(overlayCount()).toBe(0);
  });

  it('reports no player when the page has none', () => {
    document.body.innerHTML = `<div id="page"></div>`;
    const binder = new OverlayBinder(document, youtubeAdapter, new SubtitleOverlay(document), () => []);
    expect(binder.bind()).toBe(false);
    binder.unbind();
  });
});

describe('OverlayBinder (Twitch)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('binds to the Twitch player and remounts after a channel switch', () => {
    document.body.innerHTML = `<div id="page"><div data-a-target="video-player"><video></video></div></div>`;
    const binder = new OverlayBinder(document, twitchAdapter, new SubtitleOverlay(document), () => lines);
    expect(binder.bind()).toBe(true);
    document.getElementById('page')!.innerHTML = `<div class="video-player__container"><video></video></div>`;
    vi.advanceTimersByTime(1000);
    expect(overlayCount()).toBe(1);
    expect(document.querySelector('.video-player__container')!.querySelector(`#${OVERLAY_HOST_ID}`)).not.toBeNull();
    binder.unbind();
  });
});
