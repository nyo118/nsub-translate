// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { youtubeAdapter } from './youtube.js';
import { twitchAdapter } from './twitch.js';

describe('PlayerAdapter controls / live detection', () => {
  it('YouTube: lifts subtitles only while the control bar is visible (no ytp-autohide)', () => {
    document.body.innerHTML = `<div id="movie_player" class="html5-video-player ytp-autohide"><video></video><div class="ytp-chrome-bottom"></div></div>`;
    expect(youtubeAdapter.controlsLift(document)).toBe(0);
    document.getElementById('movie_player')!.classList.remove('ytp-autohide');
    expect(youtubeAdapter.controlsLift(document)).toBeGreaterThanOrEqual(48);
    expect(youtubeAdapter.findVideo(document)?.tagName).toBe('VIDEO');
    expect(youtubeAdapter.isLive(document, youtubeAdapter.findVideo(document))).toBe(false);
    document.getElementById('movie_player')!.classList.add('ytp-live');
    expect(youtubeAdapter.isLive(document, null)).toBe(true);
  });

  it('Twitch: channel pages are live, VOD/clip paths are not; no controls element → no lift', () => {
    document.body.innerHTML = `<div data-a-target="video-player"><video></video></div>`;
    expect(twitchAdapter.controlsLift(document)).toBe(0);
    expect(twitchAdapter.findVideo(document)?.tagName).toBe('VIDEO');
    expect(twitchAdapter.isLive(document, null)).toBe(true);
  });

  it('YouTube: an ad is playing while the player carries ad-showing / ad-interrupting', () => {
    document.body.innerHTML = `<div id="movie_player" class="html5-video-player"><video></video></div>`;
    expect(youtubeAdapter.isAdPlaying(document)).toBe(false);
    document.getElementById('movie_player')!.classList.add('ad-showing');
    expect(youtubeAdapter.isAdPlaying(document)).toBe(true);
    document.getElementById('movie_player')!.className = 'html5-video-player ad-interrupting';
    expect(youtubeAdapter.isAdPlaying(document)).toBe(true);
    document.body.innerHTML = '';
    expect(youtubeAdapter.isAdPlaying(document)).toBe(false);
  });

  it('Twitch: an ad is playing while the player shows an ad label / countdown', () => {
    document.body.innerHTML = `<div data-a-target="video-player"><video></video></div>`;
    expect(twitchAdapter.isAdPlaying(document)).toBe(false);
    document.querySelector('[data-a-target="video-player"]')!.insertAdjacentHTML('beforeend', '<span data-a-target="video-ad-label">Ad</span>');
    expect(twitchAdapter.isAdPlaying(document)).toBe(true);
    document.querySelector('[data-a-target="video-ad-label"]')!.remove();
    document.querySelector('[data-a-target="video-player"]')!.insertAdjacentHTML('beforeend', '<span data-a-target="video-ad-countdown">0:15</span>');
    expect(twitchAdapter.isAdPlaying(document)).toBe(true);
    // A label outside the player (e.g. the display ad above chat) does not count.
    document.body.innerHTML = `<div data-a-target="video-player"><video></video></div><span data-a-target="video-ad-label">Ad</span>`;
    expect(twitchAdapter.isAdPlaying(document)).toBe(false);
  });
});
