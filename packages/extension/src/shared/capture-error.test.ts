import { describe, expect, it } from 'vitest';
import { describeCaptureError } from './capture-error.js';

describe('describeCaptureError', () => {
  it('adds an actionable hint for the activeTab error', () => {
    const msg = describeCaptureError(new Error('Extension has not been invoked for the current page (see activeTab permission).'), 5, 'popup');
    expect(msg).toContain('tab 5');
    expect(msg).toContain('popup');
    expect(msg).toMatch(/Hint: open the popup/);
  });
  it('passes other errors through without the hint', () => {
    const msg = describeCaptureError('boom', 1, 'service worker');
    expect(msg).toBe('Tab capture failed in service worker for tab 1: boom');
  });
});
