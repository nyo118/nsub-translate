import type { PlayerAdapter } from './types.js';

/** Events YouTube dispatches on its SPA navigations and player mode changes. */
const YOUTUBE_EVENTS = ['yt-navigate-finish', 'yt-page-data-updated', 'fullscreenchange'];
const HEALTH_CHECK_MS = 1000;

export const youtubeAdapter: PlayerAdapter = {
  platform: 'youtube',
  findContainer(root) {
    return root.querySelector<HTMLElement>('#movie_player') ?? root.querySelector<HTMLElement>('.html5-video-player');
  },
  watch(doc, onChange) {
    for (const name of YOUTUBE_EVENTS) doc.addEventListener(name, onChange);
    // YouTube replaces the player element in some transitions (mini-player,
    // channel → watch) without a dedicated event, so also poll cheaply.
    const timer = setInterval(onChange, HEALTH_CHECK_MS);
    return () => {
      for (const name of YOUTUBE_EVENTS) doc.removeEventListener(name, onChange);
      clearInterval(timer);
    };
  },
};
