import type { PlayerAdapter } from './types.js';

const SELECTORS = ['[data-a-target="video-player"]', '.video-player__container', '.video-player'];
/**
 * Elements Twitch renders inside the player only while a video ad runs (the
 * "Ad · 0:15" label / countdown and the ad overlay). Twitch changes its DOM
 * without notice, so this list is best-effort; see COMPATIBILITY.md.
 */
const AD_SELECTORS = ['[data-a-target="video-ad-label"]', '[data-a-target="video-ad-countdown"]', '[data-a-target="player-ad-overlay"]', '[data-test-selector="ad-banner-default-text"]', '.video-player__overlay [data-a-target="ad-banner-default-text"]'];
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
  controlsLift(root) {
    const container = this.findContainer(root);
    if (container === null) return 0;
    // Twitch keeps the controls in the DOM; they fade via the player's own state class / hover.
    const controls = container.querySelector<HTMLElement>('[data-a-target="player-controls"], .player-controls');
    if (controls === null) return 0;
    const visible = controls.offsetHeight > 0 && (container.matches(':hover') || getComputedStyle(controls).opacity !== '0');
    return visible ? controls.offsetHeight + 12 : 0;
  },
  isAdPlaying(root) {
    const container = this.findContainer(root);
    if (container === null) return false;
    return AD_SELECTORS.some((selector) => container.querySelector(selector) !== null);
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
