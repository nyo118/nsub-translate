import { BackendClient } from './backend-client.js';
import { startTabAudioCapture, type AudioCaptureHandle } from './audio-capture.js';
import { SESSION_READY_TIMEOUT_MS, SESSION_STOP_TIMEOUT_MS } from '../shared/config.js';
import {
  isTargeted,
  type OffscreenPingResponse,
  type OffscreenStartRequest,
  type OffscreenStartResponse,
  type OffscreenStopResponse,
  type OffscreenToBackground,
  type ToOffscreen,
} from '../shared/messages.js';

/**
 * Offscreen document. Owns exactly one capture + one backend connection.
 * It survives service-worker restarts, so it must be able to be stopped
 * by a worker that has no memory of starting it.
 */

const LEVEL_INTERVAL_MS = 200;

let capture: AudioCaptureHandle | null = null;
let client: BackendClient | null = null;
let levelTimer: ReturnType<typeof setInterval> | null = null;
let stopping: Promise<OffscreenStopResponse> | null = null;

function log(message: string, data?: unknown): void {
  console.info(`[LST/offscreen] ${message}`, data ?? '');
}

function toBackground(message: OffscreenToBackground): void {
  chrome.runtime.sendMessage(message).catch((err: unknown) => {
    // The worker may be restarting; transient failures are expected.
    console.warn('[LST/offscreen] message to background failed', err);
  });
}

async function start(req: OffscreenStartRequest): Promise<OffscreenStartResponse> {
  if (capture !== null || client !== null) {
    return { ok: false, error: 'Offscreen document is already capturing. Stop the current session first.' };
  }
  let localCapture: AudioCaptureHandle | null = null;
  const localClient = new BackendClient({
    onMessage: (message) => {
      if (message.type === 'transcript') toBackground({ target: 'background', type: 'offscreen.transcript', transcript: message });
      else if (message.type === 'session.error') log('backend error', message);
    },
    onClose: (reason) => {
      log('backend connection closed unexpectedly', reason);
      toBackground({ target: 'background', type: 'offscreen.disconnected', reason });
    },
    onInvalid: (error) => console.warn('[LST/offscreen] invalid backend message', error),
  });
  try {
    localCapture = await startTabAudioCapture(req.streamId, (reason) => {
      toBackground({ target: 'background', type: 'offscreen.disconnected', reason });
    });
    log('tab audio captured', { tracks: localCapture.stream.getAudioTracks().length, audioContext: localCapture.context.state });
    const sessionId = await localClient.connect(
      req.backendUrl,
      { sourceLanguage: req.sourceLanguage, targetLanguage: req.targetLanguage },
      SESSION_READY_TIMEOUT_MS,
    );
    capture = localCapture;
    client = localClient;
    levelTimer = setInterval(() => {
      if (capture !== null) toBackground({ target: 'background', type: 'offscreen.level', level: capture.level() });
    }, LEVEL_INTERVAL_MS);
    log('session ready', sessionId);
    return { ok: true, sessionId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log('start failed, releasing', message);
    await localClient.disconnect(0);
    if (localCapture !== null) await localCapture.release();
    return { ok: false, error: message };
  }
}

function stop(): Promise<OffscreenStopResponse> {
  if (stopping !== null) return stopping;
  stopping = (async () => {
    if (levelTimer !== null) {
      clearInterval(levelTimer);
      levelTimer = null;
    }
    const localClient = client;
    const localCapture = capture;
    client = null;
    capture = null;
    let webSocketState = 'none';
    if (localClient !== null) {
      await localClient.disconnect(SESSION_STOP_TIMEOUT_MS);
      webSocketState = localClient.state;
    }
    let tracksStopped = 0;
    let audioContextState = 'none';
    if (localCapture !== null) {
      const r = await localCapture.release();
      tracksStopped = r.tracksStopped;
      audioContextState = r.audioContextState;
    }
    const released = { tracksStopped, audioContextState, webSocketState };
    log('released', released);
    return { ok: true as const, released };
  })().finally(() => {
    stopping = null;
  });
  return stopping;
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!isTargeted<ToOffscreen>(message, 'offscreen')) return false;
  switch (message.type) {
    case 'offscreen.start':
      void start(message).then(sendResponse);
      return true;
    case 'offscreen.stop':
      void stop().then(sendResponse);
      return true;
    case 'offscreen.ping': {
      const response: OffscreenPingResponse = { ok: true, capturing: capture !== null, sessionId: client?.sessionId ?? null };
      sendResponse(response);
      return false;
    }
    default:
      return false;
  }
});

log('offscreen document loaded');
