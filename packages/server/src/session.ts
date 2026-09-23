import type { AsrInfo, SessionMetricsMessage, TranscriptMessage } from '@lst/protocol';
import type { AsrAdapter, AsrMetricsSample } from './asr/types.js';

export interface SessionOptions {
  sessionId: string;
  sourceLanguage: string;
  targetLanguage: string;
  adapter: AsrAdapter;
  send: (message: TranscriptMessage | SessionMetricsMessage) => void;
  onError: (code: 'asr_unavailable' | 'asr_failed', message: string) => void;
  /** Interval for session.metrics messages; 0 disables. */
  metricsIntervalMs?: number;
  now?: () => number;
}

export type SessionState = 'idle' | 'starting' | 'running' | 'stopped';

/**
 * One translation session: owns one ASR adapter, forwards its transcripts
 * as protocol messages and aggregates latency metrics.
 */
export class Session {
  readonly sessionId: string;
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
  private readonly adapter: AsrAdapter;
  private readonly send: SessionOptions['send'];
  private readonly onError: SessionOptions['onError'];
  private readonly metricsIntervalMs: number;
  private readonly now: () => number;
  private metricsTimer: ReturnType<typeof setInterval> | null = null;
  private _state: SessionState = 'idle';
  private audioSamples = 0;
  private partials = 0;
  private finals = 0;
  private window: AsrMetricsSample[] = [];

  constructor(options: SessionOptions) {
    this.sessionId = options.sessionId;
    this.sourceLanguage = options.sourceLanguage;
    this.targetLanguage = options.targetLanguage;
    this.adapter = options.adapter;
    this.send = options.send;
    this.onError = options.onError;
    this.metricsIntervalMs = options.metricsIntervalMs ?? 5000;
    this.now = options.now ?? (() => Date.now());
  }

  get state(): SessionState {
    return this._state;
  }

  get asrInfo(): AsrInfo {
    return { provider: this.adapter.provider, language: this.asrLanguage };
  }
  private asrLanguage = 'auto';

  async start(): Promise<AsrInfo> {
    if (this._state !== 'idle') throw new Error(`cannot start session in state ${this._state}`);
    this._state = 'starting';
    this.adapter.on('transcript', (t) => {
      if (this._state !== 'running') return;
      if (t.status === 'partial') this.partials += 1;
      else this.finals += 1;
      const message: TranscriptMessage = {
        type: 'transcript',
        sessionId: this.sessionId,
        segmentId: t.segmentId,
        revision: t.revision,
        status: t.status,
        startMs: t.startMs,
        sourceText: t.text,
      };
      if (t.endMs !== undefined) message.endMs = t.endMs;
      this.send(message);
    });
    this.adapter.on('metrics', (m) => {
      this.window.push(m);
      if (this.window.length > 50) this.window.shift();
    });
    this.adapter.on('error', (code, message) => {
      if (this._state === 'stopped') return;
      this.onError(code, message);
    });
    try {
      const { language } = await this.adapter.start({ sessionId: this.sessionId, sourceLanguage: this.sourceLanguage });
      this.asrLanguage = language;
    } catch (err) {
      this._state = 'stopped';
      throw err;
    }
    this._state = 'running';
    if (this.metricsIntervalMs > 0) {
      this.metricsTimer = setInterval(() => this.send(this.metrics()), this.metricsIntervalMs);
    }
    return this.asrInfo;
  }

  pushAudio(pcm: Int16Array): void {
    if (this._state !== 'running') return;
    this.audioSamples += pcm.length;
    this.adapter.pushAudio(pcm);
  }

  metrics(): SessionMetricsMessage {
    const avg = (pick: (m: AsrMetricsSample) => number) =>
      this.window.length === 0 ? 0 : Math.round(this.window.reduce((s, m) => s + pick(m), 0) / this.window.length);
    return {
      type: 'session.metrics',
      sessionId: this.sessionId,
      audioSeconds: Math.round((this.audioSamples / 16000) * 10) / 10,
      partials: this.partials,
      finals: this.finals,
      avgDecodeMs: avg((m) => m.decodeMs),
      avgLatencyMs: avg((m) => m.latencyMs),
    };
  }

  /** Idempotent. Flushes the adapter (remaining finals are still forwarded) and releases it. */
  async stop(): Promise<void> {
    if (this._state === 'stopped') return;
    if (this.metricsTimer !== null) {
      clearInterval(this.metricsTimer);
      this.metricsTimer = null;
    }
    const wasRunning = this._state === 'running';
    // Keep forwarding transcripts produced by the flush, then seal the session.
    try {
      if (wasRunning) await this.adapter.stop();
    } finally {
      this._state = 'stopped';
    }
  }
}
