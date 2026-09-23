import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { AUDIO_FORMAT, type ServerMessage } from '@lst/protocol';
import { BackendClient, type ReconnectPolicy, type SocketLike } from './backend-client.js';

const READY = { type: 'session.ready', sessionId: 'sid', asr: { provider: 'mock', language: 'en' }, translation: { provider: 'mock', targetLanguage: 'zh-CN' } };

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: string[] = [];
  binary: ArrayBuffer[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  closeCalls: Array<{ code?: number; reason?: string }> = [];
  send(data: string | ArrayBuffer) {
    if (typeof data === 'string') this.sent.push(data);
    else this.binary.push(data);
  }
  close(code?: number, reason?: string) {
    this.closeCalls.push(code === undefined ? {} : reason === undefined ? { code } : { code, reason });
    this.readyState = 3;
    this.onclose?.({ code: code ?? 1005, reason: reason ?? '' });
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(message: object) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

function setup(reconnect: ReconnectPolicy | null = null) {
  const sockets: FakeSocket[] = [];
  const received: ServerMessage[] = [];
  const closes: string[] = [];
  const reconnects: string[] = [];
  const client = new BackendClient(
    {
      onMessage: (m) => received.push(m),
      onClose: (r) => closes.push(r),
      onReconnecting: (n) => reconnects.push(`attempt ${n}`),
      onReconnected: (sid) => reconnects.push(`ok ${sid}`),
    },
    () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    reconnect,
  );
  return { client, sockets, received, closes, reconnects };
}

const langs = { sourceLanguage: 'en', targetLanguage: 'zh-CN' };

describe('BackendClient', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sends session.start on open and resolves with the sessionId on session.ready', async () => {
    const { client, sockets } = setup();
    const p = client.connect('ws://x', langs, 1000);
    const s = sockets[0]!;
    s.open();
    expect(JSON.parse(s.sent[0]!)).toEqual({ type: 'session.start', protocolVersion: 3, ...langs, audio: AUDIO_FORMAT });
    s.receive(READY);
    await expect(p).resolves.toBe('sid');
    expect(client.sessionId).toBe('sid');
    expect(client.asr).toEqual({ provider: 'mock', language: 'en' });
    expect(client.translation).toEqual({ provider: 'mock', targetLanguage: 'zh-CN' });
  });

  it('forwards session options in session.start', async () => {
    const { client, sockets } = setup();
    void client.connect('ws://x', { ...langs, options: { translatePartials: true } }, 1000).catch(() => undefined);
    sockets[0]!.open();
    expect(JSON.parse(sockets[0]!.sent[0]!).options).toEqual({ translatePartials: true });
  });

  it('rejects when the backend cannot be reached (socket closes before ready)', async () => {
    const { client, sockets, closes } = setup();
    const p = client.connect('ws://x', langs, 1000);
    sockets[0]!.close(1006);
    await expect(p).rejects.toThrow(/Could not connect/);
    expect(closes).toEqual([]);
    expect(client.state).toBe('none');
  });

  it('rejects and closes the socket when session.ready does not arrive in time', async () => {
    const { client, sockets } = setup();
    const p = client.connect('ws://x', langs, 500);
    sockets[0]!.open();
    vi.advanceTimersByTime(500);
    await expect(p).rejects.toThrow(/did not answer/);
    expect(sockets[0]!.closeCalls).toHaveLength(1);
  });

  it('rejects when the backend answers session.start with an error', async () => {
    const { client, sockets } = setup();
    const p = client.connect('ws://x', langs, 1000);
    sockets[0]!.open();
    sockets[0]!.receive({ type: 'session.error', code: 'invalid_message', message: 'nope' });
    await expect(p).rejects.toThrow(/invalid_message/);
  });

  it('forwards transcripts after ready and reports unexpected closes', async () => {
    const { client, sockets, received, closes } = setup();
    const p = client.connect('ws://x', langs, 1000);
    const s = sockets[0]!;
    s.open();
    s.receive(READY);
    await p;
    s.receive({ type: 'transcript', sessionId: 'sid', segmentId: 'a', revision: 0, status: 'partial', startMs: 0, sourceText: 'x' });
    s.receive({ garbage: true });
    expect(received).toHaveLength(1);
    s.readyState = 3;
    s.onclose?.({ code: 1006, reason: '' });
    expect(closes).toEqual(['code 1006']);
  });

  it('disconnect sends session.stop, waits for session.stopped, closes, and does not report onClose', async () => {
    const { client, sockets, closes } = setup();
    const p = client.connect('ws://x', langs, 1000);
    const s = sockets[0]!;
    s.open();
    s.receive(READY);
    await p;
    const d = client.disconnect(800);
    expect(JSON.parse(s.sent[1]!)).toEqual({ type: 'session.stop', sessionId: 'sid' });
    s.receive({ type: 'session.stopped', sessionId: 'sid' });
    await d;
    expect(s.closeCalls).toEqual([{ code: 1000, reason: 'client stop' }]);
    expect(closes).toEqual([]);
    expect(client.state).toBe('none');
  });

  it('disconnect gives up waiting after the timeout', async () => {
    const { client, sockets } = setup();
    const p = client.connect('ws://x', langs, 1000);
    const s = sockets[0]!;
    s.open();
    s.receive(READY);
    await p;
    const d = client.disconnect(300);
    vi.advanceTimersByTime(300);
    await d;
    expect(s.closeCalls).toHaveLength(1);
  });

  it('refuses a second connect while connected', async () => {
    const { client, sockets } = setup();
    const p = client.connect('ws://x', langs, 1000);
    sockets[0]!.open();
    sockets[0]!.receive(READY);
    await p;
    await expect(client.connect('ws://x', langs, 1000)).rejects.toThrow(/already connected/);
    expect(sockets).toHaveLength(1);
  });

  it('sends binary audio only while a session is ready and counts drops', async () => {
    const { client, sockets } = setup();
    expect(client.sendAudio(new ArrayBuffer(4))).toBe(false);
    const p = client.connect('ws://x', langs, 1000);
    const s = sockets[0]!;
    s.open();
    expect(client.sendAudio(new ArrayBuffer(4))).toBe(false); // open but not ready yet
    s.receive(READY);
    await p;
    expect(client.sendAudio(new ArrayBuffer(4))).toBe(true);
    expect(s.binary).toHaveLength(1);
    expect(client.stats).toEqual({ audioFramesSent: 1, audioFramesDropped: 2 });
  });

  it('reconnects with backoff after an unexpected close and reports the new session', async () => {
    const { client, sockets, closes, reconnects } = setup({ maxAttempts: 3, delaysMs: [100, 200] });
    const p = client.connect('ws://x', langs, 1000);
    sockets[0]!.open();
    sockets[0]!.receive(READY);
    await p;
    // Backend dies.
    sockets[0]!.readyState = 3;
    sockets[0]!.onclose?.({ code: 1006, reason: '' });
    expect(client.isReconnecting).toBe(true);
    expect(sockets).toHaveLength(2); // attempt 1 is immediate
    sockets[1]!.close(1006); // attempt 1 fails
    await vi.advanceTimersByTimeAsync(100);
    expect(sockets).toHaveLength(3); // attempt 2 after 100 ms
    sockets[2]!.open();
    sockets[2]!.receive({ ...READY, sessionId: 'sid-2' });
    await vi.advanceTimersByTimeAsync(0);
    expect(client.isReconnecting).toBe(false);
    expect(client.sessionId).toBe('sid-2');
    expect(reconnects).toEqual(['attempt 1', 'attempt 2', 'ok sid-2']);
    expect(closes).toEqual([]);
  });

  it('gives up after maxAttempts and then reports onClose once', async () => {
    const { client, sockets, closes } = setup({ maxAttempts: 2, delaysMs: [50] });
    const p = client.connect('ws://x', langs, 1000);
    sockets[0]!.open();
    sockets[0]!.receive(READY);
    await p;
    sockets[0]!.readyState = 3;
    sockets[0]!.onclose?.({ code: 1006, reason: 'gone' });
    sockets[1]!.close(1006);
    await vi.advanceTimersByTimeAsync(50);
    sockets[2]!.close(1006);
    await vi.advanceTimersByTimeAsync(50);
    expect(closes).toEqual(['gone; reconnect failed after 2 attempts']);
    expect(client.isReconnecting).toBe(false);
    expect(sockets).toHaveLength(3);
  });

  it('disconnect() during a reconnect wait cancels it silently', async () => {
    const { client, sockets, closes } = setup({ maxAttempts: 5, delaysMs: [1000] });
    const p = client.connect('ws://x', langs, 1000);
    sockets[0]!.open();
    sockets[0]!.receive(READY);
    await p;
    sockets[0]!.readyState = 3;
    sockets[0]!.onclose?.({ code: 1006, reason: '' });
    sockets[1]!.close(1006);
    await client.disconnect(100);
    await vi.advanceTimersByTimeAsync(5000);
    expect(sockets).toHaveLength(2);
    expect(closes).toEqual([]);
    expect(client.isReconnecting).toBe(false);
  });
});
