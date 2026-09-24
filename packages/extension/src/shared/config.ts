/**
 * Build-time constants. The backend URL becomes a setting in a later phase.
 */
export const BACKEND_WS_URL = 'ws://127.0.0.1:8787/ws';

/**
 * How long the offscreen document waits for `session.ready` from the backend.
 * Generous because a translation engine chosen for the first time is loaded
 * lazily by the backend (a 1 GB local model can take 10–40 s on a busy CPU).
 */
export const SESSION_READY_TIMEOUT_MS = 60_000;

/** How long the offscreen document waits for `session.stopped` on stop before closing anyway. */
export const SESSION_STOP_TIMEOUT_MS = 800;

export const OVERLAY_HOST_ID = 'lst-subtitle-overlay';
