// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { findPlayer } from './player-detect.js';
import { detectPlatform } from '../shared/platform.js';

describe('detectPlatform', () => {
  it('recognises youtube and twitch hosts', () => {
    expect(detectPlatform('www.youtube.com')).toBe('youtube');
    expect(detectPlatform('m.youtube.com')).toBe('youtube');
    expect(detectPlatform('youtube.com')).toBe('youtube');
    expect(detectPlatform('www.twitch.tv')).toBe('twitch');
    expect(detectPlatform('twitch.tv')).toBe('twitch');
  });
  it('rejects lookalikes and other hosts', () => {
    expect(detectPlatform('notyoutube.com')).toBeNull();
    expect(detectPlatform('youtube.com.evil.example')).toBeNull();
    expect(detectPlatform('example.com')).toBeNull();
  });
});

describe('findPlayer', () => {
  it('finds the YouTube player container and its video', () => {
    document.body.innerHTML = `<div id="movie_player" class="html5-video-player"><div class="html5-video-container"><video></video></div></div>`;
    const player = findPlayer(document, 'youtube');
    expect(player?.container.id).toBe('movie_player');
    expect(player?.video?.tagName).toBe('VIDEO');
  });
  it('finds the Twitch player container', () => {
    document.body.innerHTML = `<div class="video-player__container" data-a-target="video-player"><video></video></div>`;
    const player = findPlayer(document, 'twitch');
    expect(player?.container.dataset['aTarget']).toBe('video-player');
  });
  it('returns null when there is no player', () => {
    document.body.innerHTML = `<div>nothing here</div>`;
    expect(findPlayer(document, 'youtube')).toBeNull();
    expect(findPlayer(document, 'twitch')).toBeNull();
  });
});
