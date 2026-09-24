import type { PlayerAdapter } from './types.js';

const SELECTORS = ['[data-a-target="video-player"]', '.video-player__container', '.video-player'];
const HEALTH_CHECK_MS = 1000;

/** Twitch: detection + rebinding only. Audio capture compatibility is validated in Phase 4. */
export const twitchAdapter: PlayerAdapter = {
  platform: 'twitch',
  findContainer(root) {
    for (const selector of SELECTORS) {
      const el = root.querySelector<HTMLElement>(selector);
      if (el !== null) return el;
    }
    return null;
  },
  findVideo(root) {
    return this.findContainer(root)?.querySelector<HTMLVideoElement>('video') ?? null;
  },
  isLive(_root, _video) {
    // Twitch: channel pages are live; /videos/<id> and /<channel>/clip/<id> URLs are on-demand.
    const path = typeof location !== 'undefined' ? location.pathname : '';
    return !/^\/(videos|[^/]+\/clip)\//.test(path);
  },
  watch(doc, onChange) {
    doc.addEventListener('fullscreenchange', onChange);
    const timer = setInterval(onChange, HEALTH_CHECK_MS);
    return () => {
      doc.removeEventListener('fullscreenchange', onChange);
      clearInterval(timer);
    };
  },
};
