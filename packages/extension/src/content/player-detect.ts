import type { Platform } from '../shared/platform.js';
import { adapterFor } from './players/index.js';

export interface PlayerInfo {
  container: HTMLElement;
  video: HTMLVideoElement | null;
}

/** Convenience wrapper kept for callers that only need a one-off lookup. */
export function findPlayer(root: ParentNode, platform: Platform): PlayerInfo | null {
  const container = adapterFor(platform)?.findContainer(root) ?? null;
  if (container === null) return null;
  return { container, video: container.querySelector<HTMLVideoElement>('video') };
}
