import type { Platform } from '../shared/platform.js';

/**
 * Locate the element that visually contains the video for each platform.
 * The overlay is appended *inside* this element so it follows the player
 * into fullscreen (the player container is the fullscreen element).
 */
const CONTAINER_SELECTORS: Record<Platform, string[]> = {
  youtube: ['#movie_player', '.html5-video-player'],
  twitch: ['[data-a-target="video-player"]', '.video-player__container', '.video-player'],
};

export interface PlayerInfo {
  container: HTMLElement;
  video: HTMLVideoElement | null;
}

export function findPlayer(root: ParentNode, platform: Platform): PlayerInfo | null {
  for (const selector of CONTAINER_SELECTORS[platform]) {
    const container = root.querySelector<HTMLElement>(selector);
    if (container !== null) {
      return { container, video: container.querySelector<HTMLVideoElement>('video') };
    }
  }
  return null;
}
