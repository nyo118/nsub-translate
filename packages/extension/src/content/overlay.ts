import { OVERLAY_HOST_ID } from '../shared/config.js';
import type { SubtitleLine } from './subtitle-state.js';

const STYLES = `
  :host { all: initial; }
  .lst-root {
    position: absolute;
    left: 0; right: 0; bottom: 10%;
    display: flex; flex-direction: column; align-items: center; gap: 4px;
    pointer-events: none;
    z-index: 2147483000;
    font-family: "Helvetica Neue", Arial, "PingFang SC", "Microsoft YaHei", sans-serif;
    text-align: center;
    padding: 0 6%;
    box-sizing: border-box;
  }
  .lst-line {
    max-width: 100%;
    background: rgba(0, 0, 0, 0.72);
    color: #fff;
    border-radius: 6px;
    padding: 6px 12px;
    line-height: 1.35;
    text-shadow: 0 1px 2px rgba(0,0,0,0.9);
    word-break: break-word;
  }
  .lst-source { font-size: 20px; }
  .lst-translated { font-size: 22px; font-weight: 600; margin-top: 2px; }
  .lst-partial .lst-source { opacity: 0.85; font-style: italic; }
  .lst-partial .lst-translated { opacity: 0.7; }
  .lst-badge { font-size: 11px; color: #9be7d0; letter-spacing: 0.04em; }
`;

/**
 * Bilingual subtitle overlay rendered inside the player container via a
 * Shadow DOM host. Only one overlay can exist per document: mounting first
 * removes any previous host with the same id.
 */
export class SubtitleOverlay {
  private host: HTMLElement | null = null;
  private root: HTMLElement | null = null;
  private readonly doc: Document;

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
  }

  render(lines: SubtitleLine[]): void {
    if (this.root === null) return;
    this.root.replaceChildren();
    for (const line of lines) {
      const el = this.doc.createElement('div');
      el.className = `lst-line ${line.status === 'partial' ? 'lst-partial' : 'lst-final'}`;
      const source = this.doc.createElement('div');
      source.className = 'lst-source';
      source.textContent = line.sourceText;
      el.appendChild(source);
      if (line.translatedText !== undefined) {
        const translated = this.doc.createElement('div');
        translated.className = 'lst-translated';
        translated.textContent = line.translatedText;
        el.appendChild(translated);
      }
      this.root.appendChild(el);
    }
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
    this.host?.remove();
    this.host = null;
    this.root = null;
  }
}
