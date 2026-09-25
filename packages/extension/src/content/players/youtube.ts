import type { PlayerAdapter } from './types.js';

/** Events YouTube dispatches on its SPA navigations and player mode changes. */
const YOUTUBE_EVENTS = ['yt-navigate-finish', 'yt-page-data-updated', 'fullscreenchange'];
const HEALTH_CHECK_MS = 1000;

export const youtubeAdapter: PlayerAdapter = {
  platform: 'youtube',
  findContainer(root) {
    return root.querySelector<HTMLElement>('#movie_player') ?? root.querySelector<HTMLElement>('.html5-video-player');
  },
  findVideo(root) {
    return this.findContainer(root)?.querySelector<HTMLVideoElement>('video.html5-main-video, video') ?? null;
  },
  controlsLift(root) {
    const container = this.findContainer(root);
    if (container === null || container.classList.contains('ytp-autohide')) return 0;
    // Controls visible: bottom chrome (~48 px) plus the progress bar.
    const bar = container.querySelector<HTMLElement>('.ytp-chrome-bottom');
    return (bar?.offsetHeight || 48) + 12;
  },
  isLive(root, video) {
    const container = this.findContainer(root);
    // YouTube marks live players with the `ytp-live` class and a live badge; an infinite duration is the generic signal.
    if (container?.classList.contains('ytp-live') || container?.querySelector('.ytp-live-badge:not([disabled])') !== null) return true;
    return video !== null && video.duration === Infinity;
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
