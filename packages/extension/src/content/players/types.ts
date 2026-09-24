import type { Platform } from '../../shared/platform.js';

/**
 * A PlayerAdapter knows how to find the video player container of one
 * platform and how to notice that it changed (SPA navigation, fullscreen,
 * theater/mini-player mode). The content script is platform-agnostic.
 */
export interface PlayerAdapter {
  readonly platform: Platform;
  /** The element the overlay is appended to, or null if no player is present. */
  findContainer(root: ParentNode): HTMLElement | null;
  /** The <video> element driving playback, or null. */
  findVideo(root: ParentNode): HTMLVideoElement | null;
  /** Whether the current page is a live stream (no seeking, no replay cache). */
  isLive(root: ParentNode, video: HTMLVideoElement | null): boolean;
  /**
   * Start watching for player changes. `onChange` is called whenever the
   * adapter believes the container may have changed; the caller re-checks.
   * Returns a function that stops watching.
   */
  watch(doc: Document, onChange: () => void): () => void;
}
