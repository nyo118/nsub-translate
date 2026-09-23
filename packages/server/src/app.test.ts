import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { FastifyInstance } from 'fastify';
import { AUDIO_FORMAT, validateServerMessage, type ServerMessage } from '@lst/protocol';
import { buildApp } from './app.js';
import { createMockFactory } from './asr/mock-adapter.js';
import { createMockTranslationFactory } from './translation/mock-adapter.js';

const START = JSON.stringify({ type: 'session.start', protocolVersion: 3, sourceLanguage: 'en', targetLanguage: 'zh-CN', audio: AUDIO_FORMAT });

/**
 * Integration test: a real Fastify server on an ephemeral loopback port and
 * a real `ws` client speaking protocol v1.
 */

let app: FastifyInstance;
let url: string;

function connect(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function collect(ws: WebSocket): { messages: ServerMessage[]; next: (type: ServerMessage['type']) => Promise<ServerMessage> } {
  const messages: ServerMessage[] = [];
  const waiters: Array<{ type: string; resolve: (m: ServerMessage) => void }> = [];
  ws.on('message', (data) => {
    const parsed = validateServerMessage(JSON.parse(data.toString()));
    if (!parsed.ok) throw new Error(`server sent invalid message: ${parsed.error}`);
    messages.push(parsed.message);
    const idx = waiters.findIndex((w) => w.type === parsed.message.type);
    if (idx >= 0) waiters.splice(idx, 1)[0]!.resolve(parsed.message);
  });
  return {
    messages,
    next: (type) =>
      new Promise((resolve, reject) => {
        const existing = messages.find((m) => m.type === type);
        if (existing) return resolve(existing);
        waiters.push({ type, resolve });
        setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), 5000);
      }),
  };
}

function closed(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => ws.once('close', () => resolve()));
}

beforeEach(async () => {
  app = await buildApp({ asr: createMockFactory(20), translation: createMockTranslationFactory(5), logger: false, metricsIntervalMs: 0 });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('no address');
  url = `ws://127.0.0.1:${address.port}/ws`;
});

afterEach(async () => {
  await app.close();
});

describe('backend websocket', () => {
  it('exposes a health endpoint', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, openConnections: 0, asrProvider: 'mock', translationProvider: 'mock' });
  });

  it('runs a full session lifecycle: start → ready → transcripts → stop → stopped', async () => {
    const ws = await connect();
    const { messages, next } = collect(ws);
    ws.send(START);
    const ready = await next('session.ready');
    if (ready.type !== 'session.ready') throw new Error('unreachable');
    expect(ready.asr).toEqual({ provider: 'mock', language: 'en' });
    expect(ready.translation).toEqual({ provider: 'mock', targetLanguage: 'zh-CN' });
    // Binary audio frames are accepted while running (the mock ignores their content).
    ws.send(new Uint8Array(3200), { binary: true });
    const first = await next('transcript');
    expect(first).toMatchObject({ type: 'transcript', sessionId: ready.sessionId, segmentId: 'seg-001', revision: 0, status: 'partial' });

    ws.send(JSON.stringify({ type: 'session.stop', sessionId: ready.sessionId }));
    await next('session.stopped');
    const countAtStop = messages.length;
    await new Promise((r) => setTimeout(r, 120));
    // Nothing else after stopped (the mock timer is cleared).
    expect(messages.slice(countAtStop).filter((m) => m.type === 'transcript')).toHaveLength(0);

    ws.close();
    await closed(ws);
  });

  it('responds with session.error to invalid frames and keeps the connection open', async () => {
    const ws = await connect();
    const { next, messages } = collect(ws);
    ws.send('this is not json');
    const err = await next('session.error');
    expect(err).toMatchObject({ type: 'session.error', code: 'invalid_message' });
    ws.send(new Uint8Array(3), { binary: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(messages.at(-1)).toMatchObject({ type: 'session.error', code: 'invalid_audio' });
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
    await closed(ws);
  });

  it('closing the socket stops the session and decrements the connection count', async () => {
    const ws = await connect();
    const { next } = collect(ws);
    ws.send(START);
    await next('session.ready');
    expect((await app.inject({ method: 'GET', url: '/healthz' })).json().openConnections).toBe(1);
    ws.close();
    await closed(ws);
    await new Promise((r) => setTimeout(r, 50));
    expect((await app.inject({ method: 'GET', url: '/healthz' })).json().openConnections).toBe(0);
  });

  it('supports independent sessions on separate connections', async () => {
    const a = await connect();
    const b = await connect();
    const ca = collect(a);
    const cb = collect(b);
    a.send(START);
    b.send(START);
    const ra = await ca.next('session.ready');
    const rb = await cb.next('session.ready');
    expect(ra.type === 'session.ready' && rb.type === 'session.ready' && ra.sessionId !== rb.sessionId).toBe(true);
    a.close();
    b.close();
    await Promise.all([closed(a), closed(b)]);
  });
});
