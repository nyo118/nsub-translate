import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync } from 'node:fs';
import path from 'node:path';
import websocket from '@fastify/websocket';
import { MAX_AUDIO_FRAME_BYTES, type ServerMessage } from '@lst/protocol';
import { ConnectionHandler } from './protocol-handler.js';
import type { AsrAdapterFactory } from './asr/types.js';
import type { ServerConfig } from './config.js';
import { createMockFactory } from './asr/mock-adapter.js';
import { createSherpaFactory } from './asr/sherpa-adapter.js';
import { createMockTranslationFactory, createNoneTranslationFactory } from './translation/mock-adapter.js';
import { createGoogleTranslationFactory } from './translation/google-adapter.js';
import { HYMT2_MODEL_FILE, createHyMt2Factory } from './translation/hymt2-adapter.js';
import { GEMINI_OPENAI_BASE_URL, createOpenAiCompatibleFactory } from './translation/openai-compatible-adapter.js';
import { TranslationRegistry } from './translation/registry.js';
import { SessionLog } from './metrics/session-log.js';
import { ModelManager } from './models/model-manager.js';
import { loadModelLock } from './models/model-lock.js';

export interface EngineStatus {
  /** Model file / API key present. */
  configured: boolean;
  /** Prepared (loaded / warmed up) in this process. */
  ready: boolean;
  hint?: string;
}

export interface AppOptions {
  asr: AsrAdapterFactory;
  translation: TranslationRegistry;
  logger?: boolean;
  metricsIntervalMs?: number;
  /** Per-engine configuration status for /healthz (diagnostics in the popup). */
  engineStatus?: () => Record<string, EngineStatus>;
  idleTimeoutMs?: number;
  logTranscripts?: boolean;
  /** Directory for logs/sessions.jsonl; null = memory only. */
  logsDir?: string | null;
  /** Model download/readiness state for /healthz and the session gate. */
  models?: ModelManager;
  /** Extra readiness gate (e.g. ASR still loading). */
  notReady?: () => string | null;
}

const startedAt = Date.now();
/** More than 2× real time sustained means a misbehaving client; frames beyond it are dropped. */
const MAX_AUDIO_FRAMES_PER_SEC = 25;

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? true });
  await app.register(websocket, {
    options: { maxPayload: MAX_AUDIO_FRAME_BYTES * 2 },
  });

  let openConnections = 0;
  let activeSessions = 0;
  const sessionLog = new SessionLog(options.logsDir ?? null, 10, app.log);

  app.get('/healthz', async () => ({
    ok: true,
    openConnections,
    activeSessions,
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    asrProvider: options.asr.provider,
    translationProvider: options.translation.defaultProvider,
    translationProviders: options.translation.providers,
    engines: options.engineStatus?.() ?? {},
    models: options.models?.snapshot() ?? null,
    ready: options.notReady ? options.notReady() === null : true,
    recentSessions: sessionLog.recentSessions,
  }));

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
      onSessionCount: (delta) => {
        activeSessions += delta;
      },
      onSessionSummary: (summary) => sessionLog.record(summary),
      ...(options.notReady === undefined ? {} : { notReady: options.notReady }),
      ...(options.metricsIntervalMs === undefined ? {} : { metricsIntervalMs: options.metricsIntervalMs }),
      ...(options.logTranscripts === undefined ? {} : { logTranscripts: options.logTranscripts }),
    });
    req.log.info({ openConnections }, 'websocket connected');

    // Idle timeout: a client that sends neither audio nor pings is gone.
    const idleMs = options.idleTimeoutMs ?? 30_000;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const armIdle = () => {
      if (idleMs <= 0) return;
      if (idleTimer !== null) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        req.log.warn({ idleMs }, 'closing idle websocket');
        socket.close(1001, 'idle timeout');
      }, idleMs);
    };
    armIdle();

    // Audio rate guard (sliding one-second window).
    let windowStart = Date.now();
    let framesInWindow = 0;
    let droppedForRate = 0;

    socket.on('message', (data: unknown, isBinary: boolean) => {
      armIdle();
      const buf = Array.isArray(data) ? Buffer.concat(data as Buffer[]) : data;
      if (isBinary) {
        const now = Date.now();
        if (now - windowStart >= 1000) {
          windowStart = now;
          framesInWindow = 0;
        }
        framesInWindow += 1;
        if (framesInWindow > MAX_AUDIO_FRAMES_PER_SEC) {
          droppedForRate += 1;
          if (droppedForRate === 1) req.log.warn({ maxPerSec: MAX_AUDIO_FRAMES_PER_SEC }, 'audio frame rate exceeded; dropping frames');
          return;
        }
        handler.handleAudio(buf);
      } else {
        handler.handleFrame(buf);
      }
    });
    socket.on('close', () => {
      openConnections -= 1;
      if (idleTimer !== null) clearTimeout(idleTimer);
      void handler.dispose('socket closed');
      req.log.info({ openConnections, droppedForRate }, 'websocket closed');
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

/**
 * Every engine the client may select. The default (TRANSLATION_PROVIDER) is
 * prepared at startup; the others load lazily on first use.
 */
export function createTranslationRegistry(config: ServerConfig, log: BootLog, models?: ModelManager): TranslationRegistry {
  const registry = new TranslationRegistry(config.translationProvider)
    .register('hy-mt2', () =>
      createHyMt2Factory({ modelsDir: config.modelsDir, threads: config.translationThreads, log, ...(models === undefined ? {} : { ensureModel: () => models.ensure('translation') }) }),
    )
    .register('gemini', () =>
      createOpenAiCompatibleFactory({ provider: 'gemini', baseUrl: GEMINI_OPENAI_BASE_URL, apiKey: config.geminiApiKey, model: config.geminiModel, envHint: 'GEMINI_API_KEY (and optionally GEMINI_MODEL)', log, requestsPerMinute: config.geminiRpm }),
    )
    .register('llm', () => createOpenAiCompatibleFactory({ provider: 'llm', baseUrl: config.llmBaseUrl, apiKey: config.llmApiKey, model: config.llmModel, envHint: 'LLM_BASE_URL, LLM_API_KEY, LLM_MODEL', log, requestsPerMinute: config.llmRpm }))
    .register('google', () => createGoogleTranslationFactory({ apiKey: config.googleTranslateApiKey }))
    .register('none', () => createNoneTranslationFactory())
    .register('mock', () => createMockTranslationFactory());
  return registry;
}

/** Which engines have what they need, without revealing any secret. */
export function engineStatus(config: ServerConfig, registry: TranslationRegistry): Record<string, EngineStatus> {
  const s = (configured: boolean, hint?: string): EngineStatus => ({ configured, ready: false, ...(hint === undefined ? {} : { hint }) });
  const status: Record<string, EngineStatus> = {
    'hy-mt2': existsSync(path.join(config.modelsDir, HYMT2_MODEL_FILE)) ? s(true) : s(false, 'run: npm run models:download'),
    gemini: config.geminiApiKey ? s(true) : s(false, 'set GEMINI_API_KEY in packages/server/.env'),
    llm: config.llmBaseUrl && config.llmModel && config.llmApiKey ? s(true) : s(false, 'set LLM_BASE_URL, LLM_MODEL, LLM_API_KEY in packages/server/.env'),
    google: config.googleTranslateApiKey ? s(true) : s(false, 'set GOOGLE_TRANSLATE_API_KEY in packages/server/.env'),
    none: s(true),
    mock: s(true),
  };
  for (const name of registry.readyProviders) if (status[name]) status[name]!.ready = true;
  return status;
}

/** Print which engines are configured, masking secrets (first 4 + last 3 characters). */
export function describeConfiguredEngines(config: ServerConfig): Record<string, string> {
  const mask = (k: string) => (k.length <= 8 ? '****' : `${k.slice(0, 4)}…${k.slice(-3)}`);
  const out: Record<string, string> = { asr: config.asrProvider, translationDefault: config.translationProvider };
  if (config.geminiApiKey) out['gemini'] = `${config.geminiModel} (key ${mask(config.geminiApiKey)}, ${config.geminiRpm || '∞'}/min)`;
  if (config.llmBaseUrl) out['llm'] = `${config.llmModel} @ ${config.llmBaseUrl}${config.llmApiKey ? ` (key ${mask(config.llmApiKey)})` : ' (no key)'}`;
  if (config.googleTranslateApiKey) out['google'] = `key ${mask(config.googleTranslateApiKey)}`;
  return out;
}

export async function startServer(config: ServerConfig): Promise<FastifyInstance> {
  const bootLog: BootLog = { info: (o, m) => console.info(m, o), warn: (o, m) => console.warn(m, o) };
  bootLog.info(describeConfiguredEngines(config), 'configured engines');
  const models = new ModelManager({ modelsDir: config.modelsDir, lock: loadModelLock(), autoDownload: config.autoDownloadModels, log: bootLog });
  const asr = createAsrFactory(config, bootLog);
  const translation = createTranslationRegistry(config, bootLog, models);
  let asrReady = config.asrProvider === 'mock';
  let asrError: string | null = null;
  const notReady = (): string | null => {
    if (asrReady) return null;
    if (asrError !== null) return `语音识别不可用：${asrError}`;
    if (config.asrProvider === 'sensevoice' && !models.isReady('asr')) return models.notReadyMessage('asr');
    return '语音识别模型正在加载，请稍候再开始。';
  };
  const app = await buildApp({
    asr,
    translation,
    metricsIntervalMs: config.metricsIntervalMs,
    engineStatus: () => engineStatus(config, translation),
    idleTimeoutMs: config.idleTimeoutMs,
    logTranscripts: config.logTranscripts,
    logsDir: config.logsDir,
    models,
    notReady,
  });
  app.addHook('onClose', async () => translation.dispose());
  // Listen first so the popup can show "downloading models" instead of "backend not running".
  await app.listen({ host: config.host, port: config.port });
  if (!['127.0.0.1', 'localhost', '::1'].includes(config.host)) {
    app.log.warn({ host: config.host }, 'backend is reachable from the network and has NO authentication — only use HOST=0.0.0.0 on a trusted LAN (see PRIVACY.md)');
  }
  app.log.info({ asrProvider: asr.provider, translationProvider: translation.defaultProvider, translationProviders: translation.providers }, `WebSocket endpoint: ws://${config.host}:${config.port}/ws`);
  void (async () => {
    try {
      if (config.asrProvider === 'sensevoice') await models.ensure('asr');
      await asr.prepare();
      asrReady = true;
      // Default engine warmed up in the background too (hy-mt2 downloads on demand).
      await translation.get().catch((err: unknown) => app.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'default translation engine not ready'));
      app.log.info('backend ready');
    } catch (err) {
      asrError = err instanceof Error ? err.message : String(err);
      app.log.error({ err: asrError }, 'ASR preparation failed');
    }
  })();
  return app;
}
