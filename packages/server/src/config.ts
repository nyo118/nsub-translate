import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type AsrProviderName = 'sensevoice' | 'mock';
export type TranslationProviderName = 'hy-mt2' | 'gemini' | 'llm' | 'google' | 'mock' | 'none';
export const TRANSLATION_PROVIDERS: readonly TranslationProviderName[] = ['hy-mt2', 'gemini', 'llm', 'google', 'mock', 'none'];

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
  translationProvider: TranslationProviderName;
  /** llama.cpp threads for the local translation model. */
  translationThreads: number;
  /** Google Cloud Translation API key (backend-only secret). */
  googleTranslateApiKey: string;
  /** Gemini (AI Studio) API key and model. */
  geminiApiKey: string;
  geminiModel: string;
  /** Generic OpenAI-compatible endpoint (Groq, OpenRouter, Ollama, …). */
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;
  /** Requests per minute for cloud engines (Gemini free tier is ~15). 0 = unlimited. */
  geminiRpm: number;
  llmRpm: number;
  /** Log subtitle text at debug level (off by default for privacy). */
  logTranscripts: boolean;
  /** Close a WebSocket that sent nothing (audio or ping) for this long. */
  idleTimeoutMs: number;
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
  const translation = (env['TRANSLATION_PROVIDER'] ?? 'hy-mt2') as TranslationProviderName;
  if (!TRANSLATION_PROVIDERS.includes(translation)) {
    throw new Error(`TRANSLATION_PROVIDER must be one of ${TRANSLATION_PROVIDERS.join(', ')} (got "${translation}")`);
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
    translationProvider: translation,
    translationThreads: int(env['TRANSLATION_THREADS'], 3),
    googleTranslateApiKey: env['GOOGLE_TRANSLATE_API_KEY'] ?? '',
    geminiApiKey: env['GEMINI_API_KEY'] ?? '',
    geminiModel: env['GEMINI_MODEL'] ?? 'gemini-3.5-flash-lite',
    llmBaseUrl: env['LLM_BASE_URL'] ?? '',
    llmApiKey: env['LLM_API_KEY'] ?? '',
    llmModel: env['LLM_MODEL'] ?? '',
    geminiRpm: int(env['GEMINI_RPM'], 12, 0),
    llmRpm: int(env['LLM_RPM'], 0, 0),
    logTranscripts: env['LOG_TRANSCRIPTS'] === '1' || env['LOG_TRANSCRIPTS'] === 'true',
    idleTimeoutMs: int(env['IDLE_TIMEOUT_MS'], 30_000, 0),
  };
}
