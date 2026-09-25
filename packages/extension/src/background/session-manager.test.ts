import { describe, expect, it, vi } from 'vitest';
import type { TranscriptMessage } from '@lst/protocol';
import { SessionManager, type PersistedSession, type SessionPorts } from './session-manager.js';

interface FakeWorld {
  ports: SessionPorts;
  stored: { value: PersistedSession | undefined };
  offscreenOpen: { value: boolean };
  contentMessages: Array<{ tabId: number; type: string }>;
  calls: string[];
}

function makeWorld(overrides: Partial<SessionPorts> = {}): FakeWorld {
  const stored = { value: undefined as PersistedSession | undefined };
  const offscreenOpen = { value: false };
  const contentMessages: Array<{ tabId: number; type: string }> = [];
  const calls: string[] = [];
  const ports: SessionPorts = {
    loadState: async () => stored.value,
    loadLanguages: async () => ({ sourceLanguage: 'ja', targetLanguage: 'zh-TW', translatePartials: false, translationProvider: 'hy-mt2', sessionLimitMs: 3 * 3_600_000, backendUrl: 'ws://192.168.50.2:8787/ws' }),
    saveState: async (s) => {
      stored.value = s;
    },
    clearState: async () => {
      stored.value = undefined;
    },
    getActiveTab: async () => ({ tabId: 7, url: 'https://www.youtube.com/watch?v=x' }),
    detectPlayer: async () => ({ platform: 'youtube', playerFound: true }),
    getStreamId: async () => {
      calls.push('getStreamId');
      return 'stream-1';
    },
    ensureOffscreen: async () => {
      calls.push('ensureOffscreen');
      offscreenOpen.value = true;
    },
    hasOffscreen: async () => offscreenOpen.value,
    closeOffscreen: async () => {
      calls.push('closeOffscreen');
      offscreenOpen.value = false;
    },
    startOffscreen: async () => {
      calls.push('startOffscreen');
      return { ok: true, sessionId: 'sid-1', asr: { provider: 'mock', language: 'auto' }, translation: { provider: 'mock', targetLanguage: 'zh-TW' } };
    },
    stopOffscreen: async () => {
      calls.push('stopOffscreen');
      return { tracksStopped: 1, audioContextState: 'closed', webSocketState: 'closed' };
    },
    notifyContent: async (tabId, message) => {
      contentMessages.push({ tabId, type: message.type });
    },
    log: () => {},
    ...overrides,
  };
  return { ports, stored, offscreenOpen, contentMessages, calls };
}

function manager(world: FakeWorld) {
  return new SessionManager({ ports: world.ports, backendUrl: 'ws://127.0.0.1:8787/ws' });
}

const transcript: TranscriptMessage = {
  type: 'transcript',
  sessionId: 'sid-1',
  segmentId: 'seg',
  revision: 0,
  status: 'partial',
  startMs: 0,
  sourceText: 'hi',
};

describe('SessionManager', () => {
  it('starts a session, persists it and notifies the content script', async () => {
    const world = makeWorld();
    const m = manager(world);
    expect(await m.start()).toEqual({ ok: true, sessionId: 'sid-1' });
    expect(world.calls).toEqual(['getStreamId', 'ensureOffscreen', 'startOffscreen']);
    expect(world.stored.value).toMatchObject({ status: 'active', sessionId: 'sid-1', tabId: 7, platform: 'youtube' });
    expect(world.contentMessages).toEqual([{ tabId: 7, type: 'content.sessionStarted' }]);
    expect((await m.snapshot()).status).toBe('active');
  });

  it('reads languages from settings at start and exposes them in the snapshot', async () => {
    const world = makeWorld();
    const startOffscreen = vi.fn(world.ports.startOffscreen);
    world.ports.startOffscreen = startOffscreen;
    const m = manager(world);
    await m.start();
    expect(startOffscreen).toHaveBeenCalledWith(expect.objectContaining({ sourceLanguage: 'ja', targetLanguage: 'zh-TW', backendUrl: 'ws://192.168.50.2:8787/ws' }));
    const snap = await m.snapshot();
    expect(snap.sourceLanguage).toBe('ja');
    expect(snap.targetLanguage).toBe('zh-TW');
    // Settings changed after start must not affect the running session's snapshot.
    world.ports.loadLanguages = async () => ({ sourceLanguage: 'en', targetLanguage: 'ko', translatePartials: true, translationProvider: 'google', sessionLimitMs: 0, backendUrl: 'ws://127.0.0.1:8787/ws' });
    expect((await m.snapshot()).targetLanguage).toBe('zh-TW');
  });

  it('uses a stream id obtained by the popup and skips the worker fallback', async () => {
    const world = makeWorld();
    const startOffscreen = vi.fn(world.ports.startOffscreen);
    world.ports.startOffscreen = startOffscreen;
    const m = manager(world);
    expect(await m.start({ tabId: 7, streamId: 'popup-stream' })).toEqual({ ok: true, sessionId: 'sid-1' });
    expect(world.calls).not.toContain('getStreamId');
    expect(startOffscreen).toHaveBeenCalledWith(expect.objectContaining({ streamId: 'popup-stream' }));
    expect(world.stored.value).toMatchObject({ tabId: 7 });
  });

  it('rejects a second start while a session is active (no duplicate sessions)', async () => {
    const world = makeWorld();
    const m = manager(world);
    await m.start();
    const second = await m.start();
    expect(second.ok).toBe(false);
    expect(world.calls.filter((c) => c === 'startOffscreen')).toHaveLength(1);
  });

  it('serialises concurrent start() calls so only one wins', async () => {
    const world = makeWorld();
    const m = manager(world);
    const [a, b] = await Promise.all([m.start(), m.start()]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect(world.calls.filter((c) => c === 'startOffscreen')).toHaveLength(1);
  });

  it('stop releases offscreen resources, clears state and notifies the tab', async () => {
    const world = makeWorld();
    const m = manager(world);
    await m.start();
    const result = await m.stop();
    expect(result).toEqual({ ok: true, released: { tracksStopped: 1, audioContextState: 'closed', webSocketState: 'closed' } });
    expect(world.calls.slice(3)).toEqual(['stopOffscreen', 'closeOffscreen']);
    expect(world.offscreenOpen.value).toBe(false);
    expect(world.stored.value).toBeUndefined();
    expect(world.contentMessages.map((c) => c.type)).toEqual(['content.sessionStarted', 'content.sessionStopped']);
  });

  it('start → stop → start → stop leaves exactly one offscreen lifecycle per session', async () => {
    const world = makeWorld();
    const m = manager(world);
    await m.start();
    await m.stop();
    await m.start();
    await m.stop();
    expect(world.calls).toEqual([
      'getStreamId', 'ensureOffscreen', 'startOffscreen', 'stopOffscreen', 'closeOffscreen',
      'getStreamId', 'ensureOffscreen', 'startOffscreen', 'stopOffscreen', 'closeOffscreen',
    ]);
    expect(world.offscreenOpen.value).toBe(false);
  });

  it('cleans up when the offscreen document fails to start', async () => {
    const world = makeWorld({ startOffscreen: async () => ({ ok: false, error: 'backend unreachable' }) });
    const m = manager(world);
    const result = await m.start();
    expect(result).toEqual({ ok: false, error: 'backend unreachable' });
    expect(world.offscreenOpen.value).toBe(false);
    expect(world.stored.value).toBeUndefined();
    const snap = await m.snapshot();
    expect(snap.status).toBe('idle');
    expect(snap.lastError).toBe('backend unreachable');
  });

  it('refuses to start on unsupported pages or pages without a player', async () => {
    const noPlatform = makeWorld({ detectPlayer: async () => ({ platform: null, playerFound: false }) });
    expect((await manager(noPlatform).start()).ok).toBe(false);
    expect(noPlatform.calls).toEqual([]);
    const noPlayer = makeWorld({ detectPlayer: async () => ({ platform: 'youtube', playerFound: false }) });
    const r = await manager(noPlayer).start();
    expect(r.ok === false && r.error).toMatch(/player/);
  });

  it('closes a stale offscreen document found before starting', async () => {
    const world = makeWorld();
    world.offscreenOpen.value = true;
    const m = manager(world);
    await m.start();
    expect(world.calls[0]).toBe('closeOffscreen');
  });

  it('routes transcripts for the active session only', async () => {
    const world = makeWorld();
    const m = manager(world);
    await m.onTranscript(transcript);
    expect(world.contentMessages).toEqual([]);
    await m.start();
    await m.onTranscript(transcript);
    await m.onTranscript({ ...transcript, sessionId: 'other' });
    expect(world.contentMessages.filter((c) => c.type === 'content.transcript')).toHaveLength(1);
    expect((await m.snapshot()).transcriptCount).toBe(1);
  });

  it('collects distinct detected languages from recent finals', async () => {
    const world = makeWorld();
    const m = manager(world);
    await m.start();
    await m.onTranscript({ ...transcript, status: 'final', endMs: 1, language: 'en' });
    await m.onTranscript({ ...transcript, segmentId: 'b', status: 'final', endMs: 1, language: 'ja' });
    await m.onTranscript({ ...transcript, segmentId: 'c', status: 'final', endMs: 1, language: 'en' });
    await m.onTranscript({ ...transcript, segmentId: 'd', language: 'ko' }); // partial: ignored
    expect((await m.snapshot()).detectedLanguages).toEqual(['en', 'ja']);
  });

  it('stops when the session tab is closed, ignores other tabs', async () => {
    const world = makeWorld();
    const m = manager(world);
    await m.start();
    await m.onTabRemoved(99);
    expect((await m.snapshot()).status).toBe('active');
    await m.onTabRemoved(7);
    expect((await m.snapshot()).status).toBe('idle');
    expect(world.offscreenOpen.value).toBe(false);
  });

  it('stops and records an error when the offscreen document loses the backend', async () => {
    const world = makeWorld();
    const m = manager(world);
    await m.start();
    await m.onOffscreenDisconnected('socket closed');
    const snap = await m.snapshot();
    expect(snap.status).toBe('idle');
    expect(snap.lastError).toMatch(/Backend connection lost/);
    expect(world.offscreenOpen.value).toBe(false);
  });

  it('recovers persisted state after a worker restart', async () => {
    const world = makeWorld();
    await manager(world).start();
    // A brand-new manager (simulating a restarted service worker) sees the same session.
    const restarted = manager(world);
    expect(await restarted.sessionForTab(7)).toEqual({ active: true, sessionId: 'sid-1' });
    expect(await restarted.sessionForTab(8)).toEqual({ active: false });
    await restarted.stop();
    expect(world.offscreenOpen.value).toBe(false);
  });

  it('exposes asr info, metrics and connection state while active; reconnect swaps the session id', async () => {
    const world = makeWorld();
    const m = manager(world);
    await m.start();
    let snap = await m.snapshot();
    expect(snap.asr).toEqual({ provider: 'mock', language: 'auto' });
    expect(snap.translation).toEqual({ provider: 'mock', targetLanguage: 'zh-TW' });
    expect(snap.connection).toBe('connected');
    m.onMetrics({ type: 'session.metrics', sessionId: 'sid-1', audioSeconds: 3, partials: 2, finals: 1, avgDecodeMs: 300, avgLatencyMs: 800, translated: 1, avgTranslateMs: 1200, translationBacklog: 0, asrLatencyP95Ms: 1500, translateP95Ms: 2000, translationCoverage: 1 });
    m.onReconnecting();
    snap = await m.snapshot();
    expect(snap.metrics?.avgLatencyMs).toBe(800);
    expect(snap.connection).toBe('reconnecting');
    await m.onReconnected('sid-2', { provider: 'sensevoice', language: 'ja' }, { provider: 'hy-mt2', targetLanguage: 'zh-TW' });
    snap = await m.snapshot();
    expect(snap.sessionId).toBe('sid-2');
    expect(snap.asr?.language).toBe('ja');
    expect(snap.translation?.provider).toBe('hy-mt2');
    expect(snap.connection).toBe('connected');
    expect(snap.metrics).toBeUndefined();
    expect(world.contentMessages.filter((c) => c.type === 'content.sessionStarted')).toHaveLength(2);
    // Transcripts for the new session id are routed; the old id is dropped.
    await m.onTranscript({ ...transcript, sessionId: 'sid-2' });
    await m.onTranscript({ ...transcript, sessionId: 'sid-1' });
    expect((await m.snapshot()).transcriptCount).toBe(1);
  });

  it('stores the audio-clock origin, forwards it to the tab, and hands it to re-attaching content scripts', async () => {
    const world = makeWorld();
    const m = manager(world);
    await m.start();
    await m.onAudioOrigin('other-session', 123); // ignored
    expect((await m.sessionForTab(7)).audioOriginWall).toBeUndefined();
    await m.onAudioOrigin('sid-1', 1_700_000_000_000);
    expect(world.contentMessages.at(-1)).toEqual({ tabId: 7, type: 'content.audioOrigin' });
    expect(await manager(world).sessionForTab(7)).toEqual({ active: true, sessionId: 'sid-1', audioOriginWall: 1_700_000_000_000 });
    // A reconnect starts a new audio clock: the stale origin is dropped until reported again.
    await m.onReconnected('sid-2', { provider: 'sensevoice', language: 'auto' });
    expect((await m.sessionForTab(7)).audioOriginWall).toBeUndefined();
  });

  it('passes the session limit to the offscreen document and stops with a clear message when it fires', async () => {
    const world = makeWorld();
    const startOffscreen = vi.fn(world.ports.startOffscreen);
    world.ports.startOffscreen = startOffscreen;
    const m = manager(world);
    await m.start();
    expect(startOffscreen).toHaveBeenCalledWith(expect.objectContaining({ sessionLimitMs: 3 * 3_600_000 }));
    expect((await m.snapshot()).sessionLimitMs).toBe(3 * 3_600_000);
    await m.onLimitReached(3 * 3_600_000);
    const snap = await m.snapshot();
    expect(snap.status).toBe('idle');
    expect(snap.lastError).toMatch(/3 小时/);
    expect(world.offscreenOpen.value).toBe(false);
  });

  it('counts reconnects for diagnostics', async () => {
    const world = makeWorld();
    const m = manager(world);
    await m.start();
    expect((await m.snapshot()).reconnects).toBe(0);
    await m.onReconnected('sid-2', { provider: 'sensevoice', language: 'auto' });
    await m.onReconnected('sid-3', { provider: 'sensevoice', language: 'auto' });
    expect((await m.snapshot()).reconnects).toBe(2);
  });

  it('stop on an idle manager still closes a leftover offscreen document', async () => {
    const world = makeWorld();
    world.offscreenOpen.value = true;
    const stopOffscreen = vi.fn(world.ports.stopOffscreen);
    world.ports.stopOffscreen = stopOffscreen;
    await manager(world).stop();
    expect(stopOffscreen).toHaveBeenCalledTimes(1);
    expect(world.offscreenOpen.value).toBe(false);
  });
});
