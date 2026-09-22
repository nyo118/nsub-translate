import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import type { ServerMessage } from '@lst/protocol';
import { ConnectionHandler } from './protocol-handler.js';
import type { ServerConfig } from './config.js';

export interface AppOptions {
  tickMs: number;
  logger?: boolean;
}

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? true });
  await app.register(websocket, {
    options: { maxPayload: 64 * 1024 },
  });

  let openConnections = 0;

  app.get('/healthz', async () => ({ ok: true, openConnections }));

  app.get('/ws', { websocket: true }, (socket, req) => {
    openConnections += 1;
    const send = (message: ServerMessage) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
    };
    const handler = new ConnectionHandler({ send, tickMs: options.tickMs, log: req.log });
    req.log.info({ openConnections }, 'websocket connected');

    socket.on('message', (data: unknown) => {
      // ws delivers Buffer (a Uint8Array subclass) for text frames; the protocol parser handles both.
      handler.handleFrame(Array.isArray(data) ? Buffer.concat(data as Buffer[]) : data);
    });
    socket.on('close', () => {
      openConnections -= 1;
      handler.dispose('socket closed');
      req.log.info({ openConnections }, 'websocket closed');
    });
    socket.on('error', (err: Error) => {
      req.log.warn({ err: err.message }, 'websocket error');
    });
  });

  return app;
}

export async function startServer(config: ServerConfig): Promise<FastifyInstance> {
  const app = await buildApp({ tickMs: config.mockTickMs });
  await app.listen({ host: config.host, port: config.port });
  app.log.info(`WebSocket endpoint: ws://${config.host}:${config.port}/ws`);
  return app;
}
