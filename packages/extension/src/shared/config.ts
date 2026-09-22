/**
 * Phase 0 constants. Phase 1 turns these into user settings.
 */
export const BACKEND_WS_URL = 'ws://127.0.0.1:8787/ws';

export const PHASE0_LANGUAGES = {
  sourceLanguage: 'en',
  targetLanguage: 'zh-CN',
} as const;

/** How long the offscreen document waits for `session.ready` from the backend. */
export const SESSION_READY_TIMEOUT_MS = 5000;

/** How long the offscreen document waits for `session.stopped` on stop before closing anyway. */
export const SESSION_STOP_TIMEOUT_MS = 800;

export const OVERLAY_HOST_ID = 'lst-subtitle-overlay';
