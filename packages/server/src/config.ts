export interface ServerConfig {
  host: string;
  port: number;
  /** Interval between simulated transcript events (ms). */
  mockTickMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const port = Number.parseInt(env['PORT'] ?? '8787', 10);
  const mockTickMs = Number.parseInt(env['MOCK_TICK_MS'] ?? '1500', 10);
  return {
    // Bind to loopback only: the backend must never be reachable from the LAN.
    host: env['HOST'] ?? '127.0.0.1',
    port: Number.isFinite(port) ? port : 8787,
    mockTickMs: Number.isFinite(mockTickMs) && mockTickMs > 0 ? mockTickMs : 1500,
  };
}
