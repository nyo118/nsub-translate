import type { PlayerAdapter } from './players/index.js';
import type { SubtitleOverlay } from './overlay.js';
import type { SubtitleLine } from './subtitle-state.js';

/**
 * Keeps the overlay attached to the *current* player container. When the
 * adapter reports a change (or the periodic check finds the container gone
 * or replaced), the overlay is remounted and the last subtitles re-rendered.
 * Pure DOM logic → unit-tested with happy-dom.
 */
export class OverlayBinder {
  private readonly doc: Document;
  private readonly adapter: PlayerAdapter;
  private readonly overlay: SubtitleOverlay;
  private readonly getLines: () => SubtitleLine[];
  private stopWatching: (() => void) | null = null;
  private remounts = 0;

  constructor(doc: Document, adapter: PlayerAdapter, overlay: SubtitleOverlay, getLines: () => SubtitleLine[]) {
    this.doc = doc;
    this.adapter = adapter;
    this.overlay = overlay;
    this.getLines = getLines;
  }

  get remountCount(): number {
    return this.remounts;
  }

  /** Mount if possible and start watching. Returns whether a player was found. */
  bind(): boolean {
    const found = this.ensureMounted();
    if (this.stopWatching === null) this.stopWatching = this.adapter.watch(this.doc, () => this.ensureMounted());
    return found;
  }

  /** Stop watching and remove the overlay. Idempotent. */
  unbind(): void {
    this.stopWatching?.();
    this.stopWatching = null;
    this.overlay.unmount();
  }

  /** Make sure the overlay lives inside the current container. Returns whether it is mounted. */
  ensureMounted(): boolean {
    const container = this.adapter.findContainer(this.doc);
    if (container === null) {
      // Player gone (navigated to a non-video page): drop the stale overlay.
      if (this.overlay.mounted) this.overlay.unmount();
      return false;
    }
    if (this.overlay.mounted && this.overlay.container === container && container.isConnected) return true;
    this.overlay.mount(container);
    this.remounts += 1;
    this.overlay.render(this.getLines());
    return true;
  }
}
