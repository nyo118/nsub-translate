import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type AsrProviderName = 'sensevoice' | 'mock';

export interface ServerConfig {
  host: string;
  port: number;
  /** Interval between simulated transcript events for the mock provider (ms). */
  mockTickMs: number;
  asrProvider: AsrProviderName;
  /** Directory containing the SenseVoice model folder and silero_vad.onnx. */
  modelsDir: string;
  /** onnxruntime intra-op threads for the recognizer. */
  asrThreads: number;
  /** Interval for session.metrics messages (ms). */
  metricsIntervalMs: number;
}

/** packages/server/models by default (works from src via tsx and from dist). */
export function defaultModelsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', 'models');
}

function int(value: string | undefined, fallback: number, min = 1): number {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const provider = env['ASR_PROVIDER'] ?? 'sensevoice';
  if (provider !== 'sensevoice' && provider !== 'mock') {
    throw new Error(`ASR_PROVIDER must be "sensevoice" or "mock" (got "${provider}")`);
  }
  return {
    // Bind to loopback only: the backend must never be reachable from the LAN.
    host: env['HOST'] ?? '127.0.0.1',
    port: int(env['PORT'], 8787, 0),
    mockTickMs: int(env['MOCK_TICK_MS'], 1500),
    asrProvider: provider,
    modelsDir: env['MODELS_DIR'] ? path.resolve(env['MODELS_DIR']) : defaultModelsDir(),
    asrThreads: int(env['ASR_THREADS'], 2),
    metricsIntervalMs: int(env['METRICS_INTERVAL_MS'], 5000, 0),
  };
}
