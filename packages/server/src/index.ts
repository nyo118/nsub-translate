import { loadConfig } from './config.js';
import { startServer } from './app.js';

const config = loadConfig();
const app = await startServer(config);

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
