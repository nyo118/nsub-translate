import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { MAX_AUDIO_FRAME_BYTES, type ServerMessage } from '@lst/protocol';
import { ConnectionHandler } from './protocol-handler.js';
import type { AsrAdapterFactory } from './asr/types.js';
import type { ServerConfig } from './config.js';
import { createMockFactory } from './asr/mock-adapter.js';
import { createSherpaFactory } from './asr/sherpa-adapter.js';

export interface AppOptions {
  asr: AsrAdapterFactory;
  logger?: boolean;
  metricsIntervalMs?: number;
}

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? true });
  await app.register(websocket, {
    options: { maxPayload: MAX_AUDIO_FRAME_BYTES * 2 },
  });

  let openConnections = 0;

  app.get('/healthz', async () => ({ ok: true, openConnections, asrProvider: options.asr.provider }));

  app.get('/ws', { websocket: true }, (socket, req) => {
    openConnections += 1;
    const send = (message: ServerMessage) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
    };
    const handler = new ConnectionHandler({
      send,
      asr: options.asr,
      log: req.log,
      ...(options.metricsIntervalMs === undefined ? {} : { metricsIntervalMs: options.metricsIntervalMs }),
    });
    req.log.info({ openConnections }, 'websocket connected');

    socket.on('message', (data: unknown, isBinary: boolean) => {
      const buf = Array.isArray(data) ? Buffer.concat(data as Buffer[]) : data;
      if (isBinary) handler.handleAudio(buf);
      else handler.handleFrame(buf);
    });
    socket.on('close', () => {
      openConnections -= 1;
      void handler.dispose('socket closed');
      req.log.info({ openConnections }, 'websocket closed');
    });
    socket.on('error', (err: Error) => {
      req.log.warn({ err: err.message }, 'websocket error');
    });
  });

  return app;
}

export function createAsrFactory(config: ServerConfig, log: AppOptions['asr'] extends never ? never : { info: (o: Record<string, unknown>, m: string) => void; warn: (o: Record<string, unknown>, m: string) => void }): AsrAdapterFactory {
  return config.asrProvider === 'mock'
    ? createMockFactory(config.mockTickMs)
    : createSherpaFactory({ modelsDir: config.modelsDir, numThreads: config.asrThreads, log });
}

export async function startServer(config: ServerConfig): Promise<FastifyInstance> {
  const bootLog = { info: (o: Record<string, unknown>, m: string) => console.info(m, o), warn: (o: Record<string, unknown>, m: string) => console.warn(m, o) };
  const asr = createAsrFactory(config, bootLog);
  await asr.prepare();
  const app = await buildApp({ asr, metricsIntervalMs: config.metricsIntervalMs });
  await app.listen({ host: config.host, port: config.port });
  app.log.info({ asrProvider: asr.provider }, `WebSocket endpoint: ws://${config.host}:${config.port}/ws`);
  return app;
}
