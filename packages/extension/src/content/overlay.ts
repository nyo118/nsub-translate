import { OVERLAY_HOST_ID } from '../shared/config.js';
import { DEFAULT_STYLE, FONT_FAMILIES, type SubtitleStyle } from '../shared/settings.js';
import type { SubtitleLine } from './subtitle-state.js';

/** Reference player width for `fontSize`; auto-scale is relative to this. */
export const REFERENCE_WIDTH = 1280;
export const SCALE_MIN = 0.55;
export const SCALE_MAX = 2.2;

const STYLES = `
  :host { all: initial; }
  .lst-root {
    position: absolute;
    left: 0; right: 0;
    bottom: calc(var(--lst-bottom, 10%) + var(--lst-lift, 0px));
    display: flex; flex-direction: column; align-items: center; gap: 4px;
    pointer-events: none;
    z-index: 2147483000;
    font-family: var(--lst-font-family, "Helvetica Neue", Arial, "PingFang SC", "Microsoft YaHei", sans-serif);
    text-align: center;
    padding: 0 6%;
    box-sizing: border-box;
    transition: bottom 160ms ease-out;
  }
  .lst-line {
    max-width: 100%;
    background: rgba(0, 0, 0, var(--lst-bg-alpha, 0.72));
    color: #fff;
    border-radius: 6px;
    padding: 6px 12px;
    line-height: 1.35;
    text-shadow: var(--lst-text-shadow, 0 1px 2px rgba(0,0,0,0.9));
    word-break: break-word;
  }
  /* The current (last) box keeps a stable height so growing partials do not bounce the layout. */
  .lst-line.lst-current { min-height: var(--lst-min-height, 0px); display: flex; flex-direction: column; justify-content: center; }
  .lst-source, .lst-translated {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: var(--lst-max-lines, 2);
    overflow: hidden;
  }
  .lst-source { font-size: calc(var(--lst-font-size, 22px) * var(--lst-scale, 1) * 0.9); }
  .lst-translated { font-size: calc(var(--lst-font-size, 22px) * var(--lst-scale, 1)); font-weight: 600; margin-top: 2px; }
  .lst-partial .lst-source { opacity: 0.85; font-style: italic; }
  .lst-partial .lst-translated { opacity: 0.7; }
  .lst-badge { font-size: 11px; color: #9be7d0; letter-spacing: 0.04em; }
`;

/** Outline = dark stroke around glyphs (simulated with 8 shadows), on top of the default drop shadow. */
const OUTLINE_SHADOW = '-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000, 0 -1px 0 #000, 0 1px 0 #000, -1px 0 0 #000, 1px 0 0 #000, 0 2px 3px rgba(0,0,0,0.9)';

/**
 * Bilingual subtitle overlay rendered inside the player container via a
 * Shadow DOM host. Only one overlay can exist per document: mounting first
 * removes any previous host with the same id.
 */
export class SubtitleOverlay {
  private host: HTMLElement | null = null;
  private root: HTMLElement | null = null;
  private readonly doc: Document;
  private style: SubtitleStyle = { ...DEFAULT_STYLE };
  private lastLines: SubtitleLine[] = [];
  private scale = 1;
  private lift = 0;
  private resizeObserver: ResizeObserver | null = null;

  constructor(doc: Document) {
    this.doc = doc;
  }

  get mounted(): boolean {
    return this.host !== null && this.host.isConnected;
  }

  get container(): HTMLElement | null {
    return this.host?.parentElement ?? null;
  }

  mount(container: HTMLElement): void {
    // Remove any previous overlay (ours or from an earlier content-script instance).
    for (const stale of Array.from(this.doc.querySelectorAll(`#${OVERLAY_HOST_ID}`))) stale.remove();
    const host = this.doc.createElement('div');
    host.id = OVERLAY_HOST_ID;
    host.style.cssText = 'position:absolute;inset:0;pointer-events:none;';
    const shadow = host.attachShadow({ mode: 'open' });
    const style = this.doc.createElement('style');
    style.textContent = STYLES;
    const root = this.doc.createElement('div');
    root.className = 'lst-root';
    shadow.append(style, root);
    container.appendChild(host);
    this.host = host;
    this.root = root;
    this.applyStyle();
    this.observeSize(container);
  }

  /** Follow the player's width for auto-scaling. */
  private observeSize(container: HTMLElement): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (typeof ResizeObserver === 'undefined') return;
    this.resizeObserver = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? container.clientWidth;
      this.setPlayerWidth(width);
    });
    this.resizeObserver.observe(container);
    this.setPlayerWidth(container.clientWidth);
  }

  /** Compute the auto-scale factor from the player width (no-op when disabled). */
  setPlayerWidth(width: number): void {
    const next = this.style.autoScale && width > 0 ? Math.min(SCALE_MAX, Math.max(SCALE_MIN, width / REFERENCE_WIDTH)) : 1;
    if (Math.abs(next - this.scale) < 0.02) return;
    this.scale = next;
    this.applyStyle();
  }

  get currentScale(): number {
    return this.scale;
  }

  /** Raise the overlay by `px` while the player's controls are visible. */
  setLift(px: number): void {
    const next = this.style.avoidControls ? px : 0;
    if (next === this.lift) return;
    this.lift = next;
    this.root?.style.setProperty('--lst-lift', `${next}px`);
  }

  get currentLift(): number {
    return this.lift;
  }

  /** Apply user style immediately; re-renders the current lines. */
  setStyle(style: SubtitleStyle): void {
    this.style = { ...style };
    this.applyStyle();
    this.render(this.lastLines);
  }

  private applyStyle(): void {
    if (this.root === null) return;
    const r = this.root.style;
    r.setProperty('--lst-font-size', `${this.style.fontSize}px`);
    r.setProperty('--lst-bottom', `${this.style.position}%`);
    r.setProperty('--lst-bg-alpha', String(this.style.backgroundOpacity));
    r.setProperty('--lst-scale', String(this.style.autoScale ? this.scale : 1));
    r.setProperty('--lst-font-family', FONT_FAMILIES.find((f) => f.code === this.style.fontFamily)?.css ?? FONT_FAMILIES[0]!.css);
    r.setProperty('--lst-max-lines', String(this.style.maxLines));
    r.setProperty('--lst-text-shadow', this.style.outline ? OUTLINE_SHADOW : '0 1px 2px rgba(0,0,0,0.9)');
    // One source row + one translated row at the effective size, so a partial that has no
    // translation yet already reserves the space the translation will take.
    const rows = (this.style.showSource ? 0.9 : 0) + (this.style.showTranslated ? 1 : 0);
    const px = this.style.fontSize * (this.style.autoScale ? this.scale : 1);
    r.setProperty('--lst-min-height', `${Math.round(rows * px * 1.35 + 12)}px`);
    if (!this.style.avoidControls && this.lift !== 0) {
      this.lift = 0;
      r.setProperty('--lst-lift', '0px');
    }
  }

  render(lines: SubtitleLine[]): void {
    this.lastLines = lines;
    if (this.root === null) return;
    this.root.replaceChildren();
    lines.forEach((line, index) => {
      const showSource = this.style.showSource;
      const showTranslated = this.style.showTranslated && line.translatedText !== undefined;
      if (!showSource && !showTranslated) return;
      const el = this.doc.createElement('div');
      el.className = `lst-line ${line.status === 'partial' ? 'lst-partial' : 'lst-final'}${index === lines.length - 1 ? ' lst-current' : ''}`;
      if (showSource) {
        const source = this.doc.createElement('div');
        source.className = 'lst-source';
        source.textContent = line.sourceText;
        el.appendChild(source);
      }
      if (showTranslated) {
        const translated = this.doc.createElement('div');
        translated.className = 'lst-translated';
        translated.textContent = line.translatedText ?? '';
        el.appendChild(translated);
      }
      this.root!.appendChild(el);
    });
  }

  renderNotice(text: string): void {
    if (this.root === null) return;
    const el = this.doc.createElement('div');
    el.className = 'lst-line';
    const badge = this.doc.createElement('div');
    badge.className = 'lst-badge';
    badge.textContent = text;
    el.appendChild(badge);
    this.root.replaceChildren(el);
  }

  unmount(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.host?.remove();
    this.host = null;
    this.root = null;
    this.lastLines = [];
    this.lift = 0;
  }
}
