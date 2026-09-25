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
});
