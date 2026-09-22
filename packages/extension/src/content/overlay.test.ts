// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { SubtitleOverlay } from './overlay.js';
import { OVERLAY_HOST_ID } from '../shared/config.js';

describe('SubtitleOverlay', () => {
  let container: HTMLElement;
  beforeEach(() => {
    document.body.innerHTML = `<div id="movie_player"></div>`;
    container = document.getElementById('movie_player')!;
  });

  it('mounts one host inside the container and renders bilingual lines', () => {
    const overlay = new SubtitleOverlay(document);
    overlay.mount(container);
    overlay.render([
      { sourceText: 'Hello', translatedText: '你好', status: 'final' },
      { sourceText: 'Partial', translatedText: undefined, status: 'partial' },
    ]);
    const host = container.querySelector<HTMLElement>(`#${OVERLAY_HOST_ID}`)!;
    expect(host).not.toBeNull();
    const lines = host.shadowRoot!.querySelectorAll('.lst-line');
    expect(lines).toHaveLength(2);
    expect(lines[0]!.querySelector('.lst-source')!.textContent).toBe('Hello');
    expect(lines[0]!.querySelector('.lst-translated')!.textContent).toBe('你好');
    expect(lines[1]!.querySelector('.lst-translated')).toBeNull();
    expect(lines[1]!.classList.contains('lst-partial')).toBe(true);
    expect(overlay.mounted).toBe(true);
  });

  it('mounting twice (or from two instances) never leaves two overlays', () => {
    const a = new SubtitleOverlay(document);
    const b = new SubtitleOverlay(document);
    a.mount(container);
    a.mount(container);
    b.mount(container);
    expect(document.querySelectorAll(`#${OVERLAY_HOST_ID}`)).toHaveLength(1);
    expect(a.mounted).toBe(false); // a's host was removed by b
    expect(b.mounted).toBe(true);
  });

  it('unmount removes the host and is idempotent', () => {
    const overlay = new SubtitleOverlay(document);
    overlay.mount(container);
    overlay.unmount();
    overlay.unmount();
    expect(document.querySelectorAll(`#${OVERLAY_HOST_ID}`)).toHaveLength(0);
    expect(overlay.mounted).toBe(false);
    overlay.render([{ sourceText: 'x', translatedText: undefined, status: 'partial' }]); // no throw
  });

  it('does not touch the player container apart from appending the host', () => {
    container.innerHTML = `<video></video><div class="ytp-chrome-bottom"></div>`;
    const overlay = new SubtitleOverlay(document);
    overlay.mount(container);
    expect(container.children).toHaveLength(3);
    expect(container.lastElementChild!.id).toBe(OVERLAY_HOST_ID);
    overlay.unmount();
    expect(container.children).toHaveLength(2);
  });
});
