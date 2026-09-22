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
      return { ok: true, sessionId: 'sid-1' };
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
  return new SessionManager({ ports: world.ports, backendUrl: 'ws://127.0.0.1:8787/ws', sourceLanguage: 'en', targetLanguage: 'zh-CN' });
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
