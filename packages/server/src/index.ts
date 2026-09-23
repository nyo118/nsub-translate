import type { FastifyInstance } from 'fastify';
import { loadConfig } from './config.js';
import { startServer } from './app.js';

let app: FastifyInstance;
try {
  const config = loadConfig();
  app = await startServer(config);
} catch (err) {
  console.error(`\n[lst-server] failed to start:\n${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down');
  // Close all open websocket clients so their sessions are disposed.
  for (const client of app.websocketServer.clients) client.close(1001, 'server shutting down');
  await app.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
