import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { toSenseVoiceLanguage } from './languages.js';
import type { WorkerInbound, WorkerOutbound } from './sherpa-messages.js';
import type { AsrAdapter, AsrAdapterEvents, AsrAdapterFactory, AsrStartOptions } from './types.js';

export interface SherpaConfig {
  modelsDir: string;
  numThreads: number;
  log: { info: (o: Record<string, unknown>, m: string) => void; warn: (o: Record<string, unknown>, m: string) => void };
}

export const SENSEVOICE_MODEL_DIR = 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17';
export const VAD_MODEL_FILE = 'silero_vad.onnx';

const START_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 10_000;

/**
 * Hosts one long-lived worker thread and hands sessions to it. If the
 * worker dies, the active session gets an `asr_failed` error and a fresh
 * worker is spawned for the next session.
 */
export class SherpaWorkerHost {
  private worker: Worker | null = null;
  private listeners = new Set<(m: WorkerOutbound) => void>();
  private loaded: Promise<void> | null = null;

  constructor(private readonly config: SherpaConfig) {}

  static checkModels(modelsDir: string): string | null {
    const model = path.join(modelsDir, SENSEVOICE_MODEL_DIR, 'model.int8.onnx');
    const tokens = path.join(modelsDir, SENSEVOICE_MODEL_DIR, 'tokens.txt');
    const vad = path.join(modelsDir, VAD_MODEL_FILE);
    const missing = [model, tokens, vad].filter((p) => !existsSync(p));
    return missing.length === 0 ? null : `Missing ASR model files:\n  ${missing.join('\n  ')}\nRun: npm run models:download`;
  }

  /** Spawn the worker and load the default recognizer. */
  preload(): Promise<void> {
    if (this.loaded === null) {
      this.loaded = new Promise<void>((resolve, reject) => {
        const worker = this.ensureWorker();
        const timer = setTimeout(() => reject(new Error('ASR worker did not load the model in time')), START_TIMEOUT_MS);
        const off = this.subscribe((m) => {
          if (m.t === 'loaded') {
            clearTimeout(timer);
            off();
            resolve();
          } else if (m.t === 'error' && m.sessionId === undefined) {
            clearTimeout(timer);
            off();
            reject(new Error(m.message));
          }
        });
        worker.postMessage({ t: 'preload' } satisfies WorkerInbound);
      }).catch((err: unknown) => {
        this.loaded = null;
        throw err;
      });
    }
    return this.loaded;
  }

  send(message: WorkerInbound, transfer: ArrayBuffer[] = []): void {
    this.ensureWorker().postMessage(message, transfer);
  }

  subscribe(listener: (m: WorkerOutbound) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private ensureWorker(): Worker {
    if (this.worker !== null) return this.worker;
    const isTs = import.meta.url.endsWith('.ts');
    const workerUrl = new URL(isTs ? './sherpa-worker.ts' : './sherpa-worker.js', import.meta.url);
    // From TypeScript sources (tsx dev / vitest) the worker must be able to
    // load .ts: bootstrap it with a tiny CommonJS script that registers the
    // tsx ESM loader in the worker thread, then imports the real worker.
    // From dist/ it is plain JavaScript.
    const tsxApi = isTs
      ? pathToFileURL(path.join(path.dirname(createRequire(import.meta.url).resolve('tsx/package.json')), 'dist/esm/api/index.mjs')).href
      : null;
    const bootstrap = `import(${JSON.stringify(tsxApi)}).then((m) => { m.register(); return import(${JSON.stringify(workerUrl.href)}); })`;
    const worker = new Worker(isTs ? bootstrap : workerUrl, {
      eval: isTs,
      workerData: {
        modelDir: path.join(this.config.modelsDir, SENSEVOICE_MODEL_DIR),
        vadModel: path.join(this.config.modelsDir, VAD_MODEL_FILE),
        numThreads: this.config.numThreads,
      },
    });
    worker.on('message', (m: WorkerOutbound) => {
      for (const l of this.listeners) l(m);
    });
    const died = (reason: string) => {
      if (this.worker !== worker) return;
      this.config.log.warn({ reason }, 'ASR worker died');
      this.worker = null;
      this.loaded = null;
      for (const l of this.listeners) l({ t: 'error', code: 'asr_failed', message: `ASR worker died: ${reason}` });
    };
    worker.on('error', (err) => died(err.message));
    worker.on('exit', (code) => {
      if (code !== 0) died(`exit code ${code}`);
    });
    this.worker = worker;
    return worker;
  }

  async terminate(): Promise<void> {
    const w = this.worker;
    this.worker = null;
    this.loaded = null;
    if (w) await w.terminate();
  }
}

class SherpaAsrAdapter implements AsrAdapter {
  readonly provider = 'sensevoice';
  private sessionId: string | null = null;
  private unsubscribe: (() => void) | null = null;
  private readonly handlers: { [K in keyof AsrAdapterEvents]: AsrAdapterEvents[K][] } = { transcript: [], metrics: [], error: [] };
  private stopped = false;

  constructor(private readonly host: SherpaWorkerHost) {}

  on<K extends keyof AsrAdapterEvents>(event: K, listener: AsrAdapterEvents[K]): void {
    this.handlers[event].push(listener);
  }

  private emit<K extends keyof AsrAdapterEvents>(event: K, ...args: Parameters<AsrAdapterEvents[K]>): void {
    for (const h of this.handlers[event]) (h as (...a: Parameters<AsrAdapterEvents[K]>) => void)(...args);
  }

  start(options: AsrStartOptions): Promise<{ language: string }> {
    const language = toSenseVoiceLanguage(options.sourceLanguage);
    this.sessionId = options.sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.unsubscribe?.();
        reject(new Error('ASR worker did not start the session in time'));
      }, START_TIMEOUT_MS);
      let started = false;
      this.unsubscribe = this.host.subscribe((m) => {
        if ('sessionId' in m && m.sessionId !== undefined && m.sessionId !== this.sessionId) return;
        switch (m.t) {
          case 'started':
            started = true;
            clearTimeout(timer);
            resolve({ language: m.language });
            return;
          case 'transcript':
            this.emit('transcript', m.transcript);
            return;
          case 'metrics':
            this.emit('metrics', m.sample);
            return;
          case 'error':
            clearTimeout(timer);
            if (!started) reject(new Error(m.message));
            else this.emit('error', m.code, m.message);
            return;
          default:
            return;
        }
      });
      this.host.send({ t: 'start', sessionId: options.sessionId, language });
    });
  }

  pushAudio(pcm: Int16Array): void {
    if (this.sessionId === null || this.stopped) return;
    // Copy into a fresh buffer so it can be transferred without touching the socket's buffer pool.
    const copy = new Int16Array(pcm);
    this.host.send({ t: 'audio', sessionId: this.sessionId, pcm: copy.buffer, sentAt: Date.now() }, [copy.buffer]);
  }

  async stop(): Promise<void> {
    if (this.stopped || this.sessionId === null) return;
    this.stopped = true;
    const sessionId = this.sessionId;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, STOP_TIMEOUT_MS);
      const off = this.host.subscribe((m) => {
        if ((m.t === 'stopped' && m.sessionId === sessionId) || (m.t === 'error' && m.sessionId === undefined)) {
          clearTimeout(timer);
          off();
          resolve();
        }
      });
      this.host.send({ t: 'stop', sessionId });
    });
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}

export function createSherpaFactory(config: SherpaConfig): AsrAdapterFactory {
  const host = new SherpaWorkerHost(config);
  return {
    provider: 'sensevoice',
    async prepare() {
      const missing = SherpaWorkerHost.checkModels(config.modelsDir);
      if (missing !== null) throw new Error(missing);
      const t0 = Date.now();
      await host.preload();
      config.log.info({ ms: Date.now() - t0, modelsDir: config.modelsDir }, 'SenseVoice model loaded');
    },
    create: () => new SherpaAsrAdapter(host),
  };
}
