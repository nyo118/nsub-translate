import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import type { ServerMessage } from '@lst/protocol';
import { BackendClient, type SocketLike } from './backend-client.js';

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: string[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  closeCalls: Array<{ code?: number; reason?: string }> = [];
  send(data: string) {
    this.sent.push(data);
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

function setup() {
  const sockets: FakeSocket[] = [];
  const received: ServerMessage[] = [];
  const closes: string[] = [];
  const client = new BackendClient(
    { onMessage: (m) => received.push(m), onClose: (r) => closes.push(r) },
    () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
  );
  return { client, sockets, received, closes };
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
    expect(JSON.parse(s.sent[0]!)).toEqual({ type: 'session.start', protocolVersion: 1, ...langs });
    s.receive({ type: 'session.ready', sessionId: 'sid' });
    await expect(p).resolves.toBe('sid');
    expect(client.sessionId).toBe('sid');
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
    s.receive({ type: 'session.ready', sessionId: 'sid' });
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
    s.receive({ type: 'session.ready', sessionId: 'sid' });
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
    s.receive({ type: 'session.ready', sessionId: 'sid' });
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
    sockets[0]!.receive({ type: 'session.ready', sessionId: 'sid' });
    await p;
    await expect(client.connect('ws://x', langs, 1000)).rejects.toThrow(/already connected/);
    expect(sockets).toHaveLength(1);
  });
});
