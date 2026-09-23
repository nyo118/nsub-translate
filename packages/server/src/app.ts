import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { MAX_AUDIO_FRAME_BYTES, type ServerMessage } from '@lst/protocol';
import { ConnectionHandler } from './protocol-handler.js';
import type { AsrAdapterFactory } from './asr/types.js';
import type { ServerConfig } from './config.js';
import { createMockFactory } from './asr/mock-adapter.js';
import { createSherpaFactory } from './asr/sherpa-adapter.js';
import type { TranslationAdapterFactory } from './translation/types.js';
import { createMockTranslationFactory, createNoneTranslationFactory } from './translation/mock-adapter.js';
import { createGoogleTranslationFactory } from './translation/google-adapter.js';
import { createHyMt2Factory } from './translation/hymt2-adapter.js';

export interface AppOptions {
  asr: AsrAdapterFactory;
  translation: TranslationAdapterFactory;
  logger?: boolean;
  metricsIntervalMs?: number;
}

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? true });
  await app.register(websocket, {
    options: { maxPayload: MAX_AUDIO_FRAME_BYTES * 2 },
  });

  let openConnections = 0;

  app.get('/healthz', async () => ({ ok: true, openConnections, asrProvider: options.asr.provider, translationProvider: options.translation.provider }));

  app.get('/ws', { websocket: true }, (socket, req) => {
    openConnections += 1;
    const send = (message: ServerMessage) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
    };
    const handler = new ConnectionHandler({
      send,
      asr: options.asr,
      translation: options.translation,
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

type BootLog = { info: (o: Record<string, unknown>, m: string) => void; warn: (o: Record<string, unknown>, m: string) => void };

export function createAsrFactory(config: ServerConfig, log: BootLog): AsrAdapterFactory {
  return config.asrProvider === 'mock'
    ? createMockFactory(config.mockTickMs)
    : createSherpaFactory({ modelsDir: config.modelsDir, numThreads: config.asrThreads, log });
}

export function createTranslationFactory(config: ServerConfig, log: BootLog): TranslationAdapterFactory & { dispose?: () => Promise<void> } {
  switch (config.translationProvider) {
    case 'mock':
      return createMockTranslationFactory();
    case 'none':
      return createNoneTranslationFactory();
    case 'google':
      return createGoogleTranslationFactory({ apiKey: config.googleTranslateApiKey });
    case 'hy-mt2':
      return createHyMt2Factory({ modelsDir: config.modelsDir, threads: config.translationThreads, log });
  }
}

export async function startServer(config: ServerConfig): Promise<FastifyInstance> {
  const bootLog: BootLog = { info: (o, m) => console.info(m, o), warn: (o, m) => console.warn(m, o) };
  const asr = createAsrFactory(config, bootLog);
  const translation = createTranslationFactory(config, bootLog);
  await asr.prepare();
  await translation.prepare();
  const app = await buildApp({ asr, translation, metricsIntervalMs: config.metricsIntervalMs });
  if (translation.dispose) app.addHook('onClose', async () => translation.dispose?.());
  await app.listen({ host: config.host, port: config.port });
  app.log.info({ asrProvider: asr.provider, translationProvider: translation.provider }, `WebSocket endpoint: ws://${config.host}:${config.port}/ws`);
  return app;
}
